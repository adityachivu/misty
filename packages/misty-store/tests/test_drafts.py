from datetime import UTC, datetime, timedelta

import pytest

from misty_core import Actor, CommandRejected, TaskState
from misty_core.structure import Step, Structure, StructureNode
from misty_store import DraftService, DraftStatus

USER = Actor(kind="user", id="test")


@pytest.fixture
def clock():
    class Clock:
        now = datetime(2026, 11, 5, 12, tzinfo=UTC)

        def __call__(self):
            return self.now

        def advance(self, ms: int):
            self.now += timedelta(milliseconds=ms)

    return Clock()


@pytest.fixture
def drafts(service, clock):
    return DraftService(service, clock=clock)


def make(service, title, parent=None):
    return service.execute("create_task", {"title": title, "parent_id": parent}, actor=USER).task_id


@pytest.fixture
def tree(service):
    """root ─ a, b, c ; c ─ d, e"""
    root = make(service, "root")
    ids = {"root": root}
    for t in "abc":
        ids[t] = make(service, t, root)
    for t in "de":
        ids[t] = make(service, t, ids["c"])
    return ids


def parents(service):
    by_id = service.all_tasks()
    return {
        t.title: (by_id[t.parent_id].title if t.parent_id else None)
        for t in by_id.values()
        if t.state is not TaskState.DISCARDED
    }


def node(id, parent, **kw):
    return StructureNode(id=id, parent=parent, **kw)


def test_batch_is_all_or_nothing(service, tree):
    head = service.head_seq()
    with pytest.raises(CommandRejected, match=r"edits\[1\] \(move_task\)"):
        service.execute_batch(
            [
                Step("create_task", {"title": "g", "parent_id": tree["root"]}, as_="new:g"),
                Step("move_task", {"task_id": "nope", "parent_id": "new:g"}),
            ],
            actor=USER,
        )
    assert service.head_seq() == head
    assert service.verify() == []


def test_batch_resolves_new_refs(service, tree):
    edits = service.execute_batch(
        [
            Step("create_task", {"title": "g", "parent_id": tree["root"]}, as_="new:g"),
            Step("move_task", {"task_id": tree["a"], "parent_id": "new:g"}),
        ],
        actor=USER,
        correlation_id="c1",
    )
    assert {e.correlation_id for e in edits} == {"c1"}
    assert parents(service)["a"] == "g"
    assert service.verify() == []


def test_merge_draft_applies_as_net_change(service, drafts, clock, tree):
    d = drafts.create(client="web:test", vocabulary="bubbles", settle_ms=1000)
    after = Structure(
        nodes=[
            node("new:g1", tree["root"], title="b + a"),
            node(tree["b"], "new:g1"),
            node(tree["a"], "new:g1"),
        ]
    )
    drafts.update(d.id, append_ops=[{"op": "merge"}], after=after)
    assert drafts.settle_due() == []  # not settled yet
    clock.advance(1000)
    [applied] = drafts.settle_due()
    assert applied.status is DraftStatus.APPLIED
    assert applied.translator == "standin:structure"
    assert len(applied.seqs) == 3  # create + two moves
    p = parents(service)
    assert p["a"] == p["b"] == "b + a"
    assert p["b + a"] == "root"
    edits = service.edits(after_seq=applied.seqs[0] - 1)
    assert {e.correlation_id for e in edits} == {d.id}
    assert service.verify() == []


def test_pop_moves_children_up_and_discards(service, drafts, tree):
    d = drafts.create(client="web:test", vocabulary="bubbles")
    after = Structure(
        nodes=[node(tree["d"], tree["root"]), node(tree["e"], tree["root"])],
        removed=[tree["c"]],
    )
    drafts.update(d.id, after=after)
    applied = drafts.apply(d.id)
    assert applied.status is DraftStatus.APPLIED, applied.error
    p = parents(service)
    assert "c" not in p
    assert p["d"] == p["e"] == "root"


def test_removing_a_task_that_still_has_children_is_rejected(service, drafts, tree):
    d = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.update(d.id, after=Structure(nodes=[node(tree["d"], tree["root"])], removed=[tree["c"]]))
    head = service.head_seq()
    result = drafts.apply(d.id)
    assert result.status is DraftStatus.REJECTED
    assert "hide its subtasks" in result.error
    assert service.head_seq() == head


