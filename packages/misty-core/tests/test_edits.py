import pytest

from misty_core import CommandRejected, TaskState, fold
from misty_core.edits import EDIT_TYPES
from misty_core.view import OverlayView


def test_create_minimal(log):
    task = log.create("Email the landlord")
    assert task.title == "Email the landlord"
    assert task.state is TaskState.OPEN
    assert task.attrs == {}
    assert task.version == 1


def test_create_validates_attrs(log):
    task = log.create(attrs={"notes": "the blue form", "x_dread": 4})
    assert task.attrs == {"notes": "the blue form", "x_dread": 4}

    with pytest.raises(CommandRejected, match="Unknown attribute 'dread'"):
        log.create(attrs={"dread": 4})
    with pytest.raises(CommandRejected, match="null"):
        log.create(attrs={"x_dread": None})
    with pytest.raises(CommandRejected, match="Invalid value for attribute 'notes'"):
        log.create(attrs={"notes": ["not", "a", "string"]})


@pytest.mark.parametrize("title", ["", "   "])
def test_create_rejects_blank_title(log, title):
    with pytest.raises(CommandRejected, match="title"):
        log.create(title)


def test_unknown_tool_and_extra_args(log):
    with pytest.raises(CommandRejected, match="Unknown edit"):
        log.run("delete_everything")
    with pytest.raises(CommandRejected, match="Extra inputs"):
        log.run("create_task", title="x", priority="urgent")


def test_retitle(log):
    task = log.create("Taxes")
    log.run("retitle_task", task_id=task.id, title="Find last year's tax PDF")
    assert log.task(task.id).title == "Find last year's tax PDF"
    assert log.task(task.id).version == 2
    with pytest.raises(CommandRejected, match="already has that title"):
        log.run("retitle_task", task_id=task.id, title="Find last year's tax PDF")


def test_missing_task(log):
    with pytest.raises(CommandRejected, match="No task"):
        log.run("complete_task", task_id="nope")


def test_expected_version(log):
    task = log.create()
    log.run("set_attributes", task_id=task.id, attrs={"x_a": 1}, expected_version=1)
    with pytest.raises(CommandRejected, match="changed since you last read it"):
        log.run("set_attributes", task_id=task.id, attrs={"x_a": 2}, expected_version=1)


def test_set_and_unset_attributes(log):
    task = log.create(attrs={"x_a": 1})
    edit = log.run("set_attributes", task_id=task.id, attrs={"x_a": 1, "x_b": True})
    assert edit.payload["changes"] == {"x_b": {"before": None, "after": True}}  # x_a unchanged
    assert log.task(task.id).attrs == {"x_a": 1, "x_b": True}

    with pytest.raises(CommandRejected, match="already has those"):
        log.run("set_attributes", task_id=task.id, attrs={"x_b": True})
    # JSON equality: 1 is not True
    log.run("set_attributes", task_id=task.id, attrs={"x_b": 1})

    log.run("unset_attributes", task_id=task.id, keys=["x_a", "x_missing"])
    assert log.task(task.id).attrs == {"x_b": 1}
    with pytest.raises(CommandRejected, match="none of those"):
        log.run("unset_attributes", task_id=task.id, keys=["x_a"])


def test_move_task_and_cycles(log):
    parent, child, grandchild = log.create("Move flat"), log.create("Pack"), log.create("Buy tape")
    log.run("move_task", task_id=child.id, parent_id=parent.id)
    log.run("move_task", task_id=grandchild.id, parent_id=child.id)
    assert log.task(grandchild.id).parent_id == child.id

    with pytest.raises(CommandRejected, match="under itself"):
        log.run("move_task", task_id=parent.id, parent_id=grandchild.id)
    with pytest.raises(CommandRejected, match="under itself"):
        log.run("move_task", task_id=parent.id, parent_id=parent.id)

    log.run("move_task", task_id=grandchild.id, parent_id=None)
    assert log.task(grandchild.id).parent_id is None


def test_cannot_attach_to_discarded_parent(log):
    parent = log.create()
    log.run("discard_task", task_id=parent.id)
    with pytest.raises(CommandRejected, match="discarded"):
        log.create(parent_id=parent.id)


def test_cannot_discard_a_task_with_live_subtasks(log):
    parent = log.create("Move flat")
    child = log.create("Pack", parent_id=parent.id)
    with pytest.raises(CommandRejected, match="1 subtask"):
        log.run("discard_task", task_id=parent.id)
    log.run("complete_task", task_id=child.id)  # a done subtask is still not discarded
    with pytest.raises(CommandRejected, match="subtask"):
        log.run("discard_task", task_id=parent.id)

    log.run("discard_task", task_id=child.id)
    log.run("discard_task", task_id=parent.id)
    assert log.task(parent.id).state is TaskState.DISCARDED


