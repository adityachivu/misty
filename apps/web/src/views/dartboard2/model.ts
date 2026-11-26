// The board's model: the tasks with the reorganisation draft laid over them, as a
// tree, and what the board reads off that tree (deadlines, rings, counts). Pure.

import type { Task, TaskState } from "../../api";
import { asDate, ringFor, type Ring } from "./dates";

export const NEW = "new:";
export const isNew = (id: string): boolean => id.startsWith(NEW);

export const CATEGORIES = ["uni", "work", "projects", "admin"] as const;
export type Category = (typeof CATEGORIES)[number];

/** A level the user dissolved, remembered so that "collapse" can bring it back. */
export interface PopRecord {
  id: string;
  /** Set when the popped group was one the draft itself had made. */
  title: string | null;
  /** The parent the popped task had, and its subtasks got. */
  parent: string;
  children: string[];
  /** Order keys the subtasks (and the task) had before, to put back. */
  anchors: [string, string | null][];
}

/**
 * A reorganisation in progress: how the intended structure differs from the database.
 * `parent`, `created`, `attrs` and `removed` are what is sent as the draft's `after`;
 * `anchor` and `pops` are presentation (sibling order, and what collapse can restore).
 */
export interface Reorg {
  /** Intended parent of every task whose parent differs, and of every new group. */
  parent: Map<string, string | null>;
  /** New groups: `new:<label>` → title. */
  created: Map<string, string>;
  /** Attributes a task takes on (a subtask that becomes a root keeps its category). */
  attrs: Map<string, Record<string, unknown>>;
  /** Existing tasks the draft discards. */
  removed: Set<string>;
  /** Sibling order keys that differ from the default. */
  anchor: Map<string, string>;
  pops: PopRecord[];
  /** Next unused `new:g<n>` number. */
  counter: number;
}

export function emptyReorg(): Reorg {
  return {
    parent: new Map(), created: new Map(), attrs: new Map(),
    removed: new Set(), anchor: new Map(), pops: [], counter: 1,
  };
}

export function cloneReorg(r: Reorg): Reorg {
  return {
    parent: new Map(r.parent),
    created: new Map(r.created),
    attrs: new Map([...r.attrs].map(([k, v]) => [k, { ...v }])),
    removed: new Set(r.removed),
    anchor: new Map(r.anchor),
    pops: r.pops.map(p => ({ ...p, children: [...p.children], anchors: p.anchors.map(a => [...a] as [string, string | null]) })),
    counter: r.counter,
  };
}

/** Nothing would change: no moves, no new groups, nothing removed. */
export function isEmptyReorg(r: Reorg): boolean {
  return r.parent.size === 0 && r.created.size === 0 && r.removed.size === 0;
}

export interface Node {
  id: string;
  title: string;
  state: TaskState;
  attrs: Record<string, unknown>;
  /** Parent with the draft applied. */
  parent: string | null;
  /** Parent in the database; undefined for a group that exists only in the draft. */
  dbParent: string | null | undefined;
  isNew: boolean;
  /** The draft discards it. */
  removed: boolean;
  /** The draft moved or made it. */
  moved: boolean;
  /** Sibling order. */
  key: string;
  /** Every child, in order, whatever its state. */
  children: string[];
}

export interface Tree {
  nodes: Map<string, Node>;
  /** Parentless nodes, in order, whatever their state. */
  roots: string[];
}

const baseKey = (t: Task): string => `${t.created_at}|${t.id}`;

