from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from misty_core.edit import Actor, Edit, EditContext
from misty_core.edits import by_tool
from misty_core.edits.base import decide_command
from misty_core.errors import CommandRejected
from misty_core.view import StateView


def decide(
    tool_name: str,
    args: Mapping[str, Any],
    view: StateView,
    ctx: EditContext,
    *,
    actor: Actor,
    reason: str | None = None,
    correlation_id: str | None = None,
) -> Edit:
    """Validate a command against current state and resolve it into an unrecorded edit.

    Raises CommandRejected if the command is malformed or invalid.
    """
    et = by_tool(tool_name)
    try:
        cmd = et.command_model.model_validate(args)
    except ValidationError as e:
        raise CommandRejected(f"Invalid arguments for {tool_name}: {_describe(e)}") from e
    payload = decide_command(et, cmd, view, ctx)
    return Edit(
        edit_id=ctx.new_id(),
        type=et.type,
        type_version=et.version,
        task_id=et.primary_task(payload),
        targets=tuple(sorted(set(et.targets(payload)))),
        payload=payload.model_dump(mode="json"),
        actor=actor,
        occurred_at=ctx.occurred_at,
        reason=reason,
        correlation_id=correlation_id,
        reverts_seq=et.reverts_seq(payload),
    )


def _describe(e: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(map(str, err['loc'])) or 'input'}: {err['msg']}" for err in e.errors()
    )
