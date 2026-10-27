"""The single reducer. The live write path and every replay go through `apply`."""

from collections.abc import Iterable
from dataclasses import dataclass, field

from misty_core.edit import Edit
from misty_core.edits import by_type
from misty_core.errors import ReplayError
from misty_core.task import Task
from misty_core.view import MemoryView, StateView

# Bump whenever `apply` would produce different tasks from the same log. Stores
# rebuild their projection when this changes.
REDUCER_VERSION = 1


def apply(edit: Edit, view: StateView) -> dict[str, Task]:
    """Return the tasks changed by a recorded edit."""
    et = by_type(edit.type)
    if edit.type_version != et.version:
        raise ReplayError(
            f"Edit {edit.seq} is {edit.type} v{edit.type_version}, but the current version "
            f"is v{et.version}. Add an upcaster."
        )
    return et.apply(et.parse(edit.payload), view, edit.occurred_at)


@dataclass
class Fold:
    tasks: dict[str, Task] = field(default_factory=dict)
    # seq of the last edit that touched each task
    last_seq: dict[str, int] = field(default_factory=dict)
    head: int = 0  # seq of the last edit folded


def fold(edits: Iterable[Edit]) -> Fold:
    """Replay edits (in seq order) from empty state, in memory."""
    state = Fold()
    view = MemoryView(state.tasks)
    for edit in edits:
        if edit.seq is None:
            raise ReplayError(f"Edit {edit.edit_id} has no seq; only recorded edits can be folded")
        changes = apply(edit, view)
        state.tasks.update(changes)
        for task_id in changes:
            state.last_seq[task_id] = edit.seq
        state.head = edit.seq
    return state
