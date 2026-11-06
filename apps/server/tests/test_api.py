import pytest
from fastapi.testclient import TestClient

from misty_server.api import create_app
from misty_server.importers import import_dartboard
from misty_store import TaskService, connect


@pytest.fixture
def service():
    svc = TaskService(connect(":memory:"))
    yield svc
    svc.close()


@pytest.fixture
def client(service):
    return TestClient(create_app(service))


def command(client, tool, **args):
    return client.post(
        "/api/commands",
        json={"tool": tool, "args": args, "actor_id": "web:test", "correlation_id": "s1"},
    )


def test_command_round_trip(client):
    r = command(client, "create_task", title="Book dentist", attrs={"category": "admin"})
    assert r.status_code == 200
    edit = r.json()["edit"]
    assert edit["actor"] == {"kind": "user", "id": "web:test"}
    assert edit["correlation_id"] == "s1"

    body = client.get("/api/tasks").json()
    assert body["head_seq"] == 1
    [task] = body["tasks"]
    assert task["title"] == "Book dentist"
    assert task["attrs"] == {"category": "admin"}
    assert client.get(f"/api/tasks/{task['id']}/history").json()[0]["seq"] == 1


def test_rejected_command_is_400_with_message(client):
    r = command(client, "create_task", title="x", attrs={"category": "chores"})
    assert r.status_code == 400
    assert "category" in r.json()["detail"]


def test_filter_by_state(client):
    task_id = command(client, "create_task", title="A").json()["edit"]["task_id"]
    command(client, "create_task", title="B")
    command(client, "complete_task", task_id=task_id)
    titles = [t["title"] for t in client.get("/api/tasks?state=open").json()["tasks"]]
    assert titles == ["B"]


def test_import_dartboard(service):
    data = {
        "tasks": [
            {
                "text": "understand evaluations",
                "category": "work",
                "section": "EMAS",
                "date": "2026-07-15",
                "dateType": "due",
                "zap": False,
                "children": [
                    {"text": "metrics", "done": True, "zap": True, "children": []},
                    {"text": "baseline", "children": []},
                ],
            },
            {
                "text": "someday",
                "category": "projects",
                "date": "2026-08-01",
                "dateType": "scheduled",
                "children": [],
            },
        ]
    }
    assert import_dartboard(service, data) == 4
    tasks = {t.title: t for t in service.list_tasks()}
    root = tasks["understand evaluations"]
    assert root.attrs == {
        "category": "work",
        "section": "EMAS",
        "date": "2026-07-15",
        "date_kind": "due",
    }
    assert tasks["metrics"].parent_id == root.id
    assert tasks["metrics"].state == "done"
    assert tasks["metrics"].attrs == {"quick": True}
    assert tasks["someday"].attrs["date_kind"] == "scheduled"
    assert service.verify() == []


def test_draft_round_trip(service):
    client = TestClient(create_app(service, settle_every=None))
    root = command(client, "create_task", title="root").json()["edit"]["task_id"]
    a = command(client, "create_task", title="a", parent_id=root).json()["edit"]["task_id"]
    b = command(client, "create_task", title="b", parent_id=root).json()["edit"]["task_id"]

    draft = client.post("/api/drafts", json={"client": "web:test", "vocabulary": "bubbles"}).json()[
        "draft"
    ]
    after = {
        "nodes": [
            {"id": "new:g", "parent": root, "title": "b + a"},
            {"id": b, "parent": "new:g"},
            {"id": a, "parent": "new:g"},
        ]
    }
    r = client.patch(
        f"/api/drafts/{draft['id']}",
        json={"append_ops": [{"op": "merge", "dragged": a, "target": b}], "after": after},
    )
    assert r.status_code == 200
    assert [d["id"] for d in client.get("/api/drafts?status=open").json()] == [draft["id"]]

    body = client.post(f"/api/drafts/{draft['id']}/apply").json()
    assert body["draft"]["status"] == "applied"
    assert [e["type"] for e in body["edits"]] == [
        "task.created",
        "task.reparented",
        "task.reparented",
    ]
    assert {e["correlation_id"] for e in body["edits"]} == {draft["id"]}

    r = client.patch(f"/api/drafts/{draft['id']}", json={"note": "late"})
    assert r.status_code == 400


def test_settle_loop_applies_drafts(service):
    import time

    with TestClient(create_app(service, settle_every=0.05)) as client:
        root = command(client, "create_task", title="root").json()["edit"]["task_id"]
        a = command(client, "create_task", title="a", parent_id=root).json()["edit"]["task_id"]
        draft = client.post(
            "/api/drafts", json={"client": "web:test", "vocabulary": "v", "settle_ms": 0}
        ).json()["draft"]
        client.patch(
            f"/api/drafts/{draft['id']}", json={"after": {"nodes": [{"id": a, "parent": None}]}}
        )
        for _ in range(100):
            if client.get(f"/api/drafts/{draft['id']}").json()["draft"]["status"] != "open":
                break
            time.sleep(0.02)
        assert client.get(f"/api/drafts/{draft['id']}").json()["draft"]["status"] == "applied"