def test_can_discard_a_task_once_its_subtasks_are_moved_out(log):
    parent = log.create()
    child = log.create(parent_id=parent.id)
    log.run("move_task", task_id=child.id, parent_id=None)
    log.run("discard_task", task_id=parent.id)
    assert log.task(child.id).state is TaskState.OPEN


def test_completing_or_releasing_a_parent_leaves_its_subtasks(log):
    parent = log.create()
    child = log.create(parent_id=parent.id)
    log.run("complete_task", task_id=parent.id)
    log.run("release_task", task_id=parent.id)
    assert log.task(child.id).state is TaskState.OPEN
    assert log.task(child.id).parent_id == parent.id


def test_undo_create_is_refused_once_the_task_has_subtasks(log):
    parent = log.create()
    created_seq = len(log.edits)
    log.create(parent_id=parent.id)
    with pytest.raises(CommandRejected, match="subtask"):
        log.run("undo_edit", seq=created_seq)


def test_staged_changes_are_seen_in_children(log):
    parent, inside, outside = log.create(), log.create(), log.create()
    log.run("move_task", task_id=inside.id, parent_id=parent.id)
    staged = OverlayView(log.view)
    staged.update(
        {
            inside.id: log.task(inside.id).model_copy(update={"parent_id": None}),
            outside.id: log.task(outside.id).model_copy(update={"parent_id": parent.id}),
        }
    )
    assert [t.id for t in staged.children(parent.id)] == [outside.id]
    assert [t.id for t in log.view.children(parent.id)] == [inside.id]


def test_lifecycle_moves_freely(log):
    task = log.create()
    log.run("release_task", task_id=task.id)
    log.run("complete_task", task_id=task.id)  # "actually, I did it"
    assert log.task(task.id).state is TaskState.DONE
    with pytest.raises(CommandRejected, match="already done"):
        log.run("complete_task", task_id=task.id)
    log.run("reopen_task", task_id=task.id)
    assert log.task(task.id).state is TaskState.OPEN


def test_undo_create_then_undo_the_undo(log):
    task = log.create()
    created_seq = len(log.edits)
    undo = log.run("undo_edit", seq=created_seq)
    assert undo.reverts_seq == created_seq
    assert log.task(task.id).state is TaskState.DISCARDED

    log.run("undo_edit", seq=undo.seq)
    assert log.task(task.id).state is TaskState.OPEN


def test_undo_set_attributes_restores_and_removes(log):
    task = log.create(attrs={"x_a": 1})
    edit = log.run("set_attributes", task_id=task.id, attrs={"x_a": 2, "x_b": "new"})
    undo = log.run("undo_edit", seq=edit.seq)
    assert log.task(task.id).attrs == {"x_a": 1}
    assert [op["type"] for op in undo.payload["ops"]] == ["task.attrs_set", "task.attrs_unset"]


def test_undo_rejects_on_conflict(log):
    task = log.create("A")
    edit = log.run("retitle_task", task_id=task.id, title="B")
    log.run("retitle_task", task_id=task.id, title="C")
    with pytest.raises(CommandRejected, match="Can't undo cleanly"):
        log.run("undo_edit", seq=edit.seq)


def test_undo_twice_is_rejected(log):
    task = log.create()
    edit = log.run("complete_task", task_id=task.id)
    log.run("undo_edit", seq=edit.seq)
    with pytest.raises(CommandRejected):
        log.run("undo_edit", seq=edit.seq)


def test_undo_move(log):
    parent, task = log.create(), log.create()
    edit = log.run("move_task", task_id=task.id, parent_id=parent.id)
    log.run("undo_edit", seq=edit.seq)
    assert log.task(task.id).parent_id is None


def test_fold_matches_live_state(log):
    a, b = log.create("A"), log.create("B")
    log.run("move_task", task_id=b.id, parent_id=a.id)
    edit = log.run("set_attributes", task_id=a.id, attrs={"x_energy": "low"})
    log.run("complete_task", task_id=b.id)
    log.run("undo_edit", seq=edit.seq)
    assert fold(log.edits.values()).tasks == log.tasks


def test_registry_is_well_formed():
    assert len({et.type for et in EDIT_TYPES}) == len(EDIT_TYPES)
    assert len({et.tool_name for et in EDIT_TYPES}) == len(EDIT_TYPES)
    for et in EDIT_TYPES:
        assert et.description, f"{et.type} needs a docstring: it becomes the tool description"
        assert et.command_model.model_json_schema()["type"] == "object"
