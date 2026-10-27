from abc import ABC, abstractmethod
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from misty_core.edit import EditContext
from misty_core.errors import CommandRejected, ReplayError
from misty_core.task import Task, TaskState
from misty_core.view import StateView


class Command(BaseModel):
    """Input to an edit type: the arguments of one MCP tool call or UI gesture."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class TaskCommand(Command):
    task_id: str = Field(description="ID of the task to edit.")
    expected_version: int | None = Field(
        default=None,
        description="If given, the edit is rejected unless the task is still at this version. "
        "Use it to avoid overwriting a change made since you last read the task.",
    )


class Payload(BaseModel):
    """The resolved facts an edit records. Must be enough to apply without any other input."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class TaskPayload(Payload):
    task_id: str


# Compensating commands that undo an edit, as (tool_name, command) pairs.
Inverse = list[tuple[str, Command]]


class EditType[C: Command, P: Payload](ABC):
    """One kind of edit. The subclass docstring becomes the MCP tool description.

    `decide` turns a command into a payload, or rejects it. `apply` turns a payload
    into changed tasks; it must be pure (no clock, no randomness, no IO) and must
    never fail for a payload that `decide` produced.
    """

    type: str  # recorded in the log, e.g. "task.created"
    version: int = 1  # bump when the payload shape changes, and add an upcaster
    tool_name: str  # exposed to agents and UIs, e.g. "create_task"
    command_model: type[C]
    payload_model: type[P]

    @abstractmethod
    def decide(self, cmd: C, view: StateView, ctx: EditContext) -> P: ...

    @abstractmethod
    def apply(self, payload: P, view: StateView, at: datetime) -> dict[str, Task]: ...

    def invert(self, payload: P, view: StateView) -> Inverse:
        raise CommandRejected(f"{self.type} edits can't be undone")

    def parse(self, payload: Mapping[str, JsonValue]) -> P:
        return self.payload_model.model_validate(payload)

    def primary_task(self, payload: P) -> str | None:
        return getattr(payload, "task_id", None)

    def targets(self, payload: P) -> tuple[str, ...]:
        task_id = self.primary_task(payload)
        return (task_id,) if task_id else ()

    def reverts_seq(self, payload: P) -> int | None:
        return None

    @property
    def description(self) -> str:
        return " ".join((self.__doc__ or "").split())


def decide_command(
    et: EditType[Any, Any], cmd: Command, view: StateView, ctx: EditContext
) -> Payload:
    """Run the checks shared by all task commands, then the edit type's own `decide`."""
    if isinstance(cmd, TaskCommand):
        task = require(view, cmd.task_id)
        if cmd.expected_version is not None and task.version != cmd.expected_version:
            raise CommandRejected(
                f"Task {cmd.task_id!r} is at version {task.version}, not {cmd.expected_version}: "
                "it changed since you last read it. Re-read it and try again."
            )
    return et.decide(cmd, view, ctx)


def require(view: StateView, task_id: str) -> Task:
    """Fetch a task for `decide`; a missing task is the caller's mistake."""
    task = view.get(task_id)
    if task is None:
        raise CommandRejected(f"No task with id {task_id!r}")
    return task


def require_live_parent(view: StateView, parent_id: str) -> Task:
    parent = view.get(parent_id)
    if parent is None:
        raise CommandRejected(f"No parent task with id {parent_id!r}")
    if parent.state is TaskState.DISCARDED:
        raise CommandRejected(f"Parent task {parent_id!r} is discarded")
    return parent


def existing(view: StateView, task_id: str) -> Task:
    """Fetch a task for `apply`; a missing task means the log is inconsistent."""
    task = view.get(task_id)
    if task is None:
        raise ReplayError(f"Edit refers to unknown task {task_id!r}")
    return task


def touched(task: Task, at: datetime, **updates: Any) -> Task:
    return task.model_copy(update={**updates, "updated_at": at, "version": task.version + 1})


def conflict(task_id: str, what: str) -> CommandRejected:
    return CommandRejected(
        f"Can't undo cleanly: the {what} of task {task_id!r} has changed since that edit."
    )
