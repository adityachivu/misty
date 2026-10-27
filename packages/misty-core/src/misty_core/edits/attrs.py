from datetime import datetime

from pydantic import Field, JsonValue

from misty_core.attributes import same_value, validate_attrs
from misty_core.edit import EditContext
from misty_core.edits.base import (
    EditType,
    Inverse,
    Payload,
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


class SetAttributes(TaskCommand):
    attrs: dict[str, JsonValue] = Field(
        min_length=1, description="Attributes to set. Values may not be null."
    )


class AttrChange(Payload):
    before: JsonValue = None  # None means the attribute was absent
    after: JsonValue


class AttrsSetPayload(TaskPayload):
    changes: dict[str, AttrChange]


class AttrsSet(EditType[SetAttributes, AttrsSetPayload]):
    """Set one or more attributes on a task. Other attributes are left unchanged."""

    type = "task.attrs_set"
    tool_name = "set_attributes"
    command_model = SetAttributes
    payload_model = AttrsSetPayload

    def decide(self, cmd: SetAttributes, view: StateView, ctx: EditContext) -> AttrsSetPayload:
        task = require(view, cmd.task_id)
        changes = {
            key: AttrChange(before=task.attrs.get(key), after=value)
            for key, value in validate_attrs(cmd.attrs).items()
            if key not in task.attrs or not same_value(task.attrs[key], value)
        }
        if not changes:
            raise CommandRejected(f"Task {cmd.task_id!r} already has those attribute values")
        return AttrsSetPayload(task_id=cmd.task_id, changes=changes)

    def apply(self, payload: AttrsSetPayload, view: StateView, at: datetime) -> dict[str, Task]:
        task = existing(view, payload.task_id)
        attrs = {**task.attrs, **{key: c.after for key, c in payload.changes.items()}}
        return {task.id: touched(task, at, attrs=attrs)}

    def invert(self, payload: AttrsSetPayload, view: StateView) -> Inverse:
        task = require(view, payload.task_id)
        for key, change in payload.changes.items():
            if key not in task.attrs or not same_value(task.attrs[key], change.after):
                raise conflict(payload.task_id, f"attribute {key!r}")
        restore: dict[str, JsonValue] = {
            k: c.before for k, c in payload.changes.items() if c.before is not None
        }
        remove = [k for k, c in payload.changes.items() if c.before is None]
        inverse: Inverse = []
        if restore:
            inverse.append(("set_attributes", SetAttributes(task_id=task.id, attrs=restore)))
        if remove:
            inverse.append(("unset_attributes", UnsetAttributes(task_id=task.id, keys=remove)))
        return inverse


class UnsetAttributes(TaskCommand):
    keys: list[str] = Field(min_length=1, description="Attribute keys to remove.")


class AttrsUnsetPayload(TaskPayload):
    removed: dict[str, JsonValue]  # key -> the value it had


class AttrsUnset(EditType[UnsetAttributes, AttrsUnsetPayload]):
    """Remove one or more attributes from a task."""

    type = "task.attrs_unset"
    tool_name = "unset_attributes"
    command_model = UnsetAttributes
    payload_model = AttrsUnsetPayload

    def decide(self, cmd: UnsetAttributes, view: StateView, ctx: EditContext) -> AttrsUnsetPayload:
        task = require(view, cmd.task_id)
        removed = {key: task.attrs[key] for key in cmd.keys if key in task.attrs}
        if not removed:
            raise CommandRejected(f"Task {cmd.task_id!r} has none of those attributes")
        return AttrsUnsetPayload(task_id=cmd.task_id, removed=removed)

    def apply(self, payload: AttrsUnsetPayload, view: StateView, at: datetime) -> dict[str, Task]:
        task = existing(view, payload.task_id)
        attrs = {k: v for k, v in task.attrs.items() if k not in payload.removed}
        return {task.id: touched(task, at, attrs=attrs)}

    def invert(self, payload: AttrsUnsetPayload, view: StateView) -> Inverse:
        task = require(view, payload.task_id)
        for key in payload.removed:
            if key in task.attrs:
                raise conflict(payload.task_id, f"attribute {key!r}")
        return [("set_attributes", SetAttributes(task_id=task.id, attrs=dict(payload.removed)))]
