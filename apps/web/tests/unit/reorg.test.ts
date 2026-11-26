import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTree, drawnChildren, emptyReorg, isEmptyReorg, type Reorg,
} from "../../src/views/dartboard2/model.ts";
import {
  collapse, collapsible, DIFFERENT_ROOT, extrasOf, fromStructure, makeRoot, merge, moveInto, NESTED_POP,
  pop, toStructure, touchedIds, type Outcome,
} from "../../src/views/dartboard2/reorg.ts";
import { task } from "./helpers.ts";

/** r > a, b, c(c1, c2, c3 released), d ;  s > x */
const tasks = () => [
  task("r", { attrs: { category: "uni", section: "thesis" } }),
  task("a", { parent: "r" }),
  task("b", { parent: "r" }),
  task("c", { parent: "r" }),
  task("c1", { parent: "c" }),
  task("c2", { parent: "c" }),
  task("c3", { parent: "c", state: "released" }),
  task("d", { parent: "r", attrs: { category: "work" } }),
  task("s"),
  task("x", { parent: "s" }),
];

function changed(o: Outcome): Reorg {
  assert.equal(o.kind, "changed");
  return (o as Extract<Outcome, { kind: "changed" }>).reorg;
}
const kids = (ts: ReturnType<typeof tasks>, r: Reorg, id: string) =>
  drawnChildren(buildTree(ts, r), id).map(n => n.id);

test("merge: a new group takes the target's place and holds both", () => {
  const ts = tasks();
  const o = merge(ts, emptyReorg(), "d", "a");
  const r = changed(o);
  assert.deepEqual(kids(ts, r, "r"), ["new:g1", "b", "c"]);
  assert.deepEqual(kids(ts, r, "new:g1"), ["a", "d"]);
  assert.deepEqual(toStructure(r), {
    nodes: [
      { id: "a", parent: "new:g1" },
      { id: "d", parent: "new:g1" },
      { id: "new:g1", parent: "r", title: "a + d" },
    ],
    removed: [],
  });
  assert.deepEqual((o as { op: unknown }).op, { op: "merge", dragged: "d", target: "a", group: "new:g1", title: "a + d" });
});

test("merge is refused across roots, and does nothing onto itself", () => {
  const ts = tasks();
  assert.deepEqual(merge(ts, emptyReorg(), "a", "x"), { kind: "refused", message: DIFFERENT_ROOT });
  assert.deepEqual(merge(ts, emptyReorg(), "a", "s"), { kind: "refused", message: DIFFERENT_ROOT });
  assert.equal(merge(ts, emptyReorg(), "a", "a").kind, "nothing");
});

test("a group left with one bubble dissolves, and the draft cancels out", () => {
  const ts = tasks();
  const merged = changed(merge(ts, emptyReorg(), "d", "a"));
  const r = changed(moveInto(ts, merged, "d", "r"));
  assert.ok(isEmptyReorg(r));
  assert.deepEqual(toStructure(r), { nodes: [], removed: [] });
  assert.deepEqual(kids(ts, r, "r"), ["a", "b", "c", "d"]);
});

test("the bubble left behind takes the dissolved group's place", () => {
  const ts = tasks();
  // d joins b (the group sits in b's place), then b leaves for c: d keeps that place.
  const merged = changed(merge(ts, emptyReorg(), "d", "b"));
  assert.deepEqual(kids(ts, merged, "r"), ["a", "new:g1", "c"]);
  const r = changed(moveInto(ts, merged, "b", "c"));
  assert.deepEqual(kids(ts, r, "r"), ["a", "d", "c"]); // d is where the group, and b before it, was
  assert.equal(r.created.size, 0);
  assert.deepEqual(toStructure(r), { nodes: [{ id: "b", parent: "c" }], removed: [] });
});

test("existing tasks never dissolve", () => {
  const ts = tasks();
  const one = changed(moveInto(ts, emptyReorg(), "c1", "r"));
  const two = changed(moveInto(ts, one, "c2", "r"));
  const tree = buildTree(ts, two);
  assert.ok(tree.nodes.has("c"));
  assert.equal(tree.nodes.get("c")!.removed, false);
  assert.deepEqual(toStructure(two).removed, []);
});

