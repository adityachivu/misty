import itertools
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from misty_core import Actor, Edit, EditContext, MemoryView, Task, apply, decide


class Log:
    """An in-memory edit log + projection, using the same decide/apply as the store."""

    def __init__(self) -> None:
        self.tasks: dict[str, Task] = {}
        self.edits: dict[int, Edit] = {}
        self.view = MemoryView(self.tasks, self.edits)
        self._clock = itertools.count()

    def run(self, tool: str, **args: Any) -> Edit:
        ctx = EditContext(
            occurred_at=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=next(self._clock)),
            new_id=lambda: str(uuid.uuid7()),
        )
        edit = decide(tool, args, self.view, ctx, actor=Actor(kind="user", id="test"))
        seq = len(self.edits) + 1
        edit = edit.model_copy(update={"seq": seq})
        self.edits[seq] = edit
        self.tasks.update(apply(edit, self.view))
        return edit

    def create(self, title: str = "Do the thing", **args: Any) -> Task:
        task_id = self.run("create_task", title=title, **args).task_id
        assert task_id is not None
        return self.tasks[task_id]

    def task(self, task_id: str) -> Task:
        return self.tasks[task_id]


@pytest.fixture
def log() -> Log:
    return Log()
