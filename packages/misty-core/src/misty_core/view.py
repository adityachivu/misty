from collections.abc import Iterator, Mapping
from typing import Protocol

from misty_core.edit import Edit
from misty_core.task import Task


class StateView(Protocol):
    """Read access to current state, as seen by `decide` and `apply`."""

    def get(self, task_id: str) -> Task | None: ...

    def get_edit(self, seq: int) -> Edit | None: ...

    def children(self, task_id: str) -> list[Task]:
        """The task's direct subtasks, in any state. Only `decide` may use this."""
        ...


class MemoryView:
    """A view over in-memory dicts. Sees later mutations of those dicts."""

    def __init__(self, tasks: Mapping[str, Task], edits: Mapping[int, Edit] | None = None):
        self._tasks = tasks
        self._edits = edits if edits is not None else {}

    def get(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    def get_edit(self, seq: int) -> Edit | None:
        return self._edits.get(seq)

    def children(self, task_id: str) -> list[Task]:
        return [task for task in self._tasks.values() if task.parent_id == task_id]


class OverlayView:
    """Stages changes on top of another view without touching it."""

    def __init__(self, base: StateView):
        self.base = base
        self.changes: dict[str, Task] = {}

    def get(self, task_id: str) -> Task | None:
        return self.changes[task_id] if task_id in self.changes else self.base.get(task_id)

    def get_edit(self, seq: int) -> Edit | None:
        return self.base.get_edit(seq)

    def children(self, task_id: str) -> list[Task]:
        # A staged change may have moved a task into or out of this parent.
        candidates = {task.id: task for task in self.base.children(task_id)} | self.changes
        return [task for task in candidates.values() if task.parent_id == task_id]

    def update(self, changes: Mapping[str, Task]) -> None:
        self.changes.update(changes)


def ancestors(view: StateView, task_id: str) -> Iterator[str]:
    """Yield the ids of a task's parent, grandparent, and so on."""
    seen = {task_id}
    task = view.get(task_id)
    while task is not None and task.parent_id is not None and task.parent_id not in seen:
        seen.add(task.parent_id)
        yield task.parent_id
        task = view.get(task.parent_id)
