"""Append to and read from the edit log. Edits are upcast to current shape on read."""

import json
import sqlite3
from collections.abc import Iterator

from misty_core import Actor, Edit
from misty_core.upcasters import upcast

_SELECT = """
    SELECT e.*,
           (SELECT json_group_array(t.task_id) FROM task_edit_targets t WHERE t.seq = e.seq)
               AS targets
    FROM task_edits e
"""


def append(conn: sqlite3.Connection, edit: Edit) -> int:
    """Append an edit and return its seq. Call inside a write transaction."""
    data = edit.model_dump(mode="json")
    cursor = conn.execute(
        """
        INSERT INTO task_edits (edit_id, type, type_version, task_id, payload, actor_kind,
                                actor_id, correlation_id, reason, reverts_seq, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            edit.edit_id,
            edit.type,
            edit.type_version,
            edit.task_id,
            json.dumps(data["payload"]),
            edit.actor.kind,
            edit.actor.id,
            edit.correlation_id,
            edit.reason,
            edit.reverts_seq,
            data["occurred_at"],
        ),
    )
    seq = cursor.lastrowid
    assert seq is not None
    conn.executemany(
        "INSERT INTO task_edit_targets (task_id, seq) VALUES (?, ?)",
        [(task_id, seq) for task_id in edit.targets],
    )
    return seq


def read(
    conn: sqlite3.Connection, *, after_seq: int = 0, upto_seq: int | None = None
) -> Iterator[Edit]:
    """Yield edits in seq order, optionally within (after_seq, upto_seq]."""
    rows = conn.execute(
        f"{_SELECT} WHERE e.seq > ? AND (? IS NULL OR e.seq <= ?) ORDER BY e.seq",
        (after_seq, upto_seq, upto_seq),
    )
    for row in rows:
        yield _to_edit(row)


def get(conn: sqlite3.Connection, seq: int) -> Edit | None:
    row = conn.execute(f"{_SELECT} WHERE e.seq = ?", (seq,)).fetchone()
    return _to_edit(row) if row else None


def for_task(conn: sqlite3.Connection, task_id: str) -> list[Edit]:
    """Every edit that touched a task, in seq order."""
    rows = conn.execute(
        f"{_SELECT} WHERE e.seq IN (SELECT seq FROM task_edit_targets WHERE task_id = ?) "
        "ORDER BY e.seq",
        (task_id,),
    )
    return [_to_edit(row) for row in rows]


def find(
    conn: sqlite3.Connection,
    *,
    task_id: str | None = None,
    correlation_id: str | None = None,
    after_seq: int | None = None,
    limit: int | None = None,
) -> list[Edit]:
    """Edits matching every given filter, in seq order.

    With `after_seq`, the first `limit` edits after it (for reading forwards). Without,
    the most recent `limit`.
    """
    newest_first = after_seq is None and limit is not None
    rows = conn.execute(
        f"""
        {_SELECT}
        WHERE e.seq > :after
          AND (:task_id IS NULL
               OR e.seq IN (SELECT seq FROM task_edit_targets WHERE task_id = :task_id))
          AND (:correlation_id IS NULL OR e.correlation_id = :correlation_id)
        ORDER BY e.seq {"DESC" if newest_first else "ASC"}
        LIMIT :limit
        """,
        {
            "after": after_seq or 0,
            "task_id": task_id,
            "correlation_id": correlation_id,
            "limit": -1 if limit is None else limit,
        },
    ).fetchall()
    return [_to_edit(row) for row in (reversed(rows) if newest_first else rows)]


def head_seq(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COALESCE(MAX(seq), 0) FROM task_edits").fetchone()[0]


def _to_edit(row: sqlite3.Row) -> Edit:
    type_, version, payload = upcast(row["type"], row["type_version"], json.loads(row["payload"]))
    return Edit(
        seq=row["seq"],
        edit_id=row["edit_id"],
        type=type_,
        type_version=version,
        task_id=row["task_id"],
        targets=tuple(sorted(json.loads(row["targets"]))),
        payload=payload,
        actor=Actor(kind=row["actor_kind"], id=row["actor_id"]),
        occurred_at=row["occurred_at"],
        reason=row["reason"],
        correlation_id=row["correlation_id"],
        reverts_seq=row["reverts_seq"],
    )
