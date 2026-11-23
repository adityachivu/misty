import json

import pytest

from misty_core import Actor, CommandRejected
from misty_core.attributes import ATTRIBUTES, AttributeSpec
from misty_core.edits import EDIT_TYPES
from misty_server import tools
from misty_store import TaskService, connect

AGENT = Actor(kind="agent", id="agent:test")
READS = ["list_tasks", "get_task", "list_edits"]


@pytest.fixture
def service():
    svc = TaskService(connect(":memory:"))
    yield svc
    svc.close()


def read(service, name, **args):
    return tools.call(service, name, args, AGENT)


def write(service, name, **args):
    return tools.call(service, name, {"reason": "Because", **args}, AGENT)


def create(service, title, **args):
    return write(service, "create_task", title=title, **args)["task"]["id"]


# ─── the listing ─────────────────────────────────────────────────────────────────────


def test_one_tool_per_edit_type_plus_the_batch_and_three_reads():
    assert list(tools.TOOLS) == [*(et.tool_name for et in EDIT_TYPES), "apply_edits", *READS]
    assert [tool.name for tool in tools.TOOLS.values() if tool.read_only] == READS
    for tool in tools.TOOLS.values():
        assert tool.description


def test_schemas_are_plain_json_schema():
    def keywords(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "properties":  # argument names, not keywords
                    for sub in value.values():
                        yield from keywords(sub)
                else:
                    yield key
                    yield from keywords(value)
        elif isinstance(node, list):
            for item in node:
                yield from keywords(item)

    for tool in tools.TOOLS.values():
        schema = tool.input_schema
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert not {"$ref", "$defs", "title"} & set(keywords(schema)), tool.name
        json.dumps(schema)


def test_optional_arguments_are_not_shown_as_nullable():
    properties = tools.TOOLS["create_task"].input_schema["properties"]
    assert properties["parent_id"]["type"] == "string"
    # move_task's parent_id is required and null is meaningful: top level.
    move = tools.TOOLS["move_task"].input_schema
    assert {"type": "null"} in move["properties"]["parent_id"]["anyOf"]
    assert "parent_id" in move["required"]


def test_every_write_requires_a_reason_and_no_edit_argument_is_named_like_it():
    for et in EDIT_TYPES:
        schema = tools.TOOLS[et.tool_name].input_schema
        assert "reason" in schema["required"]
        assert "correlation_id" in schema["properties"]
        assert not et.command_model.model_fields.keys() & tools.ENVELOPE.keys()
    assert "reason" in tools.TOOLS["apply_edits"].input_schema["required"]
    for name in READS:
        assert "reason" not in tools.TOOLS[name].input_schema["properties"]


def test_attrs_schema_comes_from_the_attribute_registry(monkeypatch):
    for name in ("create_task", "set_attributes", "list_tasks"):
        attrs = tools.TOOLS[name].input_schema["properties"]["attrs"]
        assert attrs["properties"].keys() == ATTRIBUTES.keys()
        assert attrs["properties"]["category"]["enum"] == ["work", "uni", "projects", "admin"]
        assert attrs["patternProperties"] == {"^x_": {}}
        assert attrs["additionalProperties"] is False
        assert attrs["description"]
    assert tools.TOOLS["set_attributes"].input_schema["properties"]["attrs"]["minProperties"] == 1

    monkeypatch.setitem(ATTRIBUTES, "dread", AttributeSpec("dread", int, "How much it looms."))
    rebuilt = tools._build()["create_task"].input_schema["properties"]["attrs"]
    assert rebuilt["properties"]["dread"] == {
        "type": "integer",
        "description": "How much it looms.",
    }


# ─── writes ──────────────────────────────────────────────────────────────────────────


def test_write_records_who_why_and_which_turn(service):
    result = tools.call(
        service,
        "create_task",
        {"title": "Call the GP", "reason": "  Came up in check-in ", "correlation_id": "turn-1"},
        AGENT,
    )
    assert result["seq"] == 1
    assert result["task"]["title"] == "Call the GP"
    [edit] = service.edits()
    assert (edit.actor, edit.reason, edit.correlation_id) == (
        AGENT,
        "Came up in check-in",
        "turn-1",
    )


@pytest.mark.parametrize("reason", [{}, {"reason": "  "}, {"reason": 3}])
def test_write_without_a_reason_is_rejected(service, reason):
    with pytest.raises(CommandRejected, match="`reason` is required"):
        tools.call(service, "create_task", {"title": "A", **reason}, AGENT)
    assert service.head_seq() == 0


def test_closing_a_parent_tells_what_it_leaves_behind(service):
    parent = create(service, "Move flat")
    create(service, "Pack", parent_id=parent)
    create(service, "Book van", parent_id=parent)
    assert write(service, "complete_task", task_id=parent)["task"]["open_children"] == 2
    assert write(service, "release_task", task_id=parent)["task"]["open_children"] == 2
    with pytest.raises(CommandRejected, match="2 subtask"):
        write(service, "discard_task", task_id=parent)


def test_undo_returns_the_task_as_it_is_now(service):
    task = create(service, "Draft")
    retitled = write(service, "retitle_task", task_id=task, title="Final")
    undone = write(service, "undo_edit", seq=retitled["seq"])
    assert undone["task"]["title"] == "Draft"
    assert undone["task"]["version"] == 3


# ─── apply_edits ─────────────────────────────────────────────────────────────────────


def test_apply_edits_groups_tasks_under_a_new_parent(service):
    a, b = create(service, "Pack"), create(service, "Book van")
    result = write(
        service,
        "apply_edits",
        edits=[
            {"tool": "create_task", "args": {"title": "Move flat"}},
            {"tool": "move_task", "args": {"task_id": a, "parent_id": "$0"}},
            {"tool": "move_task", "args": {"task_id": b, "parent_id": "$0"}},
        ],
    )
    umbrella = result["results"][0]["task"]
    assert umbrella["open_children"] == 2  # as it is after the whole batch
    assert [r["seq"] for r in result["results"]] == [3, 4, 5]
    assert result["results"][1]["task"]["parent_id"] == umbrella["id"]
    recorded = service.find_edits(correlation_id=result["correlation_id"])
    assert [e.reason for e in recorded] == ["Because"] * 3


def test_apply_edits_is_all_or_nothing(service):
    a = create(service, "A")
    with pytest.raises(CommandRejected, match=r"edits\[1\] \(complete_task\)"):
        write(
            service,
            "apply_edits",
            edits=[
                {"tool": "retitle_task", "args": {"task_id": a, "title": "B"}},
                {"tool": "complete_task", "args": {"task_id": "nope"}},
            ],
        )
    assert service.head_seq() == 1
    assert service.get_task(a).title == "A"


@pytest.mark.parametrize(
    ("edits", "message"),
    [
        ([{"tool": "list_tasks"}], "is not an edit"),
        ([{"tool": "apply_edits", "args": {"edits": []}}], "is not an edit"),
        ([{"tool": "create_task", "args": {"title": "A", "reason": "x"}}], "once, for the whole"),
        ([], "edits"),
        ([{"tool": "create_task", "args": {"title": "A"}}] * 101, "edits"),
        ([{"args": {}}], "edits.0.tool"),
        ("create_task", "edits"),
    ],
)
def test_apply_edits_rejects_malformed_batches(service, edits, message):
    with pytest.raises(CommandRejected, match=message):
        write(service, "apply_edits", edits=edits)
    assert service.head_seq() == 0


# ─── reads ───────────────────────────────────────────────────────────────────────────


def test_list_tasks_defaults_to_open_and_reports_truncation(service):
    for title in ("A", "B", "C"):
        create(service, title, attrs={"category": "admin"})
    done = create(service, "Done")
    write(service, "complete_task", task_id=done)

    listed = read(service, "list_tasks")
    assert [t["title"] for t in listed["tasks"]] == ["A", "B", "C"]
    assert (listed["head_seq"], listed["total"], listed["truncated"]) == (5, 3, False)

    limited = read(service, "list_tasks", limit=2)
    assert [t["title"] for t in limited["tasks"]] == ["A", "B"]
    assert (limited["total"], limited["truncated"]) == (3, True)

    assert [t["title"] for t in read(service, "list_tasks", states=["done"])["tasks"]] == ["Done"]
    assert read(service, "list_tasks", attrs={"category": "uni"})["tasks"] == []
    assert read(service, "list_tasks", query="b")["total"] == 1


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"attrs": {"priority": 1}}, "Unknown attribute 'priority'"),
        ({"parent_id": "nope"}, "No task with id 'nope'"),
        ({"limit": 0}, "Invalid arguments for list_tasks: limit"),
        ({"states": ["archived"]}, "Invalid arguments for list_tasks: states"),
        ({"reason": "x"}, "Invalid arguments for list_tasks: reason"),
    ],
)
def test_list_tasks_rejects_bad_filters(service, args, message):
    with pytest.raises(CommandRejected, match=message):
        read(service, "list_tasks", **args)


