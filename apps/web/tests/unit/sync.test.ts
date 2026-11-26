import { test } from "node:test";
import assert from "node:assert/strict";
import type { Draft, DraftUpdate, Edit, Structure, Task } from "../../src/api.ts";
import { emptyReorg, isEmptyReorg, type Reorg } from "../../src/views/dartboard2/model.ts";
import { merge, moveInto, VOCABULARY, type Outcome } from "../../src/views/dartboard2/reorg.ts";
import { openSession } from "../../src/views/dartboard2/session.ts";
import { createSync, HOLD_MS, SETTLE_MS, type Sync } from "../../src/views/dartboard2/sync.ts";
import { memoryStore, task } from "./helpers.ts";

type Call = { what: string; id?: string; update?: DraftUpdate; tool?: string; args?: Record<string, unknown>; correlationId?: string };

function edit(seq: number, type: string, targets: string[]): Edit {
  return {
    seq, edit_id: `e${seq}`, type, task_id: targets[0] ?? null, targets, payload: {},
    actor: { kind: "user", id: "web:dartboard2" }, occurred_at: "2026-07-15T09:00:00Z",
    reason: null, correlation_id: null, reverts_seq: null,
  };
}

/** A server that records what it is asked and answers from a small script. */
function harness(tasks: Task[]) {
  const calls: Call[] = [];
  const messages: string[] = [];
  let data = 0, status = 0, seq = 100, drafts = 0;
  let tick: () => void = () => undefined;
  const state: { draft: Draft | null; edits: Edit[]; reject: Set<number>; open: Draft[] } = {
    draft: null, edits: [], reject: new Set(), open: [],
  };
  const fresh = (): Draft => ({
    id: `d${++drafts}`, client: "web:dartboard2", vocabulary: "", note: null, base_seq: 0, ops: [],
    after: { nodes: [], removed: [] }, status: "open", settle_ms: SETTLE_MS, hold_until: null,
    translator: null, seqs: null, error: null,
    created_at: "2026-07-15T09:00:00.000Z", updated_at: "2026-07-15T09:00:00.000Z",
  });
  const store = memoryStore();
  const session = openSession(store, () => "session-1");
  const sync: Sync = createSync({
    tasks: async () => {
      calls.push({ what: "tasks" });
      return { head_seq: seq, tasks };
    },
    dispatch: async (tool, args, opts) => {
      calls.push({ what: "command", tool, args, correlationId: opts?.correlationId });
      if (tool === "undo_edit" && state.reject.has(args.seq as number)) throw new Error(`can't undo ${String(args.seq)}`);
      return edit(++seq, tool, [String(args.task_id ?? args.parent_id ?? "new")]);
    },
    drafts: {
      create: async (vocabulary, opts) => {
        calls.push({ what: "create", args: { vocabulary, ...opts } });
        state.draft = fresh();
        return state.draft;
      },
      update: async (id, update) => {
        calls.push({ what: "update", id, update });
        if (!state.draft || state.draft.status !== "open") throw new Error(`Draft '${id}' is ${state.draft?.status}, not open`);
        state.draft = {
          ...state.draft,
          after: update.after ?? state.draft.after,
          ops: [...state.draft.ops, ...(update.append_ops ?? [])],
          hold_until: update.hold_ms
            ? new Date(Date.parse("2026-07-15T09:00:10.000Z") + update.hold_ms).toISOString() : null,
        };
        return state.draft;
      },
      get: async id => {
        calls.push({ what: "get", id });
        return { draft: state.draft!, edits: state.edits };
      },
      open: async () => state.open,
      apply: async id => {
        calls.push({ what: "apply", id });
        state.draft = { ...state.draft!, status: "applied" };
        return { draft: state.draft, edits: state.edits };
      },
      discard: async id => {
        calls.push({ what: "discard", id });
        state.draft = { ...state.draft!, status: "discarded" };
        return state.draft;
      },
    },
  }, session, store, {
    data: () => void data++,
    status: () => void status++,
    message: text => void messages.push(text),
  }, {
    now: () => 0,
    setInterval: fn => { tick = fn; return 1; },
    clearInterval: () => undefined,
  });
  const ticks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      tick();
      await sync.idle();
    }
  };
  return {
    sync, calls, messages, state, session, store, ticks,
    counts: () => ({ data, status }),
    of: (what: string) => calls.filter(c => c.what === what),
  };
}

const tasks = (): Task[] => [
  task("r"), task("a", { parent: "r" }), task("b", { parent: "r" }), task("c", { parent: "r" }),
];
const changed = (o: Outcome): { reorg: Reorg; op: unknown } => {
  assert.equal(o.kind, "changed");
  return o as { reorg: Reorg; op: unknown };
};

test("commands carry the session id and join the session's undo list", async () => {
  const h = harness(tasks());
  await h.sync.start();
  const e = await h.sync.run("complete_task", { task_id: "a" });
  assert.deepEqual(h.of("command")[0], {
    what: "command", tool: "complete_task", args: { task_id: "a" }, correlationId: "session-1",
  });
  assert.deepEqual(h.session.edits(), [{ seq: e.seq, type: "complete_task", targets: ["a"] }]);
});

