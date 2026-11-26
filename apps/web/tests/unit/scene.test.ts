import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../../src/api.ts";
import { buildTree, emptyReorg, type Reorg } from "../../src/views/dartboard2/model.ts";
import { merge, DIFFERENT_ROOT } from "../../src/views/dartboard2/reorg.ts";
import {
  buildScene, canReschedule, hitTest, marks, metaLine, subDrop, validChain, type Scene, type UiState,
} from "../../src/views/dartboard2/scene.ts";
import { task, TODAY } from "./helpers.ts";

const UI: UiState = { chain: [], adding: null, dating: null, showLater: false, oneSize: false };

function scene(tasks: Task[], ui: Partial<UiState> = {}, changed: string[] = [], reorg: Reorg = emptyReorg()): Scene {
  const tree = buildTree(tasks, reorg);
  const set = new Set(changed);
  const { halo, touched } = marks(tasks, tree, reorg, set);
  return buildScene({ tree, ui: { ...UI, ...ui }, today: TODAY, changed: set, halo, touched });
}

const board = (): Task[] => [
  task("today", { attrs: { category: "work", date: "2026-07-15" } }),
  task("t1", { parent: "today" }),
  task("t2", { parent: "today", attrs: { date: "2026-07-10" } }),
  task("t2a", { parent: "t2" }),
  task("t2b", { parent: "t2", state: "done" }),
  task("t3", { parent: "today", state: "released" }),
  task("tomorrow", { attrs: { category: "uni", date: "2026-07-16", quick: true } }),
  task("month", { attrs: { category: "admin", date: "2026-08-01" } }),
  task("later", { attrs: { category: "projects" } }),
  task("later2", { attrs: { category: "projects", date: "2026-07-15", date_kind: "scheduled" } }),
  task("nocat", { attrs: { date: "2026-07-18" } }),
];

const pos = (s: Scene) => Object.fromEntries(s.bubbles.map(b => [b.id, [b.x, b.y, b.r]]));

test("the scene is a pure function of its input", () => {
  const ui = { chain: ["today", "t2"], adding: "t2" };
  assert.deepEqual(scene(board(), ui, ["t1"]), scene(board(), ui, ["t1"]));
});

test("roots sit in the ring of their earliest deadline and the quadrant of their category", () => {
  const s = scene(board(), { showLater: true });
  const ring = (id: string) => s.byId.get(id)!.ring;
  assert.equal(ring("today"), "overdue"); // its subtask t2 is overdue
  assert.equal(ring("tomorrow"), "tomorrow");
  assert.equal(ring("month"), "month");
  assert.equal(ring("later"), "later");
  assert.equal(ring("later2"), "later"); // scheduled dates never place a task
  assert.equal(ring("nocat"), "weekend");
  const at = (id: string) => s.byId.get(id)!;
  assert.ok(at("tomorrow").x < 0 && at("tomorrow").y < 0, "uni is upper left");
  assert.ok(at("today").x > 0 && at("today").y < 0, "work is upper right");
  assert.ok(at("later").x > 0 && at("later").y > 0, "projects is lower right");
  assert.ok(at("month").x < 0 && at("month").y > 0, "admin is lower left");
  for (const b of s.bubbles) {
    const band = s.bands.find(x => x.ring === b.ring)!;
    const dist = Math.hypot(b.x, b.y);
    assert.ok(dist - b.r >= band.inner && dist + b.r <= band.outer, `${b.id} is outside its ring`);
  }
  assert.deepEqual(s.hud, {
    roots: 6, hidden: 0, later: 3,
    perRing: { overdue: 1, today: 0, tomorrow: 1, weekend: 1, month: 1, later: 2 },
  });
});

test("the short view hides the far rings without moving anything else", () => {
  const short = scene(board());
  const full = scene(board(), { showLater: true });
  assert.deepEqual(short.bubbles.map(b => b.id).sort(), ["nocat", "today", "tomorrow"]);
  assert.equal(short.hud.hidden, 3);
  assert.deepEqual(short.bands, full.bands);
  for (const b of short.bubbles) assert.deepEqual(pos(short)[b.id], pos(full)[b.id]);
});

test("still drawn, faded, in a hidden ring: changed this session, open, or touched by the draft", () => {
  const changed = scene(board(), {}, ["later"]);
  assert.equal(changed.byId.get("later")!.faded, true);
  assert.equal(changed.byId.get("later")!.halo, true);
  assert.equal(changed.hud.hidden, 2);
  const open = scene(board(), { chain: ["month"] });
  assert.equal(open.byId.get("month")!.open, true);
  assert.equal(open.byId.get("month")!.faded, true);
  const tasks = [...board(), task("la", { parent: "later" }), task("lb", { parent: "later" })];
  const draft = merge(tasks, emptyReorg(), "lb", "la");
  assert.equal(draft.kind, "changed");
  const touched = scene(tasks, {}, [], (draft as { reorg: Reorg }).reorg);
  assert.ok(touched.byId.has("later"));
  assert.ok(!touched.byId.has("month"));
});

