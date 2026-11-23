import re
import sqlite3
import threading
from collections.abc import Callable, Collection, Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import JsonValue

from misty_core import Actor, CommandRejected, Edit, EditContext, Task, TaskState, apply, decide
from misty_core.attributes import same_value
from misty_core.edits.create import TaskCreated
from misty_core.view import ancestors as ancestor_ids
from misty_store import event_store, projection, replay
from misty_store.db import connect, transaction

MAX_BATCH = 100

# In a batch, "$2" in one of these fields means the task that item 2 created.
_REF = re.compile(r"\$(\d+)")
_REF_FIELDS = ("task_id", "parent_id")


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
            return self._record(
                tool_name, args, actor=actor, reason=reason, correlation_id=correlation_id
            )

    def execute_many(
        self,
        commands: Sequence[tuple[str, Mapping[str, Any]]],
        *,
        actor: Actor,
        reason: str | None = None,
        correlation_id: str | None = None,
    ) -> list[Edit]:
        """Run several commands, in order, as one transaction: all are recorded or none.

        Each is an ordinary edit, and they share a correlation id (generated if not
        given) so the batch can be found, and undone, as a group. In a `task_id` or
        `parent_id`, "$n" means the task created by command n, counting from 0.

        Raises CommandRejected, naming the command at fault, and writes nothing.
        """
        if not commands:
            raise CommandRejected("No edits were given")
        if len(commands) > MAX_BATCH:
            raise CommandRejected(
                f"{len(commands)} edits is more than the {MAX_BATCH} one batch can hold"
            )
        edits: list[Edit] = []
        with self._lock, transaction(self.conn):
            correlation_id = correlation_id or f"batch:{self._context().new_id()}"
            for index, (tool_name, args) in enumerate(commands):
                try:
                    edit = self._record(
                        tool_name,
                        _resolve_refs(args, edits),
                        actor=actor,
                        reason=reason,
                        correlation_id=correlation_id,
                    )
                except CommandRejected as e:
                    raise CommandRejected(
                        f"edits[{index}] ({tool_name}) was rejected, so nothing in this batch "
                        f"was written: {e}"
                    ) from e
                edits.append(edit)
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

    def get_task(self, task_id: str) -> Task | None:
        with self._lock:
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
        with self._lock:
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
        with self._lock:
            return projection.SqliteView(self.conn).children(task_id)

    def ancestors(self, task_id: str) -> list[Task]:
        """The tasks above this one, from the top level down to its parent."""
        with self._lock:
            view = projection.SqliteView(self.conn)
            found = [view.get(ancestor) for ancestor in ancestor_ids(view, task_id)]
        return [task for task in reversed(found) if task is not None]

    def open_child_counts(self) -> dict[str, int]:
        """How many open subtasks each task has. Tasks with none are absent."""
        with self._lock:
            rows = self.conn.execute(
                "SELECT parent_id, COUNT(*) AS n FROM tasks "
                "WHERE state = ? AND parent_id IS NOT NULL GROUP BY parent_id",
                (TaskState.OPEN,),
            ).fetchall()
        return {row["parent_id"]: row["n"] for row in rows}

    def history(self, task_id: str) -> list[Edit]:
        with self._lock:
            return event_store.for_task(self.conn, task_id)

    def edits(self, *, after_seq: int = 0, upto_seq: int | None = None) -> list[Edit]:
        with self._lock:
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
        with self._lock:
            return event_store.find(
                self.conn,
                task_id=task_id,
                correlation_id=correlation_id,
                after_seq=after_seq,
                limit=limit,
            )

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


def _resolve_refs(args: Mapping[str, Any], done: Sequence[Edit]) -> dict[str, Any]:
    """Replace "$n" task references with the id of the task that command n created."""
    resolved = dict(args)
    for field in _REF_FIELDS:
        value = resolved.get(field)
        if not isinstance(value, str) or not (match := _REF.fullmatch(value.strip())):
            continue
        n = int(match[1])
        if n >= len(done):
            raise CommandRejected(f"{field} {value!r} must refer to an earlier edit in the batch")
        if done[n].type != TaskCreated.type:
            raise CommandRejected(
                f"{field} {value!r} refers to edits[{n}], which did not create a task"
            )
        resolved[field] = done[n].task_id
    return resolved


def _searchable(task: Task) -> str:
    notes = task.attrs.get("notes")
    return f"{task.title}\n{notes if isinstance(notes, str) else ''}".casefold()