def test_get_task_shows_what_is_above_and_below(service):
    root = create(service, "Root")
    mid = create(service, "Mid", parent_id=root)
    create(service, "Leaf", parent_id=mid)
    mistake = create(service, "Mistake", parent_id=mid)
    write(service, "discard_task", task_id=mistake)

    got = read(service, "get_task", task_id=mid)
    assert got["task"]["title"] == "Mid" and got["task"]["open_children"] == 1
    assert got["ancestors"] == [{"id": root, "title": "Root", "state": "open"}]
    assert [c["title"] for c in got["children"]] == ["Leaf"]  # discarded ones are hidden

    assert read(service, "get_task", task_id=mistake)["task"]["state"] == "discarded"
    with pytest.raises(CommandRejected, match="No task with id"):
        read(service, "get_task", task_id="nope")


def test_list_edits_pages_and_filters(service):
    a = create(service, "A", correlation_id="one")
    b = create(service, "B", correlation_id="two")
    write(service, "retitle_task", task_id=a, title="A2")
    write(service, "complete_task", task_id=b, correlation_id="two")

    def seqs(**args):
        result = read(service, "list_edits", **args)
        return [e["seq"] for e in result["edits"]], result["truncated"]

    assert seqs() == ([1, 2, 3, 4], False)
    assert seqs(limit=2) == ([3, 4], True)  # the most recent
    assert seqs(after_seq=1, limit=2) == ([2, 3], True)  # reading forwards
    assert seqs(after_seq=2, limit=2) == ([3, 4], False)
    assert seqs(task_id=a) == ([1, 3], False)
    assert seqs(correlation_id="two") == ([2, 4], False)

    [edit] = read(service, "list_edits", task_id=a, limit=1)["edits"]
    assert edit["type"] == "task.retitled"
    assert edit["payload"] == {"task_id": a, "before": "A", "after": "A2"}
    assert edit["actor"] == {"kind": "agent", "id": "agent:test"}
    assert edit["reason"] == "Because"
    assert "edit_id" not in edit


def test_unknown_tool_is_rejected(service):
    with pytest.raises(CommandRejected, match="Unknown tool 'drop_table'"):
        read(service, "drop_table")
