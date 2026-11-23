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


def make(service, title, **args):
    task_id = service.execute("create_task", {"title": title, **args}, actor=USER).task_id
    assert task_id is not None
    return task_id


def test_batch_is_all_or_nothing(service):
    a = make(service, "A")
    with pytest.raises(
        CommandRejected, match=r"edits\[1\] \(retitle_task\).*already has that title"
    ):
        service.execute_many(
            [("create_task", {"title": "B"}), ("retitle_task", {"task_id": a, "title": "A"})],
            actor=AGENT,
        )
    assert service.head_seq() == 1
    assert [t.title for t in service.list_tasks()] == ["A"]
    assert service.verify() == []


def test_batch_can_refer_to_the_tasks_it_creates(service):
    a, b = make(service, "A"), make(service, "B")
    edits = service.execute_many(
        [
            ("create_task", {"title": "Umbrella"}),
            ("move_task", {"task_id": a, "parent_id": "$0"}),
            ("move_task", {"task_id": b, "parent_id": "$0"}),
            ("create_task", {"title": "Sub", "parent_id": "$0"}),
            ("retitle_task", {"task_id": "$3", "title": "Sub, renamed"}),
        ],
        actor=AGENT,
        reason="Grouped the flat move",
    )
    umbrella = edits[0].task_id
    assert [t.title for t in service.children(umbrella)] == ["A", "B", "Sub, renamed"]
    assert [e.seq for e in edits] == [3, 4, 5, 6, 7]
    assert {e.reason for e in edits} == {"Grouped the flat move"}
    [correlation_id] = {e.correlation_id for e in edits}
    assert correlation_id.startswith("batch:")
    assert service.find_edits(correlation_id=correlation_id) == edits
    assert service.verify() == []


@pytest.mark.parametrize(
    ("commands", "message"),
    [
        ([("create_task", {"title": "A", "parent_id": "$0"})], "earlier edit"),
        ([("create_task", {"title": "A"}), ("move_task", {"task_id": "$0", "parent_id": "$2"})],
         "earlier edit"),
        ([("create_task", {"title": "A"}), ("complete_task", {"task_id": "$0"}),
          ("reopen_task", {"task_id": "$1"})], "did not create a task"),
        ([], "No edits"),
        ([("create_task", {"title": "A"})] * 101, "more than the 100"),
    ],
)  # fmt: skip
def test_batch_rejects_bad_references_and_sizes(service, commands, message):
    with pytest.raises(CommandRejected, match=message):
        service.execute_many(commands, actor=AGENT)
    assert service.head_seq() == 0


def test_a_batch_is_undone_as_a_group_in_reverse(service):
    a = make(service, "A")
    edits = service.execute_many(
        [
            ("create_task", {"title": "Umbrella"}),
            ("move_task", {"task_id": a, "parent_id": "$0"}),
            ("create_task", {"title": "Sub", "parent_id": "$0"}),
        ],
        actor=AGENT,
        correlation_id="turn-1",
    )
    umbrella, sub = edits[0].task_id, edits[2].task_id
    seqs = [e.seq for e in service.find_edits(correlation_id="turn-1")]
    head = service.head_seq()

    # In the order they were made, the umbrella would be discarded with A still under it.
    with pytest.raises(CommandRejected, match=r"edits\[0\] \(undo_edit\).*subtask"):
        service.execute_many([("undo_edit", {"seq": seq}) for seq in seqs], actor=AGENT)
    assert service.head_seq() == head

    service.execute_many([("undo_edit", {"seq": seq}) for seq in reversed(seqs)], actor=AGENT)
    assert service.get_task(a).parent_id is None
    assert service.get_task(umbrella).state is TaskState.DISCARDED
    assert service.get_task(sub).state is TaskState.DISCARDED
    assert service.verify() == []


def test_list_tasks_filters(service):
    parent = make(service, "Move flat", attrs={"category": "admin", "notes": "Ask Priya"})
    make(service, "Pack BOXES", parent_id=parent, attrs={"quick": True})
    make(service, "Book van", parent_id=parent)
    make(service, "Essay", attrs={"category": "uni", "x_n": 1})

    def titles(**filters):
        return [t.title for t in service.list_tasks(**filters)]

    assert titles(parent_id=parent) == ["Pack BOXES", "Book van"]
    assert titles(attrs={"category": "admin"}) == ["Move flat"]
    assert titles(attrs={"quick": True}) == ["Pack BOXES"]
    assert titles(attrs={"x_n": True}) == []  # JSON equality: 1 is not true
    assert titles(attrs={"category": "uni", "x_n": 1}) == ["Essay"]
    assert titles(query="boxes") == ["Pack BOXES"]
    assert titles(query="priya") == ["Move flat"]  # notes are searched too
    assert titles(query="van", attrs={"quick": True}) == []


def test_children_ancestors_and_open_child_counts(service):
    root = make(service, "Root")
    mid = make(service, "Mid", parent_id=root)
    leaf = make(service, "Leaf", parent_id=mid)
    done = make(service, "Done", parent_id=root)
    service.execute("complete_task", {"task_id": done}, actor=USER)

    assert [t.title for t in service.children(root)] == ["Mid", "Done"]
    assert [t.title for t in service.ancestors(leaf)] == ["Root", "Mid"]
    assert service.ancestors(root) == []
    assert service.open_child_counts() == {root: 1, mid: 1}


def test_find_edits(service):
    a = service.execute("create_task", {"title": "A"}, actor=USER, correlation_id="one")
    b = service.execute("create_task", {"title": "B"}, actor=USER, correlation_id="two")
    service.execute("retitle_task", {"task_id": a.task_id, "title": "A2"}, actor=USER)
    undo = service.execute("undo_edit", {"seq": b.seq}, actor=USER, correlation_id="two")

    def seqs(**filters):
        return [e.seq for e in service.find_edits(**filters)]

    assert seqs() == [1, 2, 3, 4]
    assert seqs(task_id=a.task_id) == [1, 3]
    assert seqs(task_id=b.task_id) == [2, undo.seq]
    assert seqs(correlation_id="two") == [2, 4]
    assert seqs(limit=2) == [3, 4]  # the most recent, still oldest first
    assert seqs(after_seq=1, limit=2) == [2, 3]  # reading forwards
    assert seqs(task_id=a.task_id, correlation_id="two") == []


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