export function buildTree(tasks: readonly Task[], reorg: Reorg = emptyReorg()): Tree {
  const nodes = new Map<string, Node>();
  for (const t of tasks) {
    const extra = reorg.attrs.get(t.id);
    nodes.set(t.id, {
      id: t.id,
      title: t.title,
      state: t.state,
      attrs: extra ? { ...t.attrs, ...extra } : t.attrs,
      parent: reorg.parent.has(t.id) ? reorg.parent.get(t.id)! : t.parent_id,
      dbParent: t.parent_id,
      isNew: false,
      removed: reorg.removed.has(t.id),
      moved: reorg.parent.has(t.id),
      key: reorg.anchor.get(t.id) ?? baseKey(t),
      children: [],
    });
  }
  for (const [id, title] of reorg.created) {
    nodes.set(id, {
      id, title, state: "open",
      attrs: reorg.attrs.get(id) ?? {},
      parent: reorg.parent.get(id) ?? null,
      dbParent: undefined,
      isNew: true, removed: false, moved: true,
      key: "", children: [],
    });
  }
  const roots: string[] = [];
  for (const n of nodes.values()) {
    // A parent that isn't in the data can't hold anything: draw the task at the top.
    if (n.parent !== null && !nodes.has(n.parent)) n.parent = null;
    if (n.parent === null) roots.push(n.id);
    else nodes.get(n.parent)!.children.push(n.id);
  }
  // A new group has no creation time: it sits where its earliest part would,
  // unless the gesture that made it gave it a place (an anchor).
  const keyOf = (id: string, seen: Set<string>): string => {
    const n = nodes.get(id)!;
    if (n.key || seen.has(id)) return n.key || `~${id}`;
    seen.add(id);
    const anchored = reorg.anchor.get(id);
    const least = n.children.map(c => keyOf(c, seen)).sort()[0];
    n.key = anchored ?? least ?? `~${id}`;
    return n.key;
  };
  for (const n of nodes.values()) if (n.isNew) keyOf(n.id, new Set());
  const order = (a: string, b: string): number => {
    const ka = nodes.get(a)!.key, kb = nodes.get(b)!.key;
    return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };
  for (const n of nodes.values()) n.children.sort(order);
  roots.sort(order);
  return { nodes, roots };
}

/** Not discarded, in the database or by the draft. */
export const isLive = (n: Node): boolean => !n.removed && n.state !== "discarded";

/** Bubbles are drawn for open and done tasks only. */
export const isDrawable = (n: Node): boolean => !n.removed && (n.state === "open" || n.state === "done");

export function drawnChildren(tree: Tree, id: string): Node[] {
  const n = tree.nodes.get(id);
  if (!n) return [];
  return n.children.map(c => tree.nodes.get(c)!).filter(isDrawable);
}

export function liveChildren(tree: Tree, id: string): Node[] {
  const n = tree.nodes.get(id);
  if (!n) return [];
  return n.children.map(c => tree.nodes.get(c)!).filter(isLive);
}

/** `id`'s ancestors, nearest first. */
export function ancestors(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let at = tree.nodes.get(id)?.parent ?? null;
  while (at !== null && !seen.has(at)) {
    out.push(at);
    seen.add(at);
    at = tree.nodes.get(at)?.parent ?? null;
  }
  return out;
}

export function rootOf(tree: Tree, id: string): string {
  const up = ancestors(tree, id);
  return up.length ? up[up.length - 1] : id;
}

/** `id` and everything under it, whatever its state. */
export function subtree(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (at: string): void => {
    if (seen.has(at) || !tree.nodes.has(at)) return;
    seen.add(at);
    out.push(at);
    for (const c of tree.nodes.get(at)!.children) walk(c);
  };
  walk(id);
  return out;
}

/** The task's own deadline: its date, unless that is only when it is scheduled. */
export function ownDue(n: Node): string | null {
  if (n.attrs.date_kind === "scheduled") return null;
  return asDate(n.attrs.date);
}

export interface Due {
  date: string;
  /** The task whose deadline it is: the task itself or an open subtask. */
  by: string;
}

/**
 * The earliest open deadline at or under a task: its own, or that of any open subtask
 * at any depth. Done subtasks, and everything under them, don't count.
 */
