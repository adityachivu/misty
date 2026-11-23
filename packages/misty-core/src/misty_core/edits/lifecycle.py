from datetime import datetime

from misty_core.edit import EditContext
from misty_core.edits.base import (
    EditType,
    Inverse,
    TaskCommand,
    TaskPayload,
    conflict,
    existing,
    require,
    touched,
)
from misty_core.errors import CommandRejected
from misty_core.task import Task, TaskState
from misty_core.view import StateView


class StateChangedPayload(TaskPayload):
    before: TaskState


class _Transition(EditType[TaskCommand, StateChangedPayload]):
    """Base for lifecycle edits. Any state can move to any other: this is not a workflow."""

    target: TaskState
    command_model = TaskCommand
    payload_model = StateChangedPayload

    def decide(self, cmd: TaskCommand, view: StateView, ctx: EditContext) -> StateChangedPayload:
        task = require(view, cmd.task_id)
        if task.state is self.target:
            raise CommandRejected(f"Task {cmd.task_id!r} is already {self.target}")
        return StateChangedPayload(task_id=cmd.task_id, before=task.state)

    def apply(self, payload: StateChangedPayload, view: StateView, at: datetime) -> dict[str, Task]:
        task = existing(view, payload.task_id)
        return {task.id: touched(task, at, state=self.target)}

    def invert(self, payload: StateChangedPayload, view: StateView) -> Inverse:
        if require(view, payload.task_id).state is not self.target:
            raise conflict(payload.task_id, "state")
        return [(ENTER_TOOL[payload.before], TaskCommand(task_id=payload.task_id))]


class TaskCompleted(_Transition):
    """Mark a task as done. Its subtasks are left as they are."""

    type = "task.completed"
    tool_name = "complete_task"
    target = TaskState.DONE


class TaskReleased(_Transition):
    """Let a task go on purpose. Releasing is a legitimate outcome, not a failure: the
    task leaves the active views but stays in history and can be reopened. Its subtasks
    are left as they are."""

    type = "task.released"
    tool_name = "release_task"
    target = TaskState.RELEASED


class TaskReopened(_Transition):
    """Bring a done, released, or discarded task back to open."""

    type = "task.reopened"
    tool_name = "reopen_task"
    target = TaskState.OPEN


class TaskDiscarded(_Transition):
    """Discard a task that was captured by mistake or is a duplicate. It is hidden from
    views but stays in history, and the discard can be undone. Refused while the task
    has subtasks that aren't discarded: move them elsewhere or discard them first."""

    type = "task.discarded"
    tool_name = "discard_task"
    target = TaskState.DISCARDED

    def decide(self, cmd: TaskCommand, view: StateView, ctx: EditContext) -> StateChangedPayload:
        payload = super().decide(cmd, view, ctx)
        # Nothing may be attached to a discarded task (require_live_parent), so nothing
        # live may be left under one either: it would vanish from every view.
        kept = [c for c in view.children(cmd.task_id) if c.state is not TaskState.DISCARDED]
        if kept:
            raise CommandRejected(
                f"Task {cmd.task_id!r} has {len(kept)} subtask(s) that aren't discarded. "
                "Move them elsewhere or discard them first."
            )
        return payload


ENTER_TOOL: dict[TaskState, str] = {
    t.target: t.tool_name for t in (TaskCompleted, TaskReleased, TaskReopened, TaskDiscarded)
}
