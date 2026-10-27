from datetime import datetime

from pydantic import Field

from misty_core.edit import EditContext
from misty_core.edits.base import (
    EditType,
    Inverse,
    TaskCommand,
    TaskPayload,
    conflict,
    existing,
    require,
    require_live_parent,
    touched,
)
from misty_core.errors import CommandRejected
from misty_core.task import Task
from misty_core.view import StateView, ancestors


class MoveTask(TaskCommand):
    parent_id: str | None = Field(description="New parent task, or null to make it top-level.")


class TaskReparentedPayload(TaskPayload):
    before: str | None
    after: str | None


class TaskReparented(EditType[MoveTask, TaskReparentedPayload]):
    """Move a task under a different parent, or to the top level."""

    type = "task.reparented"
    tool_name = "move_task"
    command_model = MoveTask
    payload_model = TaskReparentedPayload

    def decide(self, cmd: MoveTask, view: StateView, ctx: EditContext) -> TaskReparentedPayload:
        task = require(view, cmd.task_id)
        if task.parent_id == cmd.parent_id:
            raise CommandRejected(f"Task {cmd.task_id!r} already has that parent")
        if cmd.parent_id is not None:
            require_live_parent(view, cmd.parent_id)
            if cmd.parent_id == task.id or task.id in ancestors(view, cmd.parent_id):
                raise CommandRejected("A task can't be moved under itself or its own subtasks")
        return TaskReparentedPayload(task_id=task.id, before=task.parent_id, after=cmd.parent_id)

    def apply(
        self, payload: TaskReparentedPayload, view: StateView, at: datetime
    ) -> dict[str, Task]:
        task = existing(view, payload.task_id)
        return {task.id: touched(task, at, parent_id=payload.after)}

    def invert(self, payload: TaskReparentedPayload, view: StateView) -> Inverse:
        if require(view, payload.task_id).parent_id != payload.after:
            raise conflict(payload.task_id, "parent")
        return [("move_task", MoveTask(task_id=payload.task_id, parent_id=payload.before))]
