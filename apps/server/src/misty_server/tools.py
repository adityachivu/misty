"""The tools agents see: one per edit type, a batch of edits, and three reads.

This module knows nothing about MCP. `misty_server.mcp_server` serves `TOOLS` over stdio
and HTTP; anything else that wants the same surface calls `call`.

The write tools are generated from `misty_core.edits.EDIT_TYPES`, so a new edit type
becomes a tool with no change here. Every write also takes a `reason` (required from
agents) and an optional `correlation_id`, which are recorded beside the edit, not in it.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from misty_core import Actor, CommandRejected, Edit, Task, TaskState, attributes
from misty_core.edits import EDIT_TYPES
from misty_core.edits.base import EditType
from misty_store import TaskService
from misty_store.service import MAX_BATCH

type Run = Callable[[TaskService, dict[str, Any], Actor], dict[str, Any]]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    run: Run
    read_only: bool = False


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ─── the envelope every write carries ────────────────────────────────────────────────

ENVELOPE: dict[str, dict[str, Any]] = {
    "reason": {
        "type": "string",
        "minLength": 1,
        "description": "Why you are making this edit, in a few words. It is recorded with "
        "the edit and shown to the user in the task's history. If the task came out of "
        "another one (split, merged, a follow-up), say which.",
    },
    "correlation_id": {
        "type": "string",
        "description": "Optional. Give every edit you make in one turn the same value, so "
        "they can be found, and undone, together.",
    },
}


def _envelope(args: dict[str, Any]) -> tuple[str, str | None]:
    """Take `reason` and `correlation_id` out of a write's arguments."""
    reason = args.pop("reason", None)
    if not isinstance(reason, str) or not reason.strip():
        raise CommandRejected(
            "`reason` is required: say in a few words why you are making this edit. "
            "It is shown to the user in the task's history."
        )
    correlation_id = args.pop("correlation_id", None)
    if correlation_id is not None and (
        not isinstance(correlation_id, str) or not correlation_id.strip()
    ):
        raise CommandRejected("`correlation_id` must be a non-empty string, or left out")
    return reason.strip(), correlation_id.strip() if correlation_id else None


# ─── what tools return ───────────────────────────────────────────────────────────────


def _present(task: Task, open_children: Mapping[str, int]) -> dict[str, Any]:
    """A task as agents see it. `open_children` says what closing it would leave behind."""
    return {**task.model_dump(mode="json"), "open_children": open_children.get(task.id, 0)}


def _present_edit(edit: Edit) -> dict[str, Any]:
    return edit.model_dump(mode="json", exclude={"edit_id", "type_version"})


def _written(service: TaskService, edits: list[Edit]) -> list[dict[str, Any]]:
    """Each edit's seq and the task it changed, as that task is now."""
    counts = service.open_child_counts()
    results: list[dict[str, Any]] = []
    for edit in edits:
        task = service.get_task(edit.task_id) if edit.task_id else None
        results.append({"seq": edit.seq, "task": _present(task, counts) if task else None})
    return results


# ─── writes: one tool per edit type ──────────────────────────────────────────────────


def _write_tool(et: EditType[Any, Any]) -> Tool:
    schema = _schema(et.command_model)
    clash = schema["properties"].keys() & ENVELOPE.keys()
    if clash:
        raise RuntimeError(f"{et.tool_name} has arguments named like the envelope: {clash}")
    schema["properties"] |= ENVELOPE
    schema["required"] = [*schema.get("required", []), "reason"]

    def run(service: TaskService, args: dict[str, Any], actor: Actor) -> dict[str, Any]:
        reason, correlation_id = _envelope(args)
        edit = service.execute(
            et.tool_name, args, actor=actor, reason=reason, correlation_id=correlation_id
        )
        return _written(service, [edit])[0]

    return Tool(et.tool_name, et.description, schema, run)


WRITE_TOOLS: tuple[str, ...] = tuple(et.tool_name for et in EDIT_TYPES)


# ─── apply_edits: several writes, all or nothing ─────────────────────────────────────


class EditItem(_Args):
    tool: str = Field(description="Which edit to make.")
    args: dict[str, JsonValue] = Field(
        default_factory=dict,
        description="That edit's own arguments, without `reason` or `correlation_id`.",
    )


class ApplyEdits(_Args):
    edits: list[EditItem] = Field(
        min_length=1, max_length=MAX_BATCH, description="The edits, in the order to make them."
    )


