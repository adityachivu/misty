import sqlite3
import threading
from collections.abc import Callable, Collection, Mapping, Sequence
from pathlib import Path
from typing import Any

from misty_core import Actor, CommandRejected, Edit, EditContext, Task, TaskState, apply, decide
from misty_core.structure import Step, resolve_refs
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
        # Guards the shared connection. Hold it across a read-then-write sequence.
        self.lock = threading.RLock()
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
        with self.lock, transaction(self.conn):
            return self._record(
                tool_name, args, actor=actor, reason=reason, correlation_id=correlation_id
            )

    def execute_batch(
        self,
        steps: Sequence[Step],
        *,
        actor: Actor,
        reason: str | None = None,
        correlation_id: str | None = None,
        check: Callable[[dict[str, Task], dict[str, str]], list[str]] | None = None,
        then: Callable[[list[Edit]], None] | None = None,
    ) -> list[Edit]:
        """Run several commands in one transaction: all are recorded, or none.

        A step's `as_` names the task it creates, and later steps may refer to it as
        `new:<label>`. `check(tasks, created)` runs on the resulting state; any problem
        it returns rejects the whole batch. `then(edits)` runs inside the transaction,
        for bookkeeping that must commit with the edits.
        """
        with self.lock, transaction(self.conn):
            created: dict[str, str] = {}
            edits: list[Edit] = []
            for i, step in enumerate(steps):
                try:
                    edit = self._record(
                        step.tool,
                        resolve_refs(step.args, created),
                        actor=actor,
                        reason=reason,
                        correlation_id=correlation_id,
                    )
                except CommandRejected as e:
                    raise CommandRejected(f"Step {i + 1} ({step.tool}): {e}") from e
                if step.as_:
                    if edit.task_id is None:
                        raise CommandRejected(f"Step {i + 1} ({step.tool}) creates no task")
                    created[step.as_] = edit.task_id
                edits.append(edit)
            if check is not None:
                problems = check(projection.load_all(self.conn)[0], created)
                if problems:
                    raise CommandRejected(
                        "The result doesn't match the intended structure: " + "; ".join(problems)
                    )
            if then is not None:
                then(edits)
        return edits

    def _record(
        self,
        tool_name: str,
        args: Mapping[str, Any],
        *,
        actor: Actor,
        reason: str | None,
        correlation_id: str | None,
    ) -> Edit:
        """Decide, append and project one edit. Call inside a write transaction."""
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

    def all_tasks(self) -> dict[str, Task]:
        """Every task, discarded ones included, by id."""
        with self.lock:
            return projection.load_all(self.conn)[0]

    # Reads take the lock too: the connection is shared across the web server's threads.

    def get_task(self, task_id: str) -> Task | None:
        with self.lock:
            return projection.SqliteView(self.conn).get(task_id)

    def list_tasks(self, states: Collection[TaskState] | None = None) -> list[Task]:
        with self.lock:
            tasks, _ = projection.load_all(self.conn)
        return [t for t in tasks.values() if states is None or t.state in states]

    def history(self, task_id: str) -> list[Edit]:
        with self.lock:
            return event_store.for_task(self.conn, task_id)

    def edits(self, *, after_seq: int = 0, upto_seq: int | None = None) -> list[Edit]:
        with self.lock:
            return list(event_store.read(self.conn, after_seq=after_seq, upto_seq=upto_seq))

    def head_seq(self) -> int:
        with self.lock:
            return event_store.head_seq(self.conn)

    def state_at(self, seq: int) -> dict[str, Task]:
        with self.lock:
            return replay.state_at(self.conn, seq)

    def verify(self) -> list[str]:
        with self.lock:
            return replay.verify(self.conn)

    def rebuild(self) -> None:
        with self.lock:
            projection.rebuild(self.conn)
