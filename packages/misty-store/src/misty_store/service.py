import sqlite3
import threading
from collections.abc import Callable, Collection, Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import JsonValue

from misty_core import Actor, CommandRejected, Edit, EditContext, Task, TaskState, apply, decide
from misty_core.attributes import same_value
from misty_core.edits.create import TaskCreated
from misty_core.structure import Step, resolve_refs
from misty_core.view import ancestors as ancestor_ids
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
        """Run several commands, in order, as one transaction: all are recorded, or none.

        Each is an ordinary edit, and they share a correlation id (generated if not
        given) so the batch can be found, and undone, as a group.

        A later step can refer, in its `task_id` or `parent_id`, to a task an earlier
        step created: as "$n" (step n, counting from 0), or by the name that step gave
        it with `as_`. `check(tasks, created)` runs on the resulting state, and any
        problem it returns rejects the whole batch. `then(edits)` runs inside the
        transaction, for bookkeeping that must commit with the edits.

        Raises CommandRejected, naming the step at fault, and writes nothing.
        """
        created: dict[str, str] = {}  # reference -> the id it was created as
        edits: list[Edit] = []
        with self.lock, transaction(self.conn):
            correlation_id = correlation_id or f"batch:{self._context().new_id()}"
            for index, step in enumerate(steps):
                try:
                    edit = self._record(
                        step.tool,
                        resolve_refs(step.args, created),
                        actor=actor,
                        reason=reason,
                        correlation_id=correlation_id,
                    )
                    if edit.type == TaskCreated.type and edit.task_id is not None:
                        created[f"${index}"] = edit.task_id
                        if step.as_:
                            created[step.as_] = edit.task_id
                    elif step.as_:
                        raise CommandRejected(f"it creates no task to call {step.as_!r}")
                except CommandRejected as e:
                    raise CommandRejected(
                        f"edits[{index}] ({step.tool}) was rejected, so nothing in this batch "
                        f"was written: {e}"
                    ) from e
                edits.append(edit)
            if check is not None:
                problems = check(projection.load_all(self.conn)[0], created)
                if problems:
                    raise CommandRejected(
                        "The result doesn't match the intended structure, so nothing was "
                        "written: " + "; ".join(problems)
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
        """Decide one command and write its edit. Call inside a write transaction."""
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

    def all_tasks(self) -> dict[str, Task]:
        """Every task, discarded ones included, by id."""
        with self.lock:
            return projection.load_all(self.conn)[0]

    def get_task(self, task_id: str) -> Task | None:
        with self.lock:
            return projection.SqliteView(self.conn).get(task_id)

    def list_tasks(
        self,
        states: Collection[TaskState] | None = None,
        *,
        parent_id: str | None = None,
        attrs: Mapping[str, JsonValue] | None = None,
        query: str | None = None,
    ) -> list[Task]:
        """Tasks matching every given filter, oldest first.

        `attrs` matches tasks that have each of those attribute values. `query` matches
        text anywhere in the title or notes, ignoring case.
        """
        with self.lock:
            tasks, _ = projection.load_all(self.conn)
        needle = query.casefold() if query else None
        return [
            t
            for t in tasks.values()
            if (states is None or t.state in states)
            and (parent_id is None or t.parent_id == parent_id)
            and all(k in t.attrs and same_value(t.attrs[k], v) for k, v in (attrs or {}).items())
            and (needle is None or needle in _searchable(t))
        ]

    def children(self, task_id: str) -> list[Task]:
        """The task's direct subtasks, in any state, oldest first."""
        with self.lock:
            return projection.SqliteView(self.conn).children(task_id)

    def ancestors(self, task_id: str) -> list[Task]:
        """The tasks above this one, from the top level down to its parent."""
        with self.lock:
            view = projection.SqliteView(self.conn)
            found = [view.get(ancestor) for ancestor in ancestor_ids(view, task_id)]
        return [task for task in reversed(found) if task is not None]

    def open_child_counts(self) -> dict[str, int]:
        """How many open subtasks each task has. Tasks with none are absent."""
        with self.lock:
            rows = self.conn.execute(
                "SELECT parent_id, COUNT(*) AS n FROM tasks "
                "WHERE state = ? AND parent_id IS NOT NULL GROUP BY parent_id",
                (TaskState.OPEN,),
            ).fetchall()
        return {row["parent_id"]: row["n"] for row in rows}

    def history(self, task_id: str) -> list[Edit]:
        with self.lock:
            return event_store.for_task(self.conn, task_id)

    def edits(self, *, after_seq: int = 0, upto_seq: int | None = None) -> list[Edit]:
        with self.lock:
            return list(event_store.read(self.conn, after_seq=after_seq, upto_seq=upto_seq))

    def find_edits(
        self,
        *,
        task_id: str | None = None,
        correlation_id: str | None = None,
        after_seq: int | None = None,
        limit: int | None = None,
    ) -> list[Edit]:
        """Edits matching every given filter, in seq order. See `event_store.find`."""
        with self.lock:
            return event_store.find(
                self.conn,
                task_id=task_id,
                correlation_id=correlation_id,
                after_seq=after_seq,
                limit=limit,
            )

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


def _searchable(task: Task) -> str:
    notes = task.attrs.get("notes")
    return f"{task.title}\n{notes if isinstance(notes, str) else ''}".casefold()
