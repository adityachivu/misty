import sqlite3
import threading
from collections.abc import Callable, Collection, Mapping
from pathlib import Path
from typing import Any

from misty_core import Actor, Edit, EditContext, Task, TaskState, apply, decide
from misty_store import event_store, projection, replay
from misty_store.db import connect, transaction


class TaskService:
    """The single write path. MCP tools, REST, and the CLI all go through `execute`."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        context: Callable[[], EditContext] = EditContext.now,
    ):
        self.conn = conn
        self._context = context
        self._lock = threading.RLock()
        projection.ensure(conn)

    @classmethod
    def open(cls, path: str | Path, **kwargs: Any) -> TaskService:
        return cls(connect(path), **kwargs)

    def close(self) -> None:
        self.conn.close()

    def execute(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        *,
        actor: Actor,
        reason: str | None = None,
        correlation_id: str | None = None,
    ) -> Edit:
        """Decide a command, append the edit, and update the projection, atomically.

        Raises CommandRejected (and writes nothing) if the command is invalid.
        """
        with self._lock, transaction(self.conn):
            view = projection.SqliteView(self.conn)
            edit = decide(
                tool_name,
                args,
                view,
                self._context(),
                actor=actor,
                reason=reason,
                correlation_id=correlation_id,
            )
            seq = event_store.append(self.conn, edit)
            edit = edit.model_copy(update={"seq": seq})
            projection.write(self.conn, apply(edit, view), seq)
        return edit

    # Reads take the lock too: the connection is shared across the web server's threads.

    def get_task(self, task_id: str) -> Task | None:
        with self._lock:
            return projection.SqliteView(self.conn).get(task_id)

    def list_tasks(self, states: Collection[TaskState] | None = None) -> list[Task]:
        with self._lock:
            tasks, _ = projection.load_all(self.conn)
        return [t for t in tasks.values() if states is None or t.state in states]

    def history(self, task_id: str) -> list[Edit]:
        with self._lock:
            return event_store.for_task(self.conn, task_id)

    def edits(self, *, after_seq: int = 0, upto_seq: int | None = None) -> list[Edit]:
        with self._lock:
            return list(event_store.read(self.conn, after_seq=after_seq, upto_seq=upto_seq))

    def head_seq(self) -> int:
        with self._lock:
            return event_store.head_seq(self.conn)

    def state_at(self, seq: int) -> dict[str, Task]:
        with self._lock:
            return replay.state_at(self.conn, seq)

    def verify(self) -> list[str]:
        with self._lock:
            return replay.verify(self.conn)

    def rebuild(self) -> None:
        with self._lock:
            projection.rebuild(self.conn)