export function earliestDue(tree: Tree, id: string): Due | null {
  const top = tree.nodes.get(id);
  if (!top) return null;
  const own = ownDue(top);
  let best: Due | null = own ? { date: own, by: id } : null;
  const seen = new Set<string>([id]);
  const walk = (n: Node): void => {
    for (const cid of n.children) {
      const c = tree.nodes.get(cid)!;
      if (seen.has(cid) || c.removed || c.state !== "open") continue;
      seen.add(cid);
      const d = ownDue(c);
      if (d && (!best || d < best.date)) best = { date: d, by: cid };
      walk(c);
    }
  };
  walk(top);
  return best;
}

export function placement(tree: Tree, id: string, today: string): { ring: Ring; due: Due | null } {
  const due = earliestDue(tree, id);
  return { ring: ringFor(due ? due.date : null, today), due };
}

/** Open subtasks under a task at any depth, as far as bubbles can be opened to reach them. */
export function openCount(tree: Tree, id: string): number {
  let n = 0;
  const seen = new Set<string>([id]);
  const walk = (at: string): void => {
    for (const c of drawnChildren(tree, at)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.state === "open") n++;
      walk(c.id);
    }
  };
  walk(id);
  return n;
}

/**
 * The roots the board knows about: open ones, and done ones touched this session
 * (so that undo can reach a task that was just completed).
 */
export function boardRoots(tree: Tree, changed: ReadonlySet<string>): Node[] {
  return tree.roots
    .map(id => tree.nodes.get(id)!)
    .filter(n => !n.removed && (n.state === "open" || (n.state === "done" && changed.has(n.id))));
}

/** The changed tasks and all their ancestors: the bubbles that get a halo. */
export function withAncestors(tree: Tree, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (!tree.nodes.has(id)) continue;
    out.add(id);
    for (const a of ancestors(tree, id)) out.add(a);
  }
  return out;
}

/**
 * What a discard of `id` has to discard, deepest first and ending with `id`: the task
 * and everything under it in the database that isn't discarded already (released
 * subtasks too, though they aren't drawn).
 */
export function discardOrder(tasks: readonly Task[], id: string): string[] {
  const kids = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parent_id === null) continue;
    const list = kids.get(t.parent_id);
    if (list) list.push(t); else kids.set(t.parent_id, [t]);
  }
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (at: string): void => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const c of kids.get(at) ?? []) walk(c.id);
    const t = byId.get(at);
    if (t && t.state !== "discarded") out.push(at);
  };
  walk(id);
  return out;
}

/**
 * Every task at or under `id`, in the database or with the draft applied, whatever its
 * state: the tasks whose session edits "undo" on that bubble takes back.
 */
export function scopeOf(tasks: readonly Task[], tree: Tree, id: string): Set<string> {
  const out = new Set<string>(subtree(tree, id));
  const kids = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.parent_id === null) continue;
    const list = kids.get(t.parent_id);
    if (list) list.push(t.id); else kids.set(t.parent_id, [t.id]);
  }
  const walk = (at: string, seen: Set<string>): void => {
    if (seen.has(at)) return;
    seen.add(at);
    out.add(at);
    for (const c of kids.get(at) ?? []) walk(c, seen);
  };
  walk(id, new Set());
  return out;
}

/** 0 uni (upper left), 1 work (upper right), 2 projects (lower right), 3 admin (lower left). */
export function quadrantOf(n: Node): number {
  const at = (CATEGORIES as readonly unknown[]).indexOf(n.attrs.category);
  if (at >= 0) return at;
  // No category: anywhere in its ring, but always the same place for the same task.
  let h = 2166136261;
  for (let i = 0; i < n.id.length; i++) h = Math.imul(h ^ n.id.charCodeAt(i), 16777619);
  return (h >>> 0) % 4;
}

export function sectionsIn(tasks: readonly Task[], category: string): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    if (t.state === "discarded" || t.attrs.category !== category) continue;
    const s = t.attrs.section;
    if (typeof s === "string" && s.trim()) out.add(s.trim());
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Titles are one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
