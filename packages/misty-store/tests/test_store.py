import json
import sqlite3

import pytest

from misty_core import Actor, CommandRejected, TaskState
from misty_core.upcasters import UPCASTERS
from misty_store import TaskService, projection

USER = Actor(kind="user", id="test")
AGENT = Actor(kind="agent", id="agent:test")


def test_execute_records_edit_and_updates_projection(service):
    edit = service.execute(
        "create_task",
        {"title": "Call the GP"},
        actor=AGENT,
        reason="User mentioned it in their check-in",
        correlation_id="turn-1",
    )
    assert edit.seq == 1
    task = service.get_task(edit.task_id)
    assert task.title == "Call the GP"

    [recorded] = service.history(task.id)
    assert recorded == edit
    assert recorded.actor == AGENT
    assert recorded.reason == "User mentioned it in their check-in"
    assert service.verify() == []


def test_rejected_command_writes_nothing(service):
    service.execute("create_task", {"title": "A"}, actor=USER)
    with pytest.raises(CommandRejected):
        service.execute("create_task", {"title": "B", "attrs": {"bogus": 1}}, actor=USER)
    assert service.head_seq() == 1
    assert len(service.list_tasks()) == 1


def test_list_tasks_filters_by_state(service):
    a = service.execute("create_task", {"title": "A"}, actor=USER).task_id
    service.execute("create_task", {"title": "B"}, actor=USER)
    service.execute("complete_task", {"task_id": a}, actor=USER)
    assert [t.title for t in service.list_tasks({TaskState.OPEN})] == ["B"]


def test_history_includes_multi_task_edits(service):
    parent = service.execute("create_task", {"title": "Parent"}, actor=USER).task_id
    child = service.execute("create_task", {"title": "Child", "parent_id": parent}, actor=USER)
    undo = service.execute("undo_edit", {"seq": child.seq}, actor=USER)
    assert [e.seq for e in service.history(child.task_id)] == [child.seq, undo.seq]


def test_log_is_append_only(service):
    service.execute("create_task", {"title": "A"}, actor=USER)
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        service.conn.execute("UPDATE task_edits SET type = 'x'")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        service.conn.execute("DELETE FROM task_edits")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        service.conn.execute("DELETE FROM task_edit_targets")


def test_state_at(service):
    task = service.execute("create_task", {"title": "Draft"}, actor=USER).task_id
    service.execute("retitle_task", {"task_id": task, "title": "Final"}, actor=USER)
    assert service.state_at(1)[task].title == "Draft"
    assert service.state_at(2)[task].title == "Final"
    assert service.state_at(0) == {}


def test_persists_and_rebuilds_on_fingerprint_change(tmp_path):
    path = tmp_path / "misty.db"
    svc = TaskService.open(path)
    task = svc.execute("create_task", {"title": "A", "attrs": {"x_a": 1}}, actor=USER).task_id
    assert task is not None
    svc.conn.execute("UPDATE projection_meta SET value = 'stale' WHERE key = 'fingerprint'")
    svc.close()

    reopened = TaskService.open(path)
    reopened_task = reopened.get_task(task)
    assert reopened_task is not None and reopened_task.attrs == {"x_a": 1}
    assert reopened.verify() == []
    assert not projection.ensure(reopened.conn)  # up to date now


def test_verify_detects_drift_and_rebuild_fixes_it(service):
    task = service.execute("create_task", {"title": "A"}, actor=USER).task_id
    service.conn.execute("UPDATE tasks SET title = 'tampered' WHERE id = ?", (task,))
    assert service.verify() == [f"{task}: differs in title"]
    service.rebuild()
    assert service.verify() == []
    assert service.get_task(task).title == "A"


def test_old_payloads_are_upcast_on_read(service, monkeypatch):
    # A v0 'task.created' that stored the title under "name".
    service.conn.execute(
        "INSERT INTO task_edits (edit_id, type, type_version, task_id, payload, actor_kind, "
        "actor_id, occurred_at) VALUES ('e0', 'task.created', 0, 't0', ?, 'user', 'test', "
        "'2026-01-01T00:00:00Z')",
        (json.dumps({"task_id": "t0", "name": "Legacy"}),),
    )
    service.conn.execute("INSERT INTO task_edit_targets (task_id, seq) VALUES ('t0', 1)")
    monkeypatch.setitem(
        UPCASTERS,
        ("task.created", 0),
        lambda p: (
            "task.created",
            1,
            {"task_id": p["task_id"], "title": p["name"], "parent_id": None, "attrs": {}},
        ),
    )
    service.rebuild()
    assert service.get_task("t0").title == "Legacy"
    assert service.history("t0")[0].type_version == 1