test("bubble looks: solid with subtasks, red when overdue, quick, done, halo with ancestors", () => {
  const s = scene(board(), { chain: ["today", "t2"] }, ["t2a"]);
  const b = (id: string) => s.byId.get(id)!;
  assert.equal(b("today").hasSubs, true);
  assert.equal(b("tomorrow").hasSubs, false);
  assert.equal(b("today").overdue, true);
  assert.equal(b("t2").overdue, true);
  assert.equal(b("t1").overdue, false);
  assert.equal(b("tomorrow").quick, true);
  assert.equal(b("t2b").done, true);
  assert.deepEqual(["t2a", "t2", "today", "t1", "tomorrow"].map(id => b(id).halo), [true, true, true, false, false]);
  assert.ok(!s.byId.has("t3"), "released subtasks aren't drawn");
});

test("size grows with open subtasks, unless one size is on", () => {
  const sized = scene(board());
  const flat = scene(board(), { oneSize: true });
  assert.ok(sized.byId.get("today")!.r > sized.byId.get("tomorrow")!.r);
  assert.ok(Math.abs(sized.byId.get("today")!.r - 48 * Math.sqrt(1 + 0.25 * 3)) < 1e-9); // t1, t2, t2a
  assert.equal(flat.byId.get("today")!.r, 48);
});

test("an open bubble holds its subtasks; the chain nests", () => {
  const s = scene(board(), { chain: ["today", "t2"] });
  const b = (id: string) => s.byId.get(id)!;
  const inside = (inner: string, outer: string) =>
    Math.hypot(b(inner).x - b(outer).x, b(inner).y - b(outer).y) + b(inner).r <= b(outer).r;
  assert.ok(b("today").open && b("t2").open && !b("t1").open);
  for (const id of ["t1", "t2"]) assert.ok(inside(id, "today"), `${id} isn't inside today`);
  for (const id of ["t2a", "t2b"]) assert.ok(inside(id, "t2"), `${id} isn't inside t2`);
  assert.deepEqual([b("today").level, b("t2").level, b("t2a").level], [0, 1, 2]);
  // Opening doesn't move the bubble or its neighbours.
  const closed = scene(board());
  assert.deepEqual([b("today").x, b("today").y], [closed.byId.get("today")!.x, closed.byId.get("today")!.y]);
  assert.deepEqual(pos(s).tomorrow, pos(closed).tomorrow);
  assert.equal(b("today").meta, "📅 07-15 · subtask due 07-10");
});

test("controls: + on top, ⚡ ✓ ✕ along the bottom, ↺ only where something changed", () => {
  const s = scene(board(), { chain: ["today", "t2"] }, ["t2a"]);
  const kinds = (id: string) => s.controls.filter(c => c.id === id).map(c => c.kind);
  assert.deepEqual(kinds("today"), ["add", "quick", "complete", "discard", "undo"]);
  assert.deepEqual(kinds("t2"), ["add", "quick", "complete", "discard", "undo"]);
  assert.deepEqual(scene(board(), { chain: ["tomorrow"] }).controls.map(c => c.kind), ["add", "quick", "complete", "discard"]);
  const t = s.byId.get("today")!;
  for (const c of s.controls.filter(x => x.id === "today")) {
    assert.ok(Math.abs(Math.hypot(c.x - t.x, c.y - t.y) - t.r) < 1e-6, `${c.kind} isn't on the rim`);
    if (c.kind === "add") assert.ok(c.y < t.y && Math.abs(c.x - t.x) < 1e-9);
    else assert.ok(c.y > t.y);
  }
  assert.equal(scene(board(), { chain: ["tomorrow"] }).controls.find(c => c.kind === "quick")!.on, true);
});

test("adding: a field after the subtasks, and the + hides", () => {
  const s = scene(board(), { chain: ["today"], adding: "today" });
  assert.deepEqual(s.fields.map(f => [f.kind, f.id]), [["new", "today"]]);
  assert.ok(!s.controls.some(c => c.kind === "add"));
  const t = s.byId.get("today")!, f = s.fields[0];
  assert.ok(Math.hypot(f.x - t.x, f.y - t.y) + f.r <= t.r);
});

test("a group that exists only in the draft has no controls and is marked", () => {
  const tasks = board();
  const draft = merge(tasks, emptyReorg(), "t2", "t1") as { reorg: Reorg };
  const s = scene(tasks, { chain: ["today", "new:g1"] }, [], draft.reorg);
  assert.deepEqual(s.controls.filter(c => c.id === "new:g1"), []);
  assert.ok(s.controls.some(c => c.id === "today"));
  const g = s.byId.get("new:g1")!;
  assert.deepEqual([g.isNew, g.draft, g.title], [true, true, "t1 + t2"]);
  assert.equal(s.byId.get("t1")!.draft, true);
  assert.equal(s.byId.get("today")!.draft, false);
});

