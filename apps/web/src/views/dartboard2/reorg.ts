// The reorganisation gestures, as pure functions from one draft state to the next,
// and the translation of that state to and from the server's `Structure` (ADR 0003).
// Nothing here writes: the sync layer sends the result as a draft.

import type { Structure, StructureNode, Task } from "../../api";
import {
  ancestors, buildTree, cloneReorg, emptyReorg, isLive, isNew, liveChildren, rootOf,
  type PopRecord, type Reorg,
} from "./model";

/** One paragraph for whoever translates the draft's ops into edits. */
export const VOCABULARY =
  "Ops are gestures on a board where every task is a bubble and its subtasks are bubbles inside it. " +
  "Ids are task ids; `new:g<n>` names a group task this draft creates. " +
  "merge {dragged, target, group, title}: put `target` and `dragged` together under a new task `group` " +
  "titled `title`, which takes the target's place under the target's parent. " +
  "move {task, into}: make `task` a subtask of `into`. " +
  "to_root {task, attrs}: make `task` a top-level task and give it `attrs` (the category and section of " +
  "the root it came from, where it had none of its own). " +
  "pop {task, subtasks, into}: dissolve `task`: its `subtasks` become subtasks of `into`, its parent, and " +
  "`task` itself is discarded. " +
  "collapse {restored}: take back the pops of the listed tasks, so their subtasks are under them again. " +
  "A group left holding one task or none is dissolved without an op of its own. " +
  "`after` is always the net structure intended once every op so far has been applied.";

export const DIFFERENT_ROOT = "bubbles only merge within the same root task";
export const NESTED_POP =
  "can't dissolve two nested levels in one reorganisation · apply this one first";

export type Outcome =
  | { kind: "changed"; reorg: Reorg; op: Record<string, unknown> }
  | { kind: "refused"; message: string }
  | { kind: "nothing" };

const NOTHING: Outcome = { kind: "nothing" };
const refused = (message: string): Outcome => ({ kind: "refused", message });

/**
 * Bring a draft state back to its simplest form against the current tasks:
 * - forget anything that refers to a task that no longer exists or is discarded;
 * - dissolve groups the draft made that hold one bubble or none (the bubble takes the
 *   group's place); existing tasks never dissolve;
 * - forget "moves" that leave a task where the database already has it.
 * Mutates and returns `r`.
 */
export function normalise(tasks: readonly Task[], r: Reorg): Reorg {
  const db = new Map(tasks.map(t => [t.id, t]));
  const exists = (id: string): boolean =>
    isNew(id) ? r.created.has(id) : db.has(id) && db.get(id)!.state !== "discarded";

  for (const id of [...r.removed]) if (!exists(id)) r.removed.delete(id);
  for (const id of r.removed) { r.parent.delete(id); r.attrs.delete(id); }
  for (const [id, p] of [...r.parent]) {
    if (!exists(id)) r.parent.delete(id);
    else if (p !== null && (!exists(p) || r.removed.has(p))) {
      if (isNew(id)) r.parent.set(id, null); else r.parent.delete(id);
    }
  }
  for (const id of [...r.created.keys()]) if (!r.parent.has(id)) r.parent.set(id, null);

  for (let again = true; again;) {
    again = false;
    for (const group of [...r.created.keys()]) {
      const kids = [...r.parent].filter(([, p]) => p === group).map(([id]) => id);
      if (kids.length > 1) continue;
      if (kids.length === 1) {
        const place = r.anchor.get(group);
        r.parent.set(kids[0], r.parent.get(group) ?? null);
        if (place !== undefined) r.anchor.set(kids[0], place);
      }
      r.created.delete(group);
      r.parent.delete(group);
      r.attrs.delete(group);
      r.anchor.delete(group);
      again = true;
    }
  }

  for (const [id, p] of [...r.parent]) {
    if (!isNew(id) && db.get(id)!.parent_id === p) r.parent.delete(id);
  }
  // Attributes are only ever given to a task the draft makes a root.
  for (const id of [...r.attrs.keys()]) {
    if (!(r.parent.has(id) && r.parent.get(id) === null)) r.attrs.delete(id);
  }
  // Places are kept even for a bubble that is back under its own parent: a popped
  // group's parts stay where the group was, which is what lets collapse restore it.
  for (const id of [...r.anchor.keys()]) if (!exists(id)) r.anchor.delete(id);
  return r;
}