APPLY_EDITS = (
    "Make several edits as one change: all of them are recorded, or none. Use it to "
    "restructure tasks (break one down, group several under a new parent, split, merge, "
    "dissolve a parent), so that a rejection can't leave the tree half-rearranged. Edits "
    'run in order. In a `task_id` or `parent_id`, "$0" means the task created by the '
    'first edit in this batch, "$1" the second, and so on. To undo a whole batch, list '
    "its edits by `correlation_id` and apply an `undo_edit` for each, newest first."
)


def _apply_edits(service: TaskService, args: dict[str, Any], actor: Actor) -> dict[str, Any]:
    reason, correlation_id = _envelope(args)
    batch = _parse(ApplyEdits, "apply_edits", args)
    commands: list[tuple[str, Mapping[str, Any]]] = []
    for index, item in enumerate(batch.edits):
        if item.tool not in WRITE_TOOLS:
            raise CommandRejected(
                f"edits[{index}]: {item.tool!r} is not an edit. Edits: {', '.join(WRITE_TOOLS)}"
            )
        if item.args.keys() & ENVELOPE.keys():
            raise CommandRejected(
                f"edits[{index}]: give `reason` and `correlation_id` once, for the whole "
                "batch, not inside an edit's args"
            )
        commands.append((item.tool, item.args))
    edits = service.execute_many(
        commands, actor=actor, reason=reason, correlation_id=correlation_id
    )
    return {"correlation_id": edits[0].correlation_id, "results": _written(service, edits)}


def _apply_edits_tool() -> Tool:
    schema = _schema(ApplyEdits)
    schema["properties"]["edits"]["items"]["properties"]["tool"]["enum"] = list(WRITE_TOOLS)
    schema["properties"] |= ENVELOPE
    schema["required"] = [*schema["required"], "reason"]
    return Tool("apply_edits", APPLY_EDITS, schema, _apply_edits)


# ─── reads ───────────────────────────────────────────────────────────────────────────


class ListTasks(_Args):
    states: list[TaskState] = Field(
        default=[TaskState.OPEN],
        min_length=1,
        description="Which states to include. Released tasks were let go on purpose; "
        "discarded ones were captured by mistake.",
    )
    parent_id: str | None = Field(
        default=None, description="Only the direct subtasks of this task."
    )
    attrs: dict[str, JsonValue] = Field(
        default_factory=dict, description="Only tasks that have all of these attribute values."
    )
    query: str | None = Field(
        default=None,
        description="Only tasks whose title or notes contain this text. Case is ignored.",
    )
    limit: int = Field(default=100, ge=1, le=500, description="The most tasks to return.")


def _list_tasks(service: TaskService, args: dict[str, Any], actor: Actor) -> dict[str, Any]:
    wanted = _parse(ListTasks, "list_tasks", args)
    if wanted.parent_id is not None:
        _require(service, wanted.parent_id)
    tasks = service.list_tasks(
        wanted.states,
        parent_id=wanted.parent_id,
        attrs=attributes.validate_attrs(wanted.attrs),
        query=wanted.query,
    )
    counts = service.open_child_counts()
    return {
        "head_seq": service.head_seq(),
        "total": len(tasks),
        "truncated": len(tasks) > wanted.limit,
        "tasks": [_present(task, counts) for task in tasks[: wanted.limit]],
    }


class GetTask(_Args):
    task_id: str = Field(description="ID of the task to read.")


def _get_task(service: TaskService, args: dict[str, Any], actor: Actor) -> dict[str, Any]:
    task = _require(service, _parse(GetTask, "get_task", args).task_id)
    counts = service.open_child_counts()
    return {
        "task": _present(task, counts),
        "ancestors": [
            {"id": above.id, "title": above.title, "state": above.state}
            for above in service.ancestors(task.id)
        ],
        "children": [
            _present(child, counts)
            for child in service.children(task.id)
            if child.state is not TaskState.DISCARDED
        ],
    }


class ListEdits(_Args):
    task_id: str | None = Field(default=None, description="Only edits that touched this task.")
    correlation_id: str | None = Field(
        default=None,
        description="Only edits recorded with this correlation id: one turn, or one batch.",
    )
    after_seq: int | None = Field(
        default=None,
        ge=0,
        description="Read forwards from just after this seq. Left out, you get the most "
        "recent edits.",
    )
    limit: int = Field(default=50, ge=1, le=200, description="The most edits to return.")