test("the first change creates the draft; each change sends its op and the whole intended structure", async () => {
  const h = harness(tasks());
  await h.sync.start();
  h.sync.setHeld(true); // a bubble is open
  const first = changed(merge(h.sync.tasks(), h.sync.reorg(), "b", "a"));
  h.sync.change(first.reorg, first.op);
  assert.equal(h.sync.phase(), "holding");
  await h.sync.idle();
  assert.deepEqual(h.of("create")[0].args, { vocabulary: VOCABULARY, settleMs: 6000 });
  const update = h.of("update")[0].update!;
  assert.deepEqual(update.append_ops, [first.op]);
  assert.equal(update.hold_ms, HOLD_MS);
  assert.deepEqual(update.after, {
    nodes: [{ id: "a", parent: "new:g1" }, { id: "b", parent: "new:g1" }, { id: "new:g1", parent: "r", title: "a + b" }],
    removed: [],
  } satisfies Structure);
  const second = changed(moveInto(h.sync.tasks(), h.sync.reorg(), "c", "new:g1"));
  h.sync.change(second.reorg, second.op);
  await h.sync.idle();
  assert.equal(h.of("create").length, 1);
  assert.equal(h.of("update").length, 2);
  assert.equal(h.of("update")[1].update!.after!.nodes.length, 4);
  assert.equal(h.of("tasks").length, 1, "nothing is reloaded, and nothing written, while reorganising");
  assert.equal(h.of("command").length, 0);
});

test("the lease follows transitions: renewed every 5s while held, released once with 6s", async () => {
  const h = harness(tasks());
  await h.sync.start();
  h.sync.setHeld(true);
  h.sync.setHeld(true); // telling it again changes nothing
  const m = changed(merge(h.sync.tasks(), h.sync.reorg(), "b", "a"));
  h.sync.change(m.reorg, m.op);
  await h.sync.idle();
  const before = h.of("update").length;
  await h.ticks(4);
  assert.equal(h.of("update").length, before, "no renewal before 5s");
  await h.ticks(1);
  assert.deepEqual(h.of("update").at(-1)!.update, { hold_ms: HOLD_MS });
  await h.ticks(5);
  assert.equal(h.of("update").length, before + 2);
  assert.equal(h.of("get").length, 10, "polled once a second");

  h.sync.setHeld(false); // the board closed
  h.sync.setHeld(false);
  await h.sync.idle();
  assert.deepEqual(h.of("update").at(-1)!.update, { hold_ms: SETTLE_MS });
  assert.equal(h.of("update").length, before + 3);
  assert.equal(h.sync.phase(), "settling");
  assert.equal(h.sync.secondsLeft(), 6);
  await h.ticks(10);
  assert.equal(h.of("update").length, before + 3, "a released draft isn't renewed");

  h.sync.setHeld(true); // opened again before it applied
  await h.sync.idle();
  assert.deepEqual(h.of("update").at(-1)!.update, { hold_ms: HOLD_MS });
  assert.equal(h.sync.phase(), "holding");
});

test("holding without a draft sends nothing", async () => {
  const h = harness(tasks());
  await h.sync.start();
  h.sync.setHeld(true);
  await h.ticks(12);
  h.sync.setHeld(false);
  await h.sync.idle();
  assert.deepEqual(h.calls.map(c => c.what), ["tasks"]);
  assert.equal(h.sync.phase(), "none");
});

test("a draft that cancels itself out is discarded", async () => {
  const h = harness(tasks());
  await h.sync.start();
  h.sync.setHeld(true);
  const m = changed(merge(h.sync.tasks(), h.sync.reorg(), "b", "a"));
  h.sync.change(m.reorg, m.op);
  const back = changed(moveInto(h.sync.tasks(), h.sync.reorg(), "b", "r"));
  assert.ok(isEmptyReorg(back.reorg));
  h.sync.change(back.reorg, back.op);
  await h.sync.idle();
  assert.deepEqual(h.of("discard").map(c => c.id), ["d1"]);
  assert.equal(h.sync.phase(), "none");
  await h.ticks(3);
  assert.equal(h.of("get").length, 0, "nothing left to poll");
});

test("when the server applies the draft, its edits join the session and the tasks are reloaded", async () => {
  const h = harness(tasks());
  await h.sync.start();
  const m = changed(merge(h.sync.tasks(), h.sync.reorg(), "b", "a"));
  h.sync.change(m.reorg, m.op);
  await h.sync.idle();
  assert.equal(h.sync.phase(), "settling");
  h.state.edits = [edit(7, "task.created", ["g"]), edit(8, "task.reparented", ["a"]), edit(9, "task.reparented", ["b"])];
  h.state.draft = { ...h.state.draft!, status: "applied", seqs: [7, 8, 9] };
  const loads = h.of("tasks").length;
  await h.ticks(1);
  assert.deepEqual(h.messages, ["reorganisation applied · 3 edits · ↺ undoes"]);
  assert.deepEqual(h.session.edits().map(e => e.seq), [7, 8, 9]);
  assert.ok(isEmptyReorg(h.sync.reorg()));
  assert.equal(h.sync.phase(), "none");
  assert.equal(h.of("tasks").length, loads + 1);
  await h.ticks(3);
  assert.equal(h.of("get").length, 1, "polling stops with the draft");
});

