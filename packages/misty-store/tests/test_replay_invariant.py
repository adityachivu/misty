"""The core guarantee: replaying the edit log always recreates the tasks table.

Hypothesis drives random sequences of commands (valid and invalid) through the real
service and checks after every step that a fresh replay matches the live projection,
and that rejected commands (and batches rejected partway) leave no trace.
"""

from hypothesis import settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule

from misty_core import Actor, CommandRejected
from misty_store import TaskService, connect

ACTOR = Actor(kind="agent", id="hypothesis")

titles = st.text(max_size=12)
attr_keys = st.sampled_from(["x_a", "x_b", "x_c", "notes", "bogus"])
attr_values = st.one_of(st.none(), st.booleans(), st.integers(-3, 3), st.text(max_size=4))
attrs = st.dictionaries(attr_keys, attr_values, max_size=3)
lifecycle = st.sampled_from(["complete_task", "release_task", "reopen_task", "discard_task"])


class ReplayMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.service = TaskService(connect(":memory:"))
        self.task_ids: list[str] = []

    def teardown(self) -> None:
        self.service.close()

    def execute(self, tool: str, args: dict) -> None:
        head = self.service.head_seq()
        try:
            edit = self.service.execute(tool, args, actor=ACTOR)
        except CommandRejected:
            assert self.service.head_seq() == head, "a rejected command was recorded"
            return
        if tool == "create_task" and edit.task_id is not None:
            self.task_ids.append(edit.task_id)

    def some_task(self, data: st.DataObject) -> str:
        return data.draw(st.sampled_from(self.task_ids))

    def maybe_task(self, data: st.DataObject) -> str | None:
        return data.draw(st.none() | st.sampled_from(self.task_ids)) if self.task_ids else None

    @rule(title=titles, attrs=attrs, data=st.data())
    def create(self, title, attrs, data):
        self.execute(
            "create_task", {"title": title, "parent_id": self.maybe_task(data), "attrs": attrs}
        )

    @precondition(lambda self: self.task_ids)
    @rule(title=titles, data=st.data())
    def retitle(self, title, data):
        self.execute("retitle_task", {"task_id": self.some_task(data), "title": title})

    @precondition(lambda self: self.task_ids)
    @rule(attrs=attrs, data=st.data())
    def set_attributes(self, attrs, data):
        self.execute("set_attributes", {"task_id": self.some_task(data), "attrs": attrs})

    @precondition(lambda self: self.task_ids)
    @rule(keys=st.lists(attr_keys, max_size=2), data=st.data())
    def unset_attributes(self, keys, data):
        self.execute("unset_attributes", {"task_id": self.some_task(data), "keys": keys})

    @precondition(lambda self: self.task_ids)
    @rule(data=st.data())
    def move(self, data):
        self.execute(
            "move_task", {"task_id": self.some_task(data), "parent_id": self.maybe_task(data)}
        )

    @precondition(lambda self: self.task_ids)
    @rule(tool=lifecycle, data=st.data())
    def change_state(self, tool, data):
        self.execute(tool, {"task_id": self.some_task(data)})

    @precondition(lambda self: self.service.head_seq() > 0)
    @rule(data=st.data())
    def undo(self, data):
        seq = data.draw(st.integers(1, self.service.head_seq()))
        self.execute("undo_edit", {"seq": seq})

    @precondition(lambda self: self.task_ids)
    @rule(tools=st.lists(lifecycle, min_size=1, max_size=4), title=titles, data=st.data())
    def batch(self, tools, title, data):
        targets = st.sampled_from([*self.task_ids, "$0"])
        commands = [("create_task", {"title": title, "parent_id": self.maybe_task(data)})]
        commands += [(tool, {"task_id": data.draw(targets)}) for tool in tools]
        head = self.service.head_seq()
        try:
            edits = self.service.execute_many(commands, actor=ACTOR)
        except CommandRejected:
            assert self.service.head_seq() == head, "a rejected batch left edits behind"
            return
        assert self.service.head_seq() == head + len(commands)
        assert edits[0].task_id is not None
        self.task_ids.append(edits[0].task_id)

    @invariant()
    def replay_matches_projection(self):
        assert self.service.verify() == []


ReplayMachine.TestCase.settings = settings(max_examples=150, stateful_step_count=40, deadline=None)
TestReplayInvariant = ReplayMachine.TestCase