test("moving into the parent it already has does nothing", () => {
  const ts = tasks();
  assert.equal(moveInto(ts, emptyReorg(), "c1", "c").kind, "nothing");
  assert.equal(moveInto(ts, emptyReorg(), "a", "s").kind, "refused");
  assert.equal(moveInto(ts, emptyReorg(), "c", "c1").kind, "refused");
});

test("a subtask dropped on empty board becomes a root with its old root's category and section", () => {
  const ts = tasks();
  const r = changed(makeRoot(ts, emptyReorg(), "c1"));
  assert.deepEqual(toStructure(r), {
    nodes: [{ id: "c1", parent: null, attrs: { category: "uni", section: "thesis" } }],
    removed: [],
  });
  // It keeps what it has of its own.
  const d = changed(makeRoot(ts, emptyReorg(), "d"));
  assert.deepEqual(toStructure(d).nodes, [{ id: "d", parent: null, attrs: { section: "thesis" } }]);
  assert.equal(buildTree(ts, d).nodes.get("d")!.attrs.category, "work");
  assert.equal(makeRoot(ts, emptyReorg(), "r").kind, "nothing");
});

test("pop: every subtask that isn't discarded moves up, drawn or not, and the level is removed", () => {
  const ts = tasks();
  const o = pop(ts, emptyReorg(), "c");
  const r = changed(o);
  assert.deepEqual(toStructure(r), {
    nodes: [{ id: "c1", parent: "r" }, { id: "c2", parent: "r" }, { id: "c3", parent: "r" }],
    removed: ["c"],
  });
  // The subtasks take the popped bubble's place, between b and d.
  assert.deepEqual(kids(ts, r, "r"), ["a", "b", "c1", "c2", "d"]);
  assert.deepEqual((o as { op: unknown }).op, { op: "pop", task: "c", subtasks: ["c1", "c2", "c3"], into: "r" });
  assert.equal(pop(ts, emptyReorg(), "a").kind, "nothing"); // nothing inside
  assert.equal(pop(ts, emptyReorg(), "r").kind, "nothing"); // roots don't pop
});

test("popping a group the draft made just takes the merge back", () => {
  const ts = tasks();
  const merged = changed(merge(ts, emptyReorg(), "d", "a"));
  const r = changed(pop(ts, merged, "new:g1"));
  assert.ok(isEmptyReorg(r));
  assert.equal(r.pops.length, 1);
});

test("two nested levels can't be dissolved in one draft (the server would refuse it)", () => {
  const ts = [
    task("r"), task("p", { parent: "r" }), task("q", { parent: "p" }), task("leaf", { parent: "q" }),
    task("other", { parent: "p" }),
  ];
  const inner = changed(pop(ts, emptyReorg(), "q"));
  assert.deepEqual(pop(ts, inner, "p"), { kind: "refused", message: NESTED_POP });
  const outer = changed(pop(ts, emptyReorg(), "p"));
  assert.deepEqual(pop(ts, outer, "q"), { kind: "refused", message: NESTED_POP });
});

test("collapse brings back a popped level whose parts are untouched and side by side", () => {
  const ts = tasks();
  const popped = changed(pop(ts, emptyReorg(), "c"));
  assert.equal(collapsible(ts, popped), 1);
  const res = collapse(ts, popped);
  assert.deepEqual(res.restored, ["c"]);
  assert.ok(isEmptyReorg(res.reorg));
  assert.equal(res.reorg.pops.length, 0);
  assert.deepEqual(kids(ts, res.reorg, "r"), ["a", "b", "c", "d"]);
});

test("collapse forgets a pop whose parts were moved", () => {
  const ts = tasks();
  const popped = changed(pop(ts, emptyReorg(), "c"));
  const moved = changed(moveInto(ts, popped, "c1", "a"));
  assert.equal(collapsible(ts, moved), 0);
  const res = collapse(ts, moved);
  assert.deepEqual(res.restored, []);
  assert.equal(res.reorg.pops.length, 0);
  assert.deepEqual(toStructure(res.reorg), toStructure(moved));
});

