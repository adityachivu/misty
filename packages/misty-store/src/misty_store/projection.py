"""The tasks projection: a disposable cache of `fold(edit log)`.

It is never migrated. Change `DDL` (or bump `REDUCER_VERSION`) and the fingerprint
changes, so the next `ensure()` drops the projection and replays the log.
"""

import hashlib
import json
import sqlite3
from typing import Any

from misty_core import REDUCER_VERSION, Edit, Task, fold
from misty_store import event_store
from misty_store.db import transaction

DDL: tuple[str, ...] = (
    """
    CREATE TABLE tasks (
        id         TEXT    PRIMARY KEY,
        parent_id  TEXT    REFERENCES tasks (id),
        title      TEXT    NOT NULL,
        state      TEXT    NOT NULL,
        attrs      TEXT    NOT NULL CHECK (json_valid(attrs)),
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        version    INTEGER NOT NULL,
        last_seq   INTEGER NOT NULL
        -- Promote a hot attribute to an indexed column without touching the log, e.g.
        -- , dread INTEGER GENERATED ALWAYS AS (json_extract(attrs, '$.dread')) VIRTUAL
    )
    """,
    "CREATE INDEX tasks_parent_id ON tasks (parent_id)",
    "CREATE INDEX tasks_state ON tasks (state)",
    "CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
)

FINGERPRINT = hashlib.sha256("\n".join((*DDL, f"reducer={REDUCER_VERSION}")).encode()).hexdigest()[
    :16
]

_UPSERT = """
    INSERT INTO tasks
        (id, parent_id, title, state, attrs, created_at, updated_at, version, last_seq)
    VALUES (:id, :parent_id, :title, :state, :attrs, :created_at, :updated_at, :version, :last_seq)
    ON CONFLICT (id) DO UPDATE SET
        parent_id = excluded.parent_id, title = excluded.title, state = excluded.state,
        attrs = excluded.attrs, updated_at = excluded.updated_at, version = excluded.version,
        last_seq = excluded.last_seq
"""


class SqliteView:
    """A StateView over the projection and log, for deciding and applying live edits."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def get(self, task_id: str) -> Task | None:
        row = self.conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return to_task(row) if row else None

    def get_edit(self, seq: int) -> Edit | None:
        return event_store.get(self.conn, seq)

    def children(self, task_id: str) -> list[Task]:
        rows = self.conn.execute(
            "SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, id", (task_id,)
        )
        return [to_task(row) for row in rows]


def ensure(conn: sqlite3.Connection) -> bool:
    """Rebuild the projection if its shape or the reducer changed, or it is behind the log.

    Returns True if it rebuilt.
    """
    meta = _meta(conn)
    if meta.get("fingerprint") == FINGERPRINT and int(
        meta.get("last_applied_seq", -1)
    ) == event_store.head_seq(conn):
        return False
    rebuild(conn)
    return True


def rebuild(conn: sqlite3.Connection) -> None:
    """Drop the projection and replay the whole log into it."""
    with transaction(conn):
        conn.execute("DROP TABLE IF EXISTS tasks")
        conn.execute("DROP TABLE IF EXISTS projection_meta")
        for statement in DDL:
            conn.execute(statement)
        state = fold(event_store.read(conn))
        # Dict order is creation order, so parents are inserted before their children.
        conn.executemany(
            _UPSERT, [_to_row(task, state.last_seq[task.id]) for task in state.tasks.values()]
        )
        conn.executemany(
            "INSERT INTO projection_meta (key, value) VALUES (?, ?)",
            [("fingerprint", FINGERPRINT), ("last_applied_seq", str(state.head))],
        )


def write(conn: sqlite3.Connection, changes: dict[str, Task], seq: int) -> None:
    """Store the tasks changed by edit `seq`. Call inside the transaction that appended it."""
    conn.executemany(_UPSERT, [_to_row(task, seq) for task in changes.values()])
    conn.execute("UPDATE projection_meta SET value = ? WHERE key = 'last_applied_seq'", (str(seq),))


def load_all(conn: sqlite3.Connection) -> tuple[dict[str, Task], dict[str, int]]:
    """All projected tasks, and the seq of the last edit applied to each."""
    tasks: dict[str, Task] = {}
    last_seq: dict[str, int] = {}
    for row in conn.execute("SELECT * FROM tasks ORDER BY created_at, id"):
        tasks[row["id"]] = to_task(row)
        last_seq[row["id"]] = row["last_seq"]
    return tasks, last_seq


def to_task(row: sqlite3.Row) -> Task:
    return Task.model_validate({**dict(row), "attrs": json.loads(row["attrs"])})


def _to_row(task: Task, last_seq: int) -> dict[str, Any]:
    data = task.model_dump(mode="json")
    return {**data, "attrs": json.dumps(data["attrs"]), "last_seq": last_seq}


def _meta(conn: sqlite3.Connection) -> dict[str, str]:
    try:
        return {row["key"]: row["value"] for row in conn.execute("SELECT * FROM projection_meta")}
    except sqlite3.OperationalError:  # no projection yet
        return {}