test("a rejected draft says why and reloads", async () => {
  const h = harness(tasks());
  await h.sync.start();
  const m = changed(merge(h.sync.tasks(), h.sync.reorg(), "b", "a"));
  h.sync.change(m.reorg, m.op);
  await h.sync.idle();
  h.state.draft = { ...h.state.draft!, status: "rejected", error: "Task 'a' is discarded" };
  await h.ticks(1);
  assert.deepEqual(h.messages, ["reorganisation not applied: Task 'a' is discarded"]);
  assert.ok(isEmptyReorg(h.sync.reorg()));
});

test("apply now and discard go to the server and end the draft", async () => {
  const h = harness(tasks());
  await h.sync.start();
  const m = changed(merge(h.sync.tasks(), h.sync.reorg(), "b", "a"));
  h.sync.change(m.reorg, m.op);
  h.state.edits = [edit(7, "task.created", ["g"])];
  h.sync.applyNow();
  await h.sync.idle();
  assert.deepEqual(h.of("apply").map(c => c.id), ["d1"]);
  assert.deepEqual(h.messages, ["reorganisation applied · 1 edit · ↺ undoes"]);

  const again = changed(merge(h.sync.tasks(), h.sync.reorg(), "c", "a"));
  h.sync.change(again.reorg, again.op);
  h.sync.discard();
  assert.ok(isEmptyReorg(h.sync.reorg()), "the overlay goes at once");
  await h.sync.idle();
  assert.deepEqual(h.of("discard").map(c => c.id), ["d2"]);
  assert.equal(h.sync.phase(), "none");
});

test("a change that arrives after the server settled the draft is not sent to a new one", async () => {
  const h = harness(tasks());
  await h.sync.start();
  h.sync.setHeld(true);
  const m = changed(merge(h.sync.tasks(), h.sync.reorg(), "b", "a"));
  h.sync.change(m.reorg, m.op);
  await h.sync.idle();
  h.state.draft = { ...h.state.draft!, status: "applied" };
  const more = changed(moveInto(h.sync.tasks(), h.sync.reorg(), "c", "new:g1"));
  h.sync.change(more.reorg, more.op); // the update fails: the draft is no longer open
  await h.sync.idle();
  assert.equal(h.of("create").length, 1);
  assert.ok(isEmptyReorg(h.sync.reorg()));
  assert.equal(h.messages[0], "reorganisation applied · 0 edits · ↺ undoes");
});

test("undo runs newest first as given, forgets what it undid, and stops at the first rejection", async () => {
  const h = harness(tasks());
  await h.sync.start();
  for (const seq of [1, 2, 3, 4]) h.session.add({ seq, type: "t", targets: ["a"] });
  h.state.reject.add(2);
  const res = await h.sync.undo([4, 3, 2, 1], true);
  assert.deepEqual(res, { undone: 2, error: "can't undo 2" });
  assert.deepEqual(h.of("command").map(c => c.args!.seq), [4, 3, 2]);
  assert.deepEqual(h.session.edits().map(e => e.seq), [1, 2]);
  const all = await h.sync.undo([2, 1], false); // "reset all" carries on past it
  assert.deepEqual(all, { undone: 1, error: "can't undo 2" });
  assert.deepEqual(h.session.edits().map(e => e.seq), [2]);
});

test("on load, this client's open draft is laid back over the tasks", async () => {
  const h = harness(tasks());
  const open: Draft = {
    id: "d9", client: "web:dartboard2", vocabulary: "", note: null, base_seq: 0, ops: [],
    after: {
      nodes: [{ id: "a", parent: "new:g4" }, { id: "b", parent: "new:g4" }, { id: "new:g4", parent: "r", title: "a + b" }],
      removed: [],
    },
    status: "open", settle_ms: SETTLE_MS, hold_until: null, translator: null, seqs: null, error: null,
    created_at: "2026-07-15T09:00:00.000Z", updated_at: "2026-07-15T09:00:00.000Z",
  };
  h.state.open = [open];
  h.state.draft = open;
  await h.sync.start();
  await h.sync.idle();
  assert.equal(h.sync.reorg().created.get("new:g4"), "a + b");
  assert.equal(h.sync.reorg().counter, 5);
  assert.equal(h.sync.phase(), "settling");
  assert.deepEqual(h.of("update").map(c => [c.id, c.update]), [["d9", { hold_ms: SETTLE_MS }]]);
  assert.equal(h.of("create").length, 0);
});

test("with nothing drafted, a reload keeps an empty overlay", async () => {
  const h = harness(tasks());
  await h.sync.start();
  await h.sync.refresh();
  assert.deepEqual(h.sync.reorg(), emptyReorg());
  assert.equal(h.counts().data, 2);
});