test("collapse forgets a pop whose parts are no longer side by side", () => {
  const ts = tasks();
  const popped = changed(pop(ts, emptyReorg(), "c"));
  // Merge two bubbles that aren't parts of c: the group lands in a's place, not between.
  const still = changed(merge(ts, popped, "d", "a"));
  assert.equal(collapsible(ts, still), 1);
  // A part merged with an outsider is no longer a part.
  const broken = changed(merge(ts, popped, "c1", "a"));
  assert.equal(collapsible(ts, broken), 0);
});

test("collapse repeats until nothing more can come back", () => {
  const ts = tasks();
  // Merge a and d, pop that group, then pop c: two levels to restore.
  const merged = changed(merge(ts, emptyReorg(), "d", "a"));
  const one = changed(pop(ts, merged, "new:g1"));
  const two = changed(pop(ts, one, "c"));
  assert.equal(collapsible(ts, two), 2);
  const res = collapse(ts, two);
  assert.deepEqual([...res.restored].sort(), ["c", "new:g1"]);
  assert.deepEqual(toStructure(res.reorg), toStructure(merged));
  assert.deepEqual(kids(ts, res.reorg, "r"), ["new:g1", "b", "c"]);
});

test("an inner pop comes back first, then the level around it", () => {
  const ts = [
    task("r"), task("g", { parent: "r" }), task("g1", { parent: "g" }), task("g2", { parent: "g" }),
    task("h", { parent: "r" }),
  ];
  // Merge g and h into a group, open it, pop g inside it, then pop the group.
  const merged = changed(merge(ts, emptyReorg(), "h", "g"));
  const inner = changed(pop(ts, merged, "g"));
  const outer = changed(pop(ts, inner, "new:g1"));
  assert.deepEqual(kids(ts, outer, "r"), ["g1", "g2", "h"]);
  const res = collapse(ts, outer);
  assert.deepEqual(res.restored, ["new:g1", "g"]);
  assert.deepEqual(toStructure(res.reorg), toStructure(merged));
});

test("a draft read back from the server lays over the tasks the same way", () => {
  const ts = tasks();
  const merged = changed(merge(ts, emptyReorg(), "d", "a"));
  const r = changed(pop(ts, merged, "c"));
  // As the server returns it: titles and attrs present on every node.
  const wire = JSON.parse(JSON.stringify(toStructure(r))) as ReturnType<typeof toStructure>;
  for (const n of wire.nodes) {
    n.attrs ??= {};
    (n as { title: string | null }).title ??= null;
  }
  const back = fromStructure(wire, ts, JSON.parse(JSON.stringify(extrasOf(r))));
  assert.deepEqual(toStructure(back), toStructure(r));
  assert.deepEqual(kids(ts, back, "r"), kids(ts, r, "r"));
  assert.equal(collapsible(ts, back), 1);
  assert.equal(back.counter, 2);
  // Without this tab's memory the structure is the same; only the order is a guess.
  const bare = fromStructure(wire, ts, null);
  assert.deepEqual(toStructure(bare), toStructure(r));
  assert.equal(bare.counter, 2);
});

test("a draft that refers to tasks that have gone is pruned", () => {
  const ts = tasks();
  const merged = changed(merge(ts, emptyReorg(), "d", "a"));
  const later = ts.map(t => (t.id === "d" ? { ...t, state: "discarded" as const } : t));
  const back = fromStructure(toStructure(merged), later, null);
  assert.ok(isEmptyReorg(back));
});

test("touchedIds names everything the draft moves, makes or removes", () => {
  const ts = tasks();
  const r = changed(pop(ts, changed(merge(ts, emptyReorg(), "d", "a")), "c"));
  assert.deepEqual([...touchedIds(r)].sort(), ["a", "c", "c1", "c2", "c3", "d", "new:g1"]);
});
