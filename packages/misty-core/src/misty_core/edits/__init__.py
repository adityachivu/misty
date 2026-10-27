"""The registry of edit types. Each one is an MCP tool and a row type in the edit log.

To add an edit type: write an `EditType` subclass in a module here and add an
instance to `EDIT_TYPES`. The MCP tools, REST commands, and frontend types are
generated from this tuple.
"""

from typing import Any

from misty_core.edits.attrs import AttrsSet, AttrsUnset
from misty_core.edits.base import EditType
from misty_core.edits.create import TaskCreated
from misty_core.edits.lifecycle import TaskCompleted, TaskDiscarded, TaskReleased, TaskReopened
from misty_core.edits.reparent import TaskReparented
from misty_core.edits.retitle import TaskRetitled
from misty_core.edits.revert import EditReverted
from misty_core.errors import CommandRejected, ReplayError

EDIT_TYPES: tuple[EditType[Any, Any], ...] = (
    TaskCreated(),
    TaskRetitled(),
    AttrsSet(),
    AttrsUnset(),
    TaskReparented(),
    TaskCompleted(),
    TaskReleased(),
    TaskReopened(),
    TaskDiscarded(),
    EditReverted(),
)

_BY_TYPE = {et.type: et for et in EDIT_TYPES}
_BY_TOOL = {et.tool_name: et for et in EDIT_TYPES}


def by_type(type_: str) -> EditType[Any, Any]:
    try:
        return _BY_TYPE[type_]
    except KeyError:
        raise ReplayError(
            f"Unknown edit type {type_!r} in the log. Restore it or add an upcaster."
        ) from None


def by_tool(tool_name: str) -> EditType[Any, Any]:
    try:
        return _BY_TOOL[tool_name]
    except KeyError:
        raise CommandRejected(
            f"Unknown edit {tool_name!r}. Available: {', '.join(sorted(_BY_TOOL))}"
        ) from None
