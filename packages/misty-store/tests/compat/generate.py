"""Write a compat fixture: a database exactly as today's code writes it.

    uv run python packages/misty-store/tests/compat/generate.py 0002-short-name

A fixture stands for data that is already sitting on the prod machine, so test_compat.py
opens every one of them with the current code. Add a fixture when you add an edit type
or bump a payload version (test_compat.py fails until you do). Never regenerate or edit
an existing one: if it stops loading, the code change broke prod, not the fixture.
"""

import itertools
import json
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from misty_core import Actor, EditContext
from misty_store import TaskService, connect

HERE = Path(__file__).parent
USER = Actor(kind="user", id="web:dartboard")
AGENT = Actor(kind="agent", id="agent:claude-code")


def build() -> TaskService:
    """A small database that uses every edit type, with fixed ids and times."""
    ticks = itertools.count()

    def context() -> EditContext:
        n = next(ticks)
        ids = (str(uuid.UUID(int=n * 100 + i)) for i in itertools.count(1))
        return EditContext(
            occurred_at=datetime(2026, 11, 23, 9, tzinfo=UTC) + timedelta(minutes=n),
            new_id=lambda: next(ids),
        )

    service = TaskService(connect(":memory:"), context=context)

    def run(tool: str, actor: Actor = USER, **args: Any) -> Any:
        return service.execute(tool, args, actor=actor, correlation_id="fixture")

    dentist = run(
        "create_task",
        title="Book dentist",
        attrs={
            "category": "admin",
            "section": "Health",
            "date": "2026-12-01",
            "date_kind": "due",
            "notes": "ask about the night guard",
        },
    ).task_id
    number = run(
        "create_task",
        AGENT,
        title="Find the number",
        parent_id=dentist,
        attrs={"quick": True, "x_energy": 2},
    ).task_id
    thesis = run("create_task", title="Thesis", attrs={"category": "uni"}).task_id
    mistake = run("create_task", title="captured by mistake").task_id

    retitled = run("retitle_task", task_id=number, title="Find the phone number").seq
    redated = run(
        "set_attributes", task_id=dentist, attrs={"date": "2026-12-05", "date_kind": "scheduled"}
    ).seq
    run("unset_attributes", task_id=number, keys=["quick"])
    run("move_task", task_id=number, parent_id=thesis)
    run("complete_task", task_id=number)
    run("reopen_task", task_id=number)
    run("release_task", task_id=thesis)
    run("discard_task", task_id=mistake)
    run("undo_edit", seq=retitled)
    run("undo_edit", AGENT, seq=redated)
    return service


def main(name: str) -> None:
    dump, tasks = HERE / f"{name}.sql", HERE / f"{name}.json"
    if dump.exists() or tasks.exists():
        sys.exit(f"{name} already exists. Fixtures are never regenerated; pick a new name.")
    service = build()
    version = service.conn.execute("PRAGMA user_version").fetchone()[0]
    sql = "\n".join(service.conn.iterdump())
    dump.write_text(f"{sql}\nPRAGMA user_version = {version};\n")
    snapshot = {t.id: t.model_dump(mode="json") for t in service.list_tasks()}
    tasks.write_text(json.dumps(snapshot, indent=2) + "\n")
    print(f"wrote {dump.name} and {tasks.name} ({service.head_seq()} edits)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