test("hits: the topmost bubble at a point, and whether it is on the name", () => {
  const s = scene(board(), { chain: ["today", "t2"] });
  const b = (id: string) => s.byId.get(id)!;
  assert.deepEqual(hitTest(s, b("t1").x, b("t1").y), { kind: "bubble", id: "t1", open: false, inCore: true });
  assert.deepEqual(hitTest(s, b("t2").x, b("t2").y), { kind: "bubble", id: "t2", open: true, inCore: true });
  assert.deepEqual(hitTest(s, b("t2a").x, b("t2a").y), { kind: "bubble", id: "t2a", open: false, inCore: true });
  assert.deepEqual(hitTest(s, b("today").x, b("today").y), { kind: "bubble", id: "today", open: true, inCore: true });
  // Just inside t2's rim, on the side away from its subtasks' ring... find a free point.
  const edge = { x: b("t2").x + (b("t2").r - 3), y: b("t2").y };
  const hit = hitTest(s, edge.x, edge.y)!;
  assert.deepEqual(hit, { kind: "bubble", id: "t2", open: true, inCore: false });
  assert.equal(hitTest(s, s.radius + 500, 0), null);
  assert.equal((hitTest(s, b("t1").x, b("t1").y, "t1") as { id: string }).id, "today");
});

test("dropping a subtask: merge, move in, stay, become a root, or be refused", () => {
  const s = scene(board(), { chain: ["today", "t2"] });
  const b = (id: string) => s.byId.get(id)!;
  assert.equal(subDrop(s, "t2a", b("t1").x, b("t1").y).kind, "merge");
  assert.deepEqual(subDrop(s, "t2a", b("t2b").x, b("t2b").y), { kind: "merge", target: "t2b", label: 'merge with "t2b"' });
  assert.equal(subDrop(s, "t2a", b("t2").x, b("t2").y).kind, "stay");
  assert.deepEqual(subDrop(s, "t2a", b("today").x, b("today").y), { kind: "into", parent: "today", label: 'move into "today"' });
  assert.deepEqual(subDrop(s, "t2a", b("tomorrow").x, b("tomorrow").y), { kind: "refuse", label: DIFFERENT_ROOT });
  assert.equal(subDrop(s, "t2a", s.radius + 300, 0).kind, "root");
});

test("the chain is cut where a bubble can no longer be open", () => {
  const tasks = board();
  const tree = buildTree(tasks);
  const none = new Set<string>();
  assert.deepEqual(validChain(tree, ["today", "t2", "t2a"], none), ["today", "t2", "t2a"]);
  assert.deepEqual(validChain(tree, ["today", "t3"], none), ["today"]); // released
  assert.deepEqual(validChain(tree, ["today", "t2a"], none), ["today"]); // not its child
  assert.deepEqual(validChain(tree, ["gone"], none), []);
  assert.deepEqual(validChain(tree, ["t1"], none), []); // not a root
  const done = buildTree(tasks.map(t => (t.id === "today" ? { ...t, state: "done" as const } : t)));
  assert.deepEqual(validChain(done, ["today"], none), []);
  assert.deepEqual(validChain(done, ["today"], new Set(["today"])), ["today"]);
});

test("the meta line", () => {
  const tree = buildTree([
    task("a", { attrs: { section: "thesis", date: "2026-07-16" } }),
    task("b", { attrs: { date: "2026-09-01", date_kind: "scheduled" } }),
    task("c"),
    task("c1", { parent: "c", attrs: { date: "2026-07-15" } }),
  ]);
  assert.equal(metaLine(tree, tree.nodes.get("a")!), "thesis · 📅 07-16");
  assert.equal(metaLine(tree, tree.nodes.get("b")!), "⏳ 09-01");
  assert.equal(metaLine(tree, tree.nodes.get("c")!), "no date · subtask due 07-15");
});

test("only closed, open-state roots that exist can be rescheduled", () => {
  const s = scene([...board(), task("fin", { state: "done" })], { chain: ["today"] }, ["fin"]);
  assert.equal(canReschedule(s.byId.get("tomorrow")!), true);
  assert.equal(canReschedule(s.byId.get("today")!), false); // open
  assert.equal(canReschedule(s.byId.get("t1")!), false); // a subtask
  assert.equal(canReschedule(s.byId.get("fin")!), false); // done
});

test("the pick-a-date field belongs to the open root", () => {
  const s = scene(board(), { chain: ["later"], dating: "later", showLater: true });
  assert.deepEqual(s.fields.map(f => [f.kind, f.id]), [["date", "later"]]);
  assert.equal(s.byId.get("later")!.dating, true);
});
