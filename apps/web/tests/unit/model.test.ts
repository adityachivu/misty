import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boardRoots, buildTree, discardOrder, drawnChildren, earliestDue, emptyReorg, oneLine, openCount,
  placement, quadrantOf, scopeOf, sectionsIn, withAncestors,
} from "../../src/views/dartboard2/model.ts";
import { task, TODAY } from "./helpers.ts";

const due = (date: string) => ({ date });

test("children are drawn when open or done, in creation order", () => {
  const tree = buildTree([
    task("r"),
    task("a", { parent: "r" }),
    task("b", { parent: "r", state: "done" }),
    task("c", { parent: "r", state: "released" }),
    task("d", { parent: "r", state: "discarded" }),
    task("e", { parent: "r" }),
  ]);
  assert.deepEqual(drawnChildren(tree, "r").map(n => n.id), ["a", "b", "e"]);
  assert.deepEqual(tree.nodes.get("r")!.children, ["a", "b", "c", "d", "e"]);
});

test("a root sits at its earliest open deadline, its own or a subtask's at any depth", () => {
  const tree = buildTree([
    task("r", { attrs: due("2026-07-30") }),
    task("a", { parent: "r" }),
    task("a1", { parent: "a", attrs: due("2026-07-16") }),
    task("b", { parent: "r", attrs: due("2026-07-20") }),
  ]);
  assert.deepEqual(earliestDue(tree, "r"), { date: "2026-07-16", by: "a1" });
  assert.equal(placement(tree, "r", TODAY).ring, "tomorrow");
  assert.deepEqual(earliestDue(tree, "b"), { date: "2026-07-20", by: "b" });
});

test("done subtasks, and everything under them, don't count; nor do scheduled dates", () => {
  const tree = buildTree([
    task("r", { attrs: { date: "2026-07-15", date_kind: "scheduled" } }),
    task("a", { parent: "r", state: "done", attrs: due("2026-07-01") }),
    task("a1", { parent: "a", attrs: due("2026-07-02") }),
    task("b", { parent: "r", state: "released", attrs: due("2026-07-03") }),
    task("c", { parent: "r", attrs: { date: "2026-07-04", date_kind: "scheduled" } }),
  ]);
  assert.equal(earliestDue(tree, "r"), null);
  assert.equal(placement(tree, "r", TODAY).ring, "later");
});

test("a task's own date wins a tie with a subtask's", () => {
  const tree = buildTree([
    task("r", { attrs: due("2026-07-16") }),
    task("a", { parent: "r", attrs: due("2026-07-16") }),
  ]);
  assert.equal(earliestDue(tree, "r")!.by, "r");
});

test("openCount counts open subtasks at any depth", () => {
  const tree = buildTree([
    task("r"),
    task("a", { parent: "r" }),
    task("a1", { parent: "a" }),
    task("a2", { parent: "a", state: "done" }),
    task("b", { parent: "r", state: "done" }),
    task("b1", { parent: "b" }),
    task("c", { parent: "r", state: "released" }),
    task("c1", { parent: "c" }),
  ]);
  assert.equal(openCount(tree, "r"), 3); // a, a1, b1; nothing under the released c
  assert.equal(openCount(tree, "a"), 1);
});

test("the board's roots: open ones, and done ones changed this session", () => {
  const tasks = [
    task("open"), task("done", { state: "done" }), task("done2", { state: "done" }),
    task("gone", { state: "discarded" }), task("let-go", { state: "released" }),
    task("sub", { parent: "open" }),
  ];
  const tree = buildTree(tasks);
  assert.deepEqual(boardRoots(tree, new Set(["done2"])).map(n => n.id), ["open", "done2"]);
});

test("discardOrder is deepest first, includes released, skips what is already discarded", () => {
  const tasks = [
    task("r"),
    task("a", { parent: "r" }),
    task("a1", { parent: "a", state: "released" }),
    task("a2", { parent: "a", state: "discarded" }),
    task("b", { parent: "r", state: "done" }),
    task("other"),
  ];
  const order = discardOrder(tasks, "r");
  assert.deepEqual([...order].sort(), ["a", "a1", "b", "r"]);
  assert.equal(order[order.length - 1], "r");
  assert.ok(order.indexOf("a1") < order.indexOf("a"));
});

test("scopeOf and withAncestors reach discarded subtasks", () => {
  const tasks = [task("r"), task("a", { parent: "r" }), task("a1", { parent: "a", state: "discarded" })];
  const tree = buildTree(tasks);
  assert.deepEqual([...scopeOf(tasks, tree, "a")].sort(), ["a", "a1"]);
  assert.deepEqual([...withAncestors(tree, ["a1"])].sort(), ["a", "a1", "r"]);
});

test("quadrants: by category, and always the same place without one", () => {
  const tree = buildTree([
    task("u", { attrs: { category: "uni" } }), task("w", { attrs: { category: "work" } }),
    task("p", { attrs: { category: "projects" } }), task("a", { attrs: { category: "admin" } }),
    task("none"),
  ]);
  const q = (id: string) => quadrantOf(tree.nodes.get(id)!);
  assert.deepEqual([q("u"), q("w"), q("p"), q("a")], [0, 1, 2, 3]);
  assert.equal(q("none"), q("none"));
  assert.ok(q("none") >= 0 && q("none") < 4);
});

test("the draft is laid over the tasks", () => {
  const tasks = [task("r"), task("a", { parent: "r" }), task("b", { parent: "r" }), task("c", { parent: "r" })];
  const reorg = emptyReorg();
  reorg.created.set("new:g1", "b + c");
  reorg.parent.set("new:g1", "r");
  reorg.parent.set("b", "new:g1");
  reorg.parent.set("c", "new:g1");
  reorg.removed.add("a");
  const tree = buildTree(tasks, reorg);
  assert.deepEqual(drawnChildren(tree, "r").map(n => n.id), ["new:g1"]);
  assert.deepEqual(drawnChildren(tree, "new:g1").map(n => n.id), ["b", "c"]);
  assert.equal(tree.nodes.get("b")!.moved, true);
  assert.equal(tree.nodes.get("new:g1")!.isNew, true);
  assert.equal(tree.nodes.get("a")!.removed, true);
  // A group with no place of its own sits where its earliest part would.
  assert.equal(tree.nodes.get("new:g1")!.key, tree.nodes.get("b")!.key);
});

test("sections used in a category, and one-line titles", () => {
  const tasks = [
    task("a", { attrs: { category: "uni", section: "thesis" } }),
    task("b", { attrs: { category: "uni", section: "admin" } }),
    task("c", { attrs: { category: "work", section: "ops" } }),
    task("d", { attrs: { category: "uni", section: "old" }, state: "discarded" }),
  ];
  assert.deepEqual(sectionsIn(tasks, "uni"), ["admin", "thesis"]);
  assert.equal(oneLine("  a\n b\t c  "), "a b c");
});