def test_agent_steps_are_checked_against_after(service, drafts, tree):
    d = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.update(d.id, after=Structure(nodes=[node(tree["a"], tree["c"])]))
    head = service.head_seq()
    # The translator moves the wrong task: the check rolls it back.
    wrong = [Step("move_task", {"task_id": tree["b"], "parent_id": tree["c"]})]
    result = drafts.apply(d.id, steps=wrong, translator="agent:test")
    assert result.status is DraftStatus.REJECTED
    assert "intended structure" in result.error
    assert service.head_seq() == head
    assert service.verify() == []


def test_moves_are_ordered_to_avoid_cycles(service, drafts, tree):
    # swap c and d: d becomes c's parent
    d = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.update(
        d.id,
        after=Structure(
            nodes=[node(tree["d"], tree["root"]), node(tree["c"], tree["d"])],
        ),
    )
    result = drafts.apply(d.id)
    assert result.status is DraftStatus.APPLIED, result.error
    p = parents(service)
    assert p["c"] == "d" and p["d"] == "root" and p["e"] == "c"


def test_hold_lease_delays_settling(drafts, clock, tree):
    d = drafts.create(client="web:test", vocabulary="bubbles", settle_ms=1000)
    drafts.update(d.id, after=Structure(nodes=[node(tree["a"], tree["c"])]), hold_ms=5000)
    clock.advance(2000)
    assert drafts.settle_due() == []
    clock.advance(3000)
    assert [x.status for x in drafts.settle_due()] == [DraftStatus.APPLIED]


def test_closed_drafts_refuse_updates(drafts):
    d = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.discard(d.id)
    with pytest.raises(CommandRejected, match="discarded"):
        drafts.update(d.id, append_ops=[{"op": "x"}])
    assert drafts.settle_due() == []


def test_new_root_gets_attrs(service, drafts, tree):
    d = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.update(d.id, after=Structure(nodes=[node(tree["a"], None, attrs={"category": "work"})]))
    assert drafts.apply(d.id).status is DraftStatus.APPLIED
    task = service.get_task(tree["a"])
    assert task.parent_id is None and task.attrs["category"] == "work"


def test_pop_carries_released_subtasks_up_too(service, drafts, tree):
    # An agent released e. It isn't drawn, but it still belongs to c, and c can't be
    # discarded while it is under it.
    service.execute("release_task", {"task_id": tree["e"]}, actor=USER)
    left_behind = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.update(
        left_behind.id, after=Structure(nodes=[node(tree["d"], tree["root"])], removed=[tree["c"]])
    )
    result = drafts.apply(left_behind.id)
    assert result.status is DraftStatus.REJECTED
    assert "hide its subtasks" in result.error and tree["e"] in result.error

    carried = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.update(
        carried.id,
        after=Structure(
            nodes=[node(tree["d"], tree["root"]), node(tree["e"], tree["root"])],
            removed=[tree["c"]],
        ),
    )
    result = drafts.apply(carried.id)
    assert result.status is DraftStatus.APPLIED, result.error
    assert service.get_task(tree["e"]).parent_id == tree["root"]
    assert service.get_task(tree["e"]).state is TaskState.RELEASED
    assert service.get_task(tree["c"]).state is TaskState.DISCARDED
    assert service.verify() == []


def test_a_draft_that_cancels_out_applies_with_no_edits(service, drafts, tree):
    d = drafts.create(client="web:test", vocabulary="bubbles")
    drafts.update(d.id, after=Structure(nodes=[node(tree["a"], tree["root"])]))  # where it is
    head = service.head_seq()
    result = drafts.apply(d.id)
    assert (result.status, result.seqs) == (DraftStatus.APPLIED, [])
    assert service.head_seq() == head


def test_one_draft_failing_does_not_hold_up_the_rest(service, drafts, clock, tree, monkeypatch):
    broken = drafts.create(client="web:test", vocabulary="bubbles", settle_ms=0)
    fine = drafts.create(client="web:test", vocabulary="bubbles", settle_ms=0)
    drafts.update(fine.id, after=Structure(nodes=[node(tree["a"], tree["c"])]))
    apply = drafts.apply

    def flaky(draft_id, **kwargs):
        if draft_id == broken.id:
            raise RuntimeError("disk on fire")
        return apply(draft_id, **kwargs)

    monkeypatch.setattr(drafts, "apply", flaky)
    assert [d.id for d in drafts.settle_due()] == [fine.id]
    assert drafts.get(broken.id).status is DraftStatus.OPEN  # left to try again
    assert service.get_task(tree["a"]).parent_id == tree["c"]