def _list_edits(service: TaskService, args: dict[str, Any], actor: Actor) -> dict[str, Any]:
    wanted = _parse(ListEdits, "list_edits", args)
    if wanted.task_id is not None:
        _require(service, wanted.task_id)
    edits = service.find_edits(
        task_id=wanted.task_id,
        correlation_id=wanted.correlation_id,
        after_seq=wanted.after_seq,
        limit=wanted.limit + 1,  # one extra, to know whether there are more
    )
    truncated = len(edits) > wanted.limit
    if truncated:
        edits = edits[: wanted.limit] if wanted.after_seq is not None else edits[1:]
    return {
        "head_seq": service.head_seq(),
        "truncated": truncated,
        "edits": [_present_edit(edit) for edit in edits],
    }


def _read_tools() -> list[Tool]:
    return [
        Tool(
            "list_tasks",
            "List tasks, oldest first: open ones unless `states` says otherwise. Every "
            "task carries `open_children`, the number of open subtasks under it.",
            _schema(ListTasks),
            _list_tasks,
            read_only=True,
        ),
        Tool(
            "get_task",
            "Read one task, with the tasks above it (top level first) and its direct subtasks.",
            _schema(GetTask),
            _get_task,
            read_only=True,
        ),
        Tool(
            "list_edits",
            "Read the edit history, oldest first: what changed, who changed it, and why. "
            "Each edit has the `seq` that `undo_edit` takes, and its payload holds the "
            "values before and after.",
            _schema(ListEdits),
            _list_edits,
            read_only=True,
        ),
    ]


# ─── the registry ────────────────────────────────────────────────────────────────────


def _build() -> dict[str, Tool]:
    tools = [*map(_write_tool, EDIT_TYPES), _apply_edits_tool(), *_read_tools()]
    return {tool.name: tool for tool in tools}


def call(
    service: TaskService, name: str, arguments: Mapping[str, Any] | None, actor: Actor
) -> dict[str, Any]:
    """Run a tool. Raises CommandRejected, with a message for the caller, on any refusal."""
    tool = TOOLS.get(name)
    if tool is None:
        raise CommandRejected(f"Unknown tool {name!r}. Available: {', '.join(TOOLS)}")
    return tool.run(service, dict(arguments or {}), actor)


def _require(service: TaskService, task_id: str) -> Task:
    task = service.get_task(task_id)
    if task is None:
        raise CommandRejected(f"No task with id {task_id!r}")
    return task


def _parse[M: BaseModel](model: type[M], tool: str, args: Mapping[str, Any]) -> M:
    try:
        return model.model_validate(args)
    except ValidationError as e:
        problems = "; ".join(
            f"{'.'.join(map(str, err['loc'])) or 'input'}: {err['msg']}" for err in e.errors()
        )
        raise CommandRejected(f"Invalid arguments for {tool}: {problems}") from e


def _schema(model: type[BaseModel]) -> dict[str, Any]:
    """A model's JSON Schema, made plain for a tool listing.

    References are inlined and titles dropped. An optional argument is shown as its own
    type, not as "that or null". `attrs` is described by the attribute registry.
    """
    raw = model.model_json_schema()
    defs: dict[str, Any] = raw.pop("$defs", {})

    def tidy(node: Any) -> Any:
        if isinstance(node, list):
            return [tidy(item) for item in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            target = defs[node["$ref"].rsplit("/", 1)[-1]]
            node = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
        tidied: dict[str, Any] = {}
        for key, value in node.items():
            if key == "title" and isinstance(value, str):
                continue
            if key == "properties":  # its keys are argument names, not schema keywords
                tidied[key] = {name: _argument(name, tidy(sub)) for name, sub in value.items()}
            else:
                tidied[key] = tidy(value)
        return tidied

    return tidy(raw)


def _argument(name: str, schema: dict[str, Any]) -> dict[str, Any]:
    if name == "attrs":
        kept = {k: schema[k] for k in ("description", "minProperties") if k in schema}
        return {**attributes.json_schema(), **kept}
    match schema:
        case {"anyOf": [inner, {"type": "null"}], "default": None, **rest}:
            return {**inner, **rest}
    return schema


TOOLS: dict[str, Tool] = _build()
