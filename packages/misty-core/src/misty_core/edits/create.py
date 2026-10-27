from datetime import datetime

from pydantic import Field, JsonValue

from misty_core.attributes import validate_attrs
from misty_core.edit import EditContext
from misty_core.edits.base import (
    Command,
    EditType,
    Inverse,
    TaskCommand,
    TaskPayload,
    require_live_parent,
)
from misty_core.task import Task
from misty_core.view import StateView


class CreateTask(Command):
    title: str = Field(min_length=1, description="Short, concrete name for the task.")
    parent_id: str | None = Field(
        default=None, description="Optional parent task, for breaking a bigger task down."
    )
    attrs: dict[str, JsonValue] = Field(
        default_factory=dict, description="Optional initial attributes."
    )


class TaskCreatedPayload(TaskPayload):
    title: str
    parent_id: str | None
    attrs: dict[str, JsonValue]


class TaskCreated(EditType[CreateTask, TaskCreatedPayload]):
    """Capture a new task. Only a title is needed; everything else can be added later."""

    type = "task.created"
    tool_name = "create_task"
    command_model = CreateTask
    payload_model = TaskCreatedPayload

    def decide(self, cmd: CreateTask, view: StateView, ctx: EditContext) -> TaskCreatedPayload:
        if cmd.parent_id is not None:
            require_live_parent(view, cmd.parent_id)
        return TaskCreatedPayload(
            task_id=ctx.new_id(),
            title=cmd.title,
            parent_id=cmd.parent_id,
            attrs=validate_attrs(cmd.attrs),
        )

    def apply(self, payload: TaskCreatedPayload, view: StateView, at: datetime) -> dict[str, Task]:
        task = Task(
            id=payload.task_id,
            parent_id=payload.parent_id,
            title=payload.title,
            attrs=dict(payload.attrs),
            created_at=at,
            updated_at=at,
        )
        return {task.id: task}

    def invert(self, payload: TaskCreatedPayload, view: StateView) -> Inverse:
        return [("discard_task", TaskCommand(task_id=payload.task_id))]
