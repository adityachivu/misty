"""Checks and time travel over the edit log."""

import sqlite3

from misty_core import Task, fold
from misty_store import event_store, projection
from misty_store.db import transaction


def verify(conn: sqlite3.Connection) -> list[str]:
    """Replay the log in memory and compare it with the live projection.

    Returns human-readable differences; an empty list means the replay invariant holds.
    """
    with transaction(conn, write=False):
        expected = fold(event_store.read(conn))
        live, live_seq = projection.load_all(conn)

    diffs: list[str] = []
    for task_id in sorted(expected.tasks.keys() | live.keys()):
        want, got = expected.tasks.get(task_id), live.get(task_id)
        if want is None:
            diffs.append(f"{task_id}: in the projection but not produced by replay")
        elif got is None:
            diffs.append(f"{task_id}: produced by replay but missing from the projection")
        elif want != got:
            fields = [f for f in Task.model_fields if getattr(want, f) != getattr(got, f)]
            diffs.append(f"{task_id}: differs in {', '.join(fields)}")
        elif expected.last_seq[task_id] != live_seq[task_id]:
            diffs.append(
                f"{task_id}: last_seq is {live_seq[task_id]}, replay gives "
                f"{expected.last_seq[task_id]}"
            )
    return diffs


def state_at(conn: sqlite3.Connection, seq: int) -> dict[str, Task]:
    """All tasks as they were right after edit `seq`."""
    with transaction(conn, write=False):
        return fold(event_store.read(conn, upto_seq=seq)).tasks
