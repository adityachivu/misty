"""Misty's pure domain model.

A *command* (a tool call or UI gesture) is decided against current state into an
*edit* (a resolved fact). Recorded edits are folded by a single pure reducer into
tasks. This package does no IO; storage lives in `misty_store`.
"""

from misty_core.commands import decide
from misty_core.edit import Actor, Edit, EditContext
from misty_core.errors import CommandRejected, ReplayError
from misty_core.reducer import REDUCER_VERSION, Fold, apply, fold
from misty_core.task import Task, TaskState
from misty_core.view import MemoryView, StateView

__all__ = [
    "REDUCER_VERSION",
    "Actor",
    "CommandRejected",
    "Edit",
    "EditContext",
    "Fold",
    "MemoryView",
    "ReplayError",
    "StateView",
    "Task",
    "TaskState",
    "apply",
    "decide",
    "fold",
]