/** The draft's `after`: every task whose parent differs, new groups, and removals. */
export function toStructure(r: Reorg): Structure {
  const nodes: StructureNode[] = [...r.parent.keys()].sort().map(id => {
    const node: StructureNode = { id, parent: r.parent.get(id)! };
    if (isNew(id)) node.title = r.created.get(id) ?? "group";
    const attrs = r.attrs.get(id);
    if (attrs && Object.keys(attrs).length) node.attrs = { ...attrs };
    return node;
  });
  return { nodes, removed: [...r.removed].sort() };
}

/** What this tab remembers about a draft beyond its structure. */
export interface ReorgExtras {
  anchor: [string, string][];
  pops: PopRecord[];
  counter: number;
}

export function extrasOf(r: Reorg): ReorgExtras {
  return { anchor: [...r.anchor], pops: r.pops, counter: r.counter };
}

/** Lay a draft read back from the server over the tasks. */
export function fromStructure(
  structure: Structure, tasks: readonly Task[], extras?: ReorgExtras | null,
): Reorg {
  const r = emptyReorg();
  for (const n of structure.nodes ?? []) {
    r.parent.set(n.id, n.parent ?? null);
    if (isNew(n.id)) {
      r.created.set(n.id, n.title || "group");
      const num = /^new:g(\d+)$/.exec(n.id);
      if (num) r.counter = Math.max(r.counter, Number(num[1]) + 1);
    }
    if (n.attrs && Object.keys(n.attrs).length) r.attrs.set(n.id, { ...n.attrs });
  }
  for (const id of structure.removed ?? []) r.removed.add(id);
  if (extras) {
    for (const [id, key] of extras.anchor) r.anchor.set(id, key);
    r.pops = extras.pops.map(p => ({ ...p }));
    r.counter = Math.max(r.counter, extras.counter);
  }
  return normalise(tasks, r);
}

/** Every task the draft moves, makes or removes. */
export function touchedIds(r: Reorg): Set<string> {
  return new Set<string>([...r.parent.keys(), ...r.created.keys(), ...r.removed]);
}

export function sameStructure(a: Reorg, b: Reorg): boolean {
  return JSON.stringify(toStructure(a)) === JSON.stringify(toStructure(b));
}

// ─── gestures ────────────────────────────────────────────────────────────────

/** Drop `dragged` on the closed subtask `target`: a new group takes the target's place. */
export function merge(tasks: readonly Task[], r: Reorg, dragged: string, target: string): Outcome {
  const tree = buildTree(tasks, r);
  const d = tree.nodes.get(dragged), t = tree.nodes.get(target);
  if (!d || !t || dragged === target) return NOTHING;
  if (d.parent === null) return NOTHING;
  if (t.parent === null || rootOf(tree, dragged) !== rootOf(tree, target)) return refused(DIFFERENT_ROOT);
  if (ancestors(tree, target).includes(dragged) || ancestors(tree, dragged).includes(target)) {
    return refused("a bubble can't merge with one it is inside");
  }
  const next = cloneReorg(r);
  const group = `new:g${next.counter++}`;
  const title = `${t.title} + ${d.title}`;
  next.created.set(group, title);
  next.parent.set(group, t.parent);
  next.anchor.set(group, t.key);
  next.parent.set(target, group);
  next.parent.set(dragged, group);
  normalise(tasks, next);
  return { kind: "changed", reorg: next, op: { op: "merge", dragged, target, group, title } };
}

/** Drop `dragged` inside the open bubble `into`: it becomes a subtask there. */
export function moveInto(tasks: readonly Task[], r: Reorg, dragged: string, into: string): Outcome {
  const tree = buildTree(tasks, r);
  const d = tree.nodes.get(dragged), p = tree.nodes.get(into);
  if (!d || !p || d.parent === null || d.parent === into) return NOTHING;
  if (rootOf(tree, dragged) !== rootOf(tree, into)) return refused(DIFFERENT_ROOT);
  if (into === dragged || ancestors(tree, into).includes(dragged)) {
    return refused("a bubble can't go inside itself");
  }
  if (!isLive(p)) return NOTHING;
  const next = cloneReorg(r);
  next.parent.set(dragged, into);
  next.anchor.delete(dragged);
  normalise(tasks, next);
  return { kind: "changed", reorg: next, op: { op: "move", task: dragged, into } };
}

/** Drop `dragged` on empty board: it becomes a root, keeping its old root's quadrant. */
export function makeRoot(tasks: readonly Task[], r: Reorg, dragged: string): Outcome {
  const tree = buildTree(tasks, r);
  const d = tree.nodes.get(dragged);
  if (!d || d.parent === null) return NOTHING;
  const root = tree.nodes.get(rootOf(tree, dragged))!;
  const attrs: Record<string, unknown> = {};
  for (const key of ["category", "section"]) {
    if (d.attrs[key] === undefined && root.attrs[key] !== undefined) attrs[key] = root.attrs[key];
  }
  const next = cloneReorg(r);
  next.parent.set(dragged, null);
  next.anchor.delete(dragged);
  if (Object.keys(attrs).length) next.attrs.set(dragged, attrs); else next.attrs.delete(dragged);
  normalise(tasks, next);
  return { kind: "changed", reorg: next, op: { op: "to_root", task: dragged, attrs } };
}

