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
    touched,
)
from misty_core.errors import CommandRejected
from misty_core.task import Task
from misty_core.view import StateView


class RetitleTask(TaskCommand):
    title: str = Field(min_length=1, description="The new title.")


class TaskRetitledPayload(TaskPayload):
    before: str
    after: str


class TaskRetitled(EditType[RetitleTask, TaskRetitledPayload]):
    """Rename a task, for example to make it more concrete or less daunting."""

    type = "task.retitled"
    tool_name = "retitle_task"
    command_model = RetitleTask
    payload_model = TaskRetitledPayload

    def decide(self, cmd: RetitleTask, view: StateView, ctx: EditContext) -> TaskRetitledPayload:
        task = require(view, cmd.task_id)
        if task.title == cmd.title:
            raise CommandRejected(f"Task {cmd.task_id!r} already has that title")
        return TaskRetitledPayload(task_id=cmd.task_id, before=task.title, after=cmd.title)

    def apply(self, payload: TaskRetitledPayload, view: StateView, at: datetime) -> dict[str, Task]:
        task = existing(view, payload.task_id)
        return {task.id: touched(task, at, title=payload.after)}

    def invert(self, payload: TaskRetitledPayload, view: StateView) -> Inverse:
        if require(view, payload.task_id).title != payload.after:
            raise conflict(payload.task_id, "title")
        return [("retitle_task", RetitleTask(task_id=payload.task_id, title=payload.before))]
