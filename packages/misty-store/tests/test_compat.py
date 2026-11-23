"""Backwards compatibility: data already on the prod machine must survive new code.

Prod is updated by pulling main and running `just deploy`, so a change that can't read
what an earlier commit wrote breaks it. These tests fail on such a change. If one fails,
fix the change (new migration, upcaster) rather than the test or the fixture; if it truly
can't be made compatible, see docs/breaking/README.md.
"""

import hashlib
import json
import sqlite3
from importlib import resources
from pathlib import Path

import pytest

from misty_core import Actor
from misty_core.edits import EDIT_TYPES
from misty_store import TaskService

# Databases as earlier commits wrote them (see compat/generate.py).
FIXTURES = sorted((Path(__file__).parent / "compat").glob("*.sql"))

# Migrations that have shipped. Prod has run them and will never run them again, so a
# change to one would silently apply to new databases only.
SHIPPED_MIGRATIONS = {
    "001_edit_log.sql": "a7588d398bef1763bad6737b6b76d32ba1669b1995b22e62251bfe8243a9ea43",
}


def restore(dump: Path, to: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(to)
    conn.executescript(dump.read_text())
    return conn


def test_shipped_migrations_are_unchanged():
    found = {
        f.name: hashlib.sha256(f.read_bytes()).hexdigest()
        for f in resources.files("misty_store.migrations").iterdir()
        if f.name.endswith(".sql")
    }
    assert found == SHIPPED_MIGRATIONS, (
        "A shipped migration changed or a new one isn't listed. Never edit a migration that "
        "is on main: add the next numbered file, and add its hash to SHIPPED_MIGRATIONS."
    )


@pytest.mark.parametrize("dump", FIXTURES, ids=lambda p: p.stem)
def test_old_database_opens_with_current_code(dump, tmp_path):
    path = tmp_path / "old.db"
    restore(dump, path).close()

    service = TaskService.open(path)  # migrates the log; rebuilds the projection if needed
    assert service.verify() == []

    # The same tasks come out. New fields may appear; recorded ones must not change.
    want = json.loads(dump.with_suffix(".json").read_text())
    got = {t.id: t.model_dump(mode="json") for t in service.list_tasks()}
    assert got.keys() == want.keys()
    for task_id, task in want.items():
        assert {key: got[task_id].get(key) for key in task} == task

    # ...and the old log still takes new edits.
    service.execute("create_task", {"title": "new"}, actor=Actor(kind="user", id="test"))
    assert service.verify() == []
    service.close()


def test_every_current_edit_type_is_in_a_fixture():
    recorded: set[tuple[str, int]] = set()
    for dump in FIXTURES:
        conn = restore(dump, ":memory:")
        recorded.update(conn.execute("SELECT DISTINCT type, type_version FROM task_edits"))
        conn.close()
    missing = {(et.type, et.version) for et in EDIT_TYPES} - recorded
    assert not missing, (
        f"No compat fixture contains {sorted(missing)}. Cover it in compat/generate.py and "
        "write a NEW fixture, so the next change to it is checked against prod-like data."
    )