/**
 * Dissolve a level: the subtasks of `id` take its place under its parent, and `id` is
 * to be discarded. Every subtask that isn't discarded moves, drawn or not, because the
 * server won't discard a task that still holds one.
 */
export function pop(tasks: readonly Task[], r: Reorg, id: string): Outcome {
  const tree = buildTree(tasks, r);
  const p = tree.nodes.get(id);
  if (!p || p.parent === null || !isLive(p)) return NOTHING;
  const kids = liveChildren(tree, id);
  if (!kids.length) return NOTHING;
  if (!p.isNew) {
    // The stand-in translator plans discards against the tasks as they are now, so it
    // refuses to remove a task whose database parent or subtask is also being removed.
    const parentGoes = typeof p.dbParent === "string" && r.removed.has(p.dbParent);
    const childGoes = tasks.some(t => t.parent_id === id && r.removed.has(t.id));
    if (parentGoes || childGoes) return refused(NESTED_POP);
  }
  const next = cloneReorg(r);
  const record: PopRecord = {
    id,
    title: p.isNew ? p.title : null,
    parent: p.parent,
    children: kids.map(k => k.id),
    anchors: [id, ...kids.map(k => k.id)].map(x => [x, r.anchor.get(x) ?? null]),
  };
  for (const k of kids) {
    next.parent.set(k.id, p.parent);
    next.anchor.set(k.id, `${p.key}/${k.key}`);
  }
  next.parent.delete(id);
  next.attrs.delete(id);
  next.anchor.delete(id);
  if (p.isNew) next.created.delete(id); else next.removed.add(id);
  next.pops.push(record);
  normalise(tasks, next);
  return {
    kind: "changed", reorg: next,
    op: { op: "pop", task: id, subtasks: record.children, into: p.parent },
  };
}

/** Whether a popped level can come back: its parts untouched and still side by side. */
function restorable(tasks: readonly Task[], r: Reorg, rec: PopRecord): boolean {
  const tree = buildTree(tasks, r);
  const parent = tree.nodes.get(rec.parent);
  if (!parent || !isLive(parent)) return false;
  const self = tree.nodes.get(rec.id);
  if (rec.title !== null) {
    if (self) return false;
  } else if (!self || !self.removed || self.state === "discarded") {
    return false;
  }
  for (const c of rec.children) {
    const n = tree.nodes.get(c);
    if (!n || !isLive(n) || n.parent !== rec.parent) return false;
  }
  const siblings = liveChildren(tree, rec.parent).map(n => n.id);
  const at = rec.children.map(c => siblings.indexOf(c)).sort((a, b) => a - b);
  return at.length > 0 && at[at.length - 1] - at[0] === at.length - 1;
}

function restore(tasks: readonly Task[], r: Reorg, rec: PopRecord): Reorg {
  const next = cloneReorg(r);
  if (rec.title !== null) next.created.set(rec.id, rec.title);
  else next.removed.delete(rec.id);
  next.parent.set(rec.id, rec.parent);
  for (const c of rec.children) next.parent.set(c, rec.id);
  for (const [id, key] of rec.anchors) {
    if (key === null) next.anchor.delete(id); else next.anchor.set(id, key);
  }
  next.pops = next.pops.filter(p => p.id !== rec.id);
  return normalise(tasks, next);
}

/**
 * Bring back every popped level that can come back, most recent first, repeating
 * until nothing more can. The pops that can't are forgotten.
 */
export function collapse(tasks: readonly Task[], r: Reorg): { reorg: Reorg; restored: string[] } {
  let cur = r;
  const restored: string[] = [];
  for (;;) {
    let hit: PopRecord | null = null;
    for (let i = cur.pops.length - 1; i >= 0 && !hit; i--) {
      if (restorable(tasks, cur, cur.pops[i])) hit = cur.pops[i];
    }
    if (!hit) break;
    cur = restore(tasks, cur, hit);
    restored.push(hit.id);
  }
  const reorg = cloneReorg(cur);
  reorg.pops = [];
  return { reorg, restored };
}

/** How many groups "collapse" would restore. */
export function collapsible(tasks: readonly Task[], r: Reorg): number {
  return r.pops.length ? collapse(tasks, r).restored.length : 0;
}
