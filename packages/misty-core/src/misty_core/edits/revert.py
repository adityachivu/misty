from datetime import datetime

from pydantic import Field, JsonValue

from misty_core.edit import EditContext
from misty_core.edits.base import Command, EditType, Inverse, Payload, decide_command
from misty_core.errors import CommandRejected
from misty_core.task import Task
from misty_core.view import OverlayView, StateView


class UndoEdit(Command):
    seq: int = Field(description="Sequence number of the edit to undo, from the edit history.")


class RevertedOp(Payload):
    type: str
    type_version: int
    payload: dict[str, JsonValue]


class EditRevertedPayload(Payload):
    reverted_seq: int
    task_id: str | None
    ops: list[RevertedOp]  # fully resolved compensating edits, applied in order


class EditReverted(EditType[UndoEdit, EditRevertedPayload]):
    """Undo an earlier edit by recording its opposite. History is never erased, and an
    undo can itself be undone. Rejected if the task has changed since in a way that
    makes a clean undo impossible."""

    type = "edit.reverted"
    tool_name = "undo_edit"
    command_model = UndoEdit
    payload_model = EditRevertedPayload

    def decide(self, cmd: UndoEdit, view: StateView, ctx: EditContext) -> EditRevertedPayload:
        from misty_core.edits import by_tool, by_type

        target = view.get_edit(cmd.seq)
        if target is None:
            raise CommandRejected(f"No edit with seq {cmd.seq}")
        target_type = by_type(target.type)
        inverse = target_type.invert(target_type.parse(target.payload), view)

        # Resolve each compensating command through the normal decide path, staging
        # its effect so later commands see earlier ones.
        staged = OverlayView(view)
        ops: list[RevertedOp] = []
        for tool_name, command in inverse:
            et = by_tool(tool_name)
            payload = decide_command(et, command, staged, ctx)
            staged.update(et.apply(payload, staged, ctx.occurred_at))
            ops.append(
                RevertedOp(
                    type=et.type, type_version=et.version, payload=payload.model_dump(mode="json")
                )
            )
        return EditRevertedPayload(reverted_seq=cmd.seq, task_id=target.task_id, ops=ops)

    def apply(self, payload: EditRevertedPayload, view: StateView, at: datetime) -> dict[str, Task]:
        from misty_core.edits import by_type

        staged = OverlayView(view)
        for op in payload.ops:
            et = by_type(op.type)
            staged.update(et.apply(et.parse(op.payload), staged, at))
        return staged.changes

    def invert(self, payload: EditRevertedPayload, view: StateView) -> Inverse:
        from misty_core.edits import by_type

        inverse: Inverse = []
        for op in reversed(payload.ops):
            et = by_type(op.type)
            inverse.extend(et.invert(et.parse(op.payload), view))
        return inverse

    def primary_task(self, payload: EditRevertedPayload) -> str | None:
        return payload.task_id

    def targets(self, payload: EditRevertedPayload) -> tuple[str, ...]:
        from misty_core.edits import by_type

        targets: set[str] = set()
        for op in payload.ops:
            et = by_type(op.type)
            targets.update(et.targets(et.parse(op.payload)))
        return tuple(sorted(targets))

    def reverts_seq(self, payload: EditRevertedPayload) -> int | None:
        return payload.reverted_seq
