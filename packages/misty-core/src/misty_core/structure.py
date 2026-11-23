"""Intended task structures, and the deterministic stand-in translator for drafts.

A client that reorganises tasks (see ADR 0003) describes the structure it wants as a
`Structure`: each affected task's parent, any new tasks (ids `new:<label>`), and the
tasks it removes. `plan` turns that into ordered commands; `check` confirms that a tree
matches it. Both are pure.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from misty_core.attributes import same_value
from misty_core.errors import CommandRejected
from misty_core.task import Task, TaskState

NEW = "new:"
_POSITION = re.compile(r"\$\d+")


class StructureNode(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(description="An existing task id, or `new:<label>` for a task to create.")
    parent: str | None = Field(description="Intended parent: a task id, `new:<label>`, or null.")
    title: str | None = Field(default=None, description="Required for new tasks.")
    attrs: dict[str, JsonValue] = Field(
        default_factory=dict, description="Attributes the task should have (a subset)."
    )


class Structure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    nodes: list[StructureNode] = Field(default_factory=list)
    removed: list[str] = Field(
        default_factory=list, description="Existing tasks to discard; they must end up empty."
    )


@dataclass(frozen=True)
class Step:
    """One command in a batch. Later steps can use the task it creates in their
    `task_id`/`parent_id`, as "$n" (this step's position) or as the name `as_` gives it,
    by convention `new:<label>`."""

    tool: str
    args: dict[str, Any]
    as_: str | None = None

    def dump(self) -> dict[str, Any]:
        return {"tool": self.tool, "args": self.args, **({"as": self.as_} if self.as_ else {})}


def is_new(ref: str | None) -> bool:
    return ref is not None and ref.startswith(NEW)


def is_placeholder(ref: str) -> bool:
    """Whether `ref` stands for a task a batch creates: `new:<label>` or "$n"."""
    return ref.startswith(NEW) or _POSITION.fullmatch(ref) is not None


def resolve_refs(args: Mapping[str, Any], created: Mapping[str, str]) -> dict[str, Any]:
    """Replace a placeholder in `task_id`/`parent_id` with the id it was created as."""
    out = dict(args)
    for key in ("task_id", "parent_id"):
        ref = out.get(key)
        if isinstance(ref, str) and is_placeholder(ref):
            if ref not in created:
                raise CommandRejected(
                    f"{key} {ref!r} doesn't refer to a task created earlier in this batch"
                )
            out[key] = created[ref]
    return out


@dataclass
class _Sim:
    """Parents as they will be partway through the plan."""

    tasks: Mapping[str, Task]
    parent: dict[str, str | None] = field(default_factory=dict)

    def parent_of(self, task_id: str) -> str | None:
        if task_id in self.parent:
            return self.parent[task_id]
        task = self.tasks.get(task_id)
        return task.parent_id if task else None

    def is_ancestor(self, maybe: str, of: str | None) -> bool:
        seen: set[str] = set()
        while of is not None and of not in seen:
            if of == maybe:
                return True
            seen.add(of)
            of = self.parent_of(of)
        return False


def plan(structure: Structure, tasks: Mapping[str, Task]) -> list[Step]:
    """The commands that turn `tasks` into `structure`: creates, then moves, then
    attribute changes, then discards. Raises CommandRejected if it can't be done."""
    nodes = {n.id: n for n in structure.nodes}
    if len(nodes) != len(structure.nodes):
        raise CommandRejected("A task appears more than once in the structure")
    for n in structure.nodes:
        if is_new(n.id):
            if not n.title:
                raise CommandRejected(f"New task {n.id!r} needs a title")
        else:
            _require_live(tasks, n.id)
        if is_new(n.parent):
            if n.parent not in nodes:
                raise CommandRejected(f"Parent {n.parent!r} of {n.id!r} isn't in the structure")
        elif n.parent is not None:
            _require_live(tasks, n.parent)
            if n.parent in structure.removed:
                raise CommandRejected(f"{n.id!r} can't go under {n.parent!r}, which is removed")

    steps: list[Step] = []
    sim = _Sim(tasks)

    # Creates, parents first. A new task starts under its final parent if that already
    # exists or was just created.
    pending = [n for n in structure.nodes if is_new(n.id)]
    while pending:
        ready = [n for n in pending if not is_new(n.parent) or n.parent in sim.parent]
        if not ready:
            raise CommandRejected("New tasks are nested in a cycle")
        for n in ready:
            args: dict[str, Any] = {"title": n.title, "parent_id": n.parent}
            if n.attrs:
                args["attrs"] = dict(n.attrs)
            steps.append(Step("create_task", args, as_=n.id))
            sim.parent[n.id] = n.parent
        pending = [n for n in pending if n not in ready]

    # Moves, in an order that never puts a task under its own descendant.
    moves = [n for n in structure.nodes if not is_new(n.id) and tasks[n.id].parent_id != n.parent]
    while moves:
        ready = [n for n in moves if not sim.is_ancestor(n.id, n.parent)]
        if not ready:
            raise CommandRejected("The structure would put a task inside itself")
        n = ready[0]
        steps.append(Step("move_task", {"task_id": n.id, "parent_id": n.parent}))
        sim.parent[n.id] = n.parent
        moves.remove(n)

    for n in structure.nodes:
        if is_new(n.id):
            continue
        have = tasks[n.id].attrs
        changed = {k: v for k, v in n.attrs.items() if k not in have or not same_value(have[k], v)}
        if changed:
            steps.append(Step("set_attributes", {"task_id": n.id, "attrs": changed}))

    for task_id in structure.removed:
        task = _require(tasks, task_id)
        if task_id in nodes:
            raise CommandRejected(f"{task_id!r} is both kept and removed")
        if task.state is TaskState.DISCARDED:
            continue
        # The same rule discard_task enforces, said in the structure's terms.
        stranded = [
            t.id
            for t in tasks.values()
            if t.state is not TaskState.DISCARDED and sim.parent_of(t.id) == task_id
        ]
        if stranded:
            raise CommandRejected(
                f"Removing {task_id!r} would hide its subtasks {stranded}; move them first"
            )
        steps.append(Step("discard_task", {"task_id": task_id}))
    return steps


def check(structure: Structure, tasks: Mapping[str, Task], created: Mapping[str, str]) -> list[str]:
    """How `tasks` differs from `structure`. Empty means it matches."""

    def ref(r: str | None) -> str | None:
        return created.get(r, r) if r is not None else None

    problems: list[str] = []
    for n in structure.nodes:
        task = tasks.get(ref(n.id) or "")
        if task is None:
            problems.append(f"{n.id}: missing")
            continue
        if task.state is TaskState.DISCARDED:
            problems.append(f"{n.id}: discarded")
        if task.parent_id != ref(n.parent):
            problems.append(f"{n.id}: parent is {task.parent_id}, intended {ref(n.parent)}")
        if is_new(n.id) and task.title != n.title:
            problems.append(f"{n.id}: title is {task.title!r}, intended {n.title!r}")
        for k, v in n.attrs.items():
            if k not in task.attrs or not same_value(task.attrs[k], v):
                problems.append(f"{n.id}: {k} is {task.attrs.get(k)!r}, intended {v!r}")
    for task_id in structure.removed:
        task = tasks.get(task_id)
        if task is not None and task.state is not TaskState.DISCARDED:
            problems.append(f"{task_id}: intended removed, but it is {task.state}")
    return problems


def _require(tasks: Mapping[str, Task], task_id: str) -> Task:
    task = tasks.get(task_id)
    if task is None:
        raise CommandRejected(f"No task with id {task_id!r}")
    return task


def _require_live(tasks: Mapping[str, Task], task_id: str) -> Task:
    task = _require(tasks, task_id)
    if task.state is TaskState.DISCARDED:
        raise CommandRejected(f"Task {task_id!r} is discarded")
    return task
