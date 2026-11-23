"""The board's reorganisation drafts and an agent's MCP edits meet on the same tasks."""

import pytest

from misty_core import Actor, TaskState
from misty_core.structure import Structure, StructureNode
from misty_server import tools
from misty_store import DraftService, DraftStatus, TaskService, connect

AGENT = Actor(kind="agent", id="agent:test")


@pytest.fixture
def service():
    svc = TaskService(connect(":memory:"))
    yield svc
    svc.close()


@pytest.fixture
def drafts(service):
    return DraftService(service)


def agent(service, name, **args):
    if name in tools.WRITE_TOOLS or name == "apply_edits":
        args = {"reason": "Because", **args}
    return tools.call(service, name, args, AGENT)


@pytest.fixture
def tree(service):
    """Move flat ─ Pack, Book van"""
    ids = {}
    ids["flat"] = agent(service, "create_task", title="Move flat")["task"]["id"]
    for title in ("Pack", "Book van"):
        made = agent(service, "create_task", title=title, parent_id=ids["flat"])
        ids[title] = made["task"]["id"]
    return ids


def merge(drafts, tree) -> str:
    """The board's merge of Pack onto Book van, as a settled draft would hold it."""
    draft = drafts.create(client="web:dartboard", vocabulary="bubbles")
    after = Structure(
        nodes=[
            StructureNode(id="new:g", parent=tree["flat"], title="Book van + Pack"),
            StructureNode(id=tree["Book van"], parent="new:g"),
            StructureNode(id=tree["Pack"], parent="new:g"),
        ]
    )
    drafts.update(draft.id, append_ops=[{"op": "merge"}], after=after)
    return draft.id


def test_an_agent_sees_a_reorganisation_as_ordinary_edits(service, drafts, tree):
    draft_id = merge(drafts, tree)
    assert drafts.apply(draft_id).status is DraftStatus.APPLIED

    history = agent(service, "list_edits", correlation_id=draft_id)["edits"]
    assert [e["type"] for e in history] == ["task.created", "task.reparented", "task.reparented"]
    assert {e["actor"]["id"] for e in history} == {"web:dartboard"}
    assert {e["reason"] for e in history} == {"Reorganised in web:dartboard"}

    flat = agent(service, "get_task", task_id=tree["flat"])
    assert [c["title"] for c in flat["children"]] == ["Book van + Pack"]
    assert flat["children"][0]["open_children"] == 2


def test_an_agent_can_undo_a_whole_reorganisation(service, drafts, tree):
    draft_id = merge(drafts, tree)
    drafts.apply(draft_id)
    seqs = [e["seq"] for e in agent(service, "list_edits", correlation_id=draft_id)["edits"]]

    agent(
        service,
        "apply_edits",
        edits=[{"tool": "undo_edit", "args": {"seq": seq}} for seq in reversed(seqs)],
    )
    flat = agent(service, "get_task", task_id=tree["flat"])
    assert sorted(c["title"] for c in flat["children"]) == ["Book van", "Pack"]
    [group] = [t for t in service.all_tasks().values() if t.title == "Book van + Pack"]
    assert group.state is TaskState.DISCARDED
    assert service.verify() == []


def test_an_agent_edit_made_meanwhile_is_respected(service, drafts, tree):
    draft_id = merge(drafts, tree)
    # While the draft settles, the agent retitles one of the bubbles and completes another.
    agent(service, "retitle_task", task_id=tree["Pack"], title="Pack boxes")
    agent(service, "complete_task", task_id=tree["Book van"])

    assert drafts.apply(draft_id).status is DraftStatus.APPLIED
    pack = service.get_task(tree["Pack"])
    assert (pack.title, service.get_task(pack.parent_id).title) == ("Pack boxes", "Book van + Pack")
    assert service.get_task(tree["Book van"]).state is TaskState.DONE


def test_an_agent_edit_that_makes_the_draft_impossible_rejects_it_whole(service, drafts, tree):
    draft_id = merge(drafts, tree)
    agent(service, "discard_task", task_id=tree["Pack"])  # the bubble being merged is gone
    head = service.head_seq()

    result = drafts.apply(draft_id)
    assert result.status is DraftStatus.REJECTED
    assert tree["Pack"] in result.error and "discarded" in result.error
    assert service.head_seq() == head  # not even the new group was created
    assert service.verify() == []


def test_agents_and_drafts_share_one_batch_path(service, drafts, tree):
    """Both reference styles work in either: "$n" by position, `new:<label>` by name."""
    result = agent(
        service,
        "apply_edits",
        edits=[
            {"tool": "create_task", "args": {"title": "Umbrella", "parent_id": tree["flat"]}},
            {"tool": "move_task", "args": {"task_id": tree["Pack"], "parent_id": "$0"}},
        ],
    )
    umbrella = result["results"][0]["task"]["id"]
    assert service.get_task(tree["Pack"]).parent_id == umbrella
    assert result["correlation_id"].startswith("batch:")
