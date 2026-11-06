// Bubble reorganisation, as a draft over the task tree (ADR 0003).
//
// The board shows `effectiveTasks(tasks, reorg)`: the database's tasks with the draft
// laid on top. Every operation here is pure (Reorg → Reorg). Nothing is written until
// the draft settles on the server and a translator turns it into edits. `toStructure`
// is what the server sees: the parent each touched task should end up with, the new
// tasks, and the tasks to remove. A draft that cancels out has no entries at all.
import type { Structure, Task } from "../../api";

export const NEW = "new:";
export const isNew = (id: string | null | undefined) => !!id && id.startsWith(NEW);

/** A popped level that Collapse can bring back while its parts are untouched. */
export interface PopRecord {
  id: string;
  children: string[];
  title: string;
  /** Created by this draft (a merge), rather than an existing task. */
  created: boolean;
  /** Its attribute overrides when popped, if it had any. */
  attrs?: Record<string, unknown>;
  forgotten?: string;
}

interface Entry {
  parent: string | null;
  /** New tasks only. */
  title?: string;
  attrs?: Record<string, unknown>;
  /** New tasks are listed just before this sibling, so a merge stays in place. */
  anchor?: string;
}

export interface Reorg {
  /** Intended parent (and attrs) for tasks that differ from the database, plus new tasks. */
  nodes: Map<string, Entry>;
  removed: Set<string>;
  memory: PopRecord[];
}

export const emptyReorg = (): Reorg => ({ nodes: new Map(), removed: new Set(), memory: [] });

const clone = (r: Reorg): Reorg => ({
  nodes: new Map([...r.nodes].map(([k, v]) => [k, { ...v, attrs: v.attrs && { ...v.attrs } }])),
  removed: new Set(r.removed),
  memory: r.memory.map(m => ({ ...m, children: [...m.children] })),
});

let counter = 0;
const newId = () => `${NEW}${Date.now().toString(36)}${(counter++).toString(36)}`;

const LIVE = new Set(["open", "done"]);

/** Read access to the tree as the draft would leave it. */
export class Tree {
  constructor(readonly base: Map<string, Task>, readonly r: Reorg) {}

  exists(id: string): boolean {
    if (isNew(id)) return this.r.nodes.has(id);
    const t = this.base.get(id);
    return !!t && LIVE.has(t.state) && !this.r.removed.has(id);
  }
  parentOf(id: string): string | null {
    const e = this.r.nodes.get(id);
    return e ? e.parent : this.base.get(id)?.parent_id ?? null;
  }
  title(id: string): string {
    return this.r.nodes.get(id)?.title ?? this.base.get(id)?.title ?? "?";
  }
  attrsOf(id: string): Record<string, unknown> {
    return { ...(this.base.get(id)?.attrs ?? {}), ...(this.r.nodes.get(id)?.attrs ?? {}) };
  }
  ids(): string[] {
    return [...this.base.keys(), ...[...this.r.nodes.keys()].filter(isNew)].filter(id => this.exists(id));
  }
  children(id: string): string[] {
    return this.ids().filter(c => this.parentOf(c) === id);
  }
  rootOf(id: string): string {
    const seen = new Set<string>();
    for (let p = this.parentOf(id); p !== null && !seen.has(id); p = this.parentOf(id)) {
      seen.add(id);
      id = p;
    }
    return id;
  }
}

/** Point `id` at `parent`. An override that matches the database is dropped. */
function setParent(t: Tree, id: string, parent: string | null, attrs?: Record<string, unknown>) {
  const e = t.r.nodes.get(id);
  if (isNew(id)) {
    t.r.nodes.set(id, { ...e!, parent, ...(attrs ? { attrs: { ...e?.attrs, ...attrs } } : {}) });
    return;
  }
  const base = t.base.get(id);
  const merged = attrs ? { ...e?.attrs, ...attrs } : e?.attrs;
  const changedAttrs = merged && Object.entries(merged).some(([k, v]) => base?.attrs[k] !== v);
  if (base?.parent_id === parent && !changedAttrs) t.r.nodes.delete(id);
  else t.r.nodes.set(id, { parent, ...(changedAttrs ? { attrs: merged } : {}) });
}

/**
 * A group made by this draft dissolves once it holds one bubble or none; the bubble
 * takes its place. Existing tasks never dissolve: a task with one subtask is a task.
 */
function dissolveThin(t: Tree, id: string | null): string[] {
  const gone: string[] = [];
  while (id !== null && isNew(id) && t.children(id).length <= 1) {
    const parent = t.parentOf(id);
    for (const c of t.children(id)) setParent(t, c, parent);
    t.r.nodes.delete(id);
    gone.push(id);
    id = parent;
  }
  return gone;
}

function forget(t: Tree, ids: string[], reason: string) {
  for (const rec of t.r.memory) {
    if (!rec.forgotten && rec.children.some(c => ids.includes(c))) rec.forgotten = reason;
  }
}

export type Op =
  | { op: "merge"; dragged: string; target: string; group: string }
  | { op: "insert"; dragged: string; into: string }
  | { op: "to_root"; dragged: string }
  | { op: "pop"; group: string }
  | { op: "collapse"; restored: string[] };

export type Result = { reorg: Reorg; op: Op };

/** Where bubbles may go: only within the root task they're already under. */
export const canJoin = (t: Tree, x: string, target: string) =>
  x !== target && t.rootOf(x) === t.rootOf(target) && !isInside(t, target, x);

/** Is `id` at or below `ancestor`? */
export function isInside(t: Tree, id: string, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | null = id; cur !== null && !seen.has(cur); cur = t.parentOf(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
  }
  return false;
}

/** Drop `x` on bubble `y`: a new task takes y's place, holding y then x. */
export function merge(base: Map<string, Task>, r0: Reorg, x: string, y: string): Result {
  const t = new Tree(base, clone(r0));
  const reason = `${t.title(x)} merged with ${t.title(y)}`;
  const from = t.parentOf(x);
  const gid = newId();
  // Detach x first: if that dissolves x's old group, y moves up a level. Only then
  // make the new group in y's (current) place, so it can't count as a sibling.
  setParent(t, x, null);
  const dissolved = dissolveThin(t, from);
  t.r.nodes.set(gid, { parent: t.parentOf(y), title: `${t.title(y)} + ${t.title(x)}`, anchor: y });
  setParent(t, y, gid);
  setParent(t, x, gid);
  forget(t, [x, y, ...dissolved], reason);
  return { reorg: t.r, op: { op: "merge", dragged: x, target: y, group: gid } };
}

/** Drop `x` into the open area of `g`. */
export function insert(base: Map<string, Task>, r0: Reorg, x: string, g: string): Result {
  const t = new Tree(base, clone(r0));
  const reason = `${t.title(x)} moved into ${t.title(g)}`;
  const from = t.parentOf(x);
  setParent(t, x, g);
  const dissolved = dissolveThin(t, from);
  forget(t, [x, ...dissolved], reason);
  return { reorg: t.r, op: { op: "insert", dragged: x, into: g } };
}

/** Drop `x` on empty board: a root task, staying in its old root's wedge. */
export function toRoot(base: Map<string, Task>, r0: Reorg, x: string): Result {
  const t = new Tree(base, clone(r0));
  const reason = `${t.title(x)} was pulled out`;
  const from = t.parentOf(x);
  const old = t.attrsOf(t.rootOf(x));
  const mine = t.attrsOf(x);
  const inherit: Record<string, unknown> = {};
  for (const k of ["category", "section"]) if (mine[k] === undefined && old[k] !== undefined) inherit[k] = old[k];
  setParent(t, x, null, Object.keys(inherit).length ? inherit : undefined);
  const dissolved = dissolveThin(t, from);
  forget(t, [x, ...dissolved], reason);
  return { reorg: t.r, op: { op: "to_root", dragged: x } };
}

/** Pop `g` one level: its subtasks take its place, and it's remembered. */
export function pop(base: Map<string, Task>, r0: Reorg, g: string): Result {
  const t = new Tree(base, clone(r0));
  const children = t.children(g);
  const parent = t.parentOf(g);
  const entry = t.r.nodes.get(g);
  t.r.memory.push({ id: g, children, title: t.title(g), created: isNew(g), attrs: entry?.attrs });
  for (const c of children) setParent(t, c, parent);
  t.r.nodes.delete(g);
  if (!isNew(g)) t.r.removed.add(g);
  return { reorg: t.r, op: { op: "pop", group: g } };
}

/**
 * Bring back every remembered pop whose parts are untouched and still side by side,
 * innermost first. Restoring one can make an outer one possible, hence the fixpoint.
 * Whatever is left can't come back, so memory is cleared.
 */
export function collapse(base: Map<string, Task>, r0: Reorg): Result & { restored: string[] } {
  const t = new Tree(base, clone(r0));
  const restored: string[] = [];
  for (let progress = true; progress;) {
    progress = false;
    for (let i = t.r.memory.length - 1; i >= 0; i--) {
      const rec = t.r.memory[i];
      if (rec.forgotten || !rec.children.every(c => t.exists(c))) continue;
      const parents = new Set(rec.children.map(c => t.parentOf(c)));
      if (parents.size !== 1) continue;
      const [parent] = parents;
      if (rec.created) {
        t.r.nodes.set(rec.id, { parent, title: rec.title, anchor: rec.children[0], ...(rec.attrs ? { attrs: rec.attrs } : {}) });
      } else {
        t.r.removed.delete(rec.id);
        setParent(t, rec.id, parent, rec.attrs);
      }
      for (const c of rec.children) setParent(t, c, rec.id);
      t.r.memory.splice(i, 1);
      restored.push(rec.id);
      progress = true;
    }
  }
  t.r.memory = [];
  return { reorg: t.r, op: { op: "collapse", restored }, restored };
}

/** What Collapse would bring back right now. */
export const wouldRestore = (base: Map<string, Task>, r: Reorg) => new Set(collapse(base, r).restored);

export const isNoop = (r: Reorg) => r.nodes.size === 0 && r.removed.size === 0;

export function toStructure(r: Reorg): Structure {
  return {
    nodes: [...r.nodes].map(([id, e]) => ({
      id,
      parent: e.parent,
      ...(isNew(id) ? { title: e.title } : {}),
      ...(e.attrs ? { attrs: e.attrs } : {}),
    })),
    removed: [...r.removed],
  };
}

/** Rebuild a draft from the server (pop memory is presentation, so it isn't kept). */
export function fromStructure(s: Structure): Reorg {
  return {
    nodes: new Map(s.nodes.map(n => [n.id, {
      parent: n.parent,
      ...(n.title ? { title: n.title } : {}),
      ...(n.attrs ? { attrs: n.attrs } : {}),
    }])),
    removed: new Set(s.removed),
    memory: [],
  };
}

/** The tasks as the draft would leave them. New tasks sit just before their anchor. */
export function effectiveTasks(tasks: Task[], r: Reorg): Task[] {
  const now = new Date(0).toISOString();
  const made = [...r.nodes].filter(([id]) => isNew(id)).map(([id, e]): [Entry, Task] => [e, {
    id, parent_id: e.parent, title: e.title ?? "group", state: "open",
    attrs: { ...e.attrs }, created_at: now, updated_at: now, version: 0,
  }]);
  const placed = new Set<string>();
  const out: Task[] = [];
  for (const t of tasks) {
    for (const [e, m] of made) if (e.anchor === t.id && !placed.has(m.id)) { out.push(m); placed.add(m.id); }
    if (r.removed.has(t.id)) continue;
    const e = r.nodes.get(t.id);
    out.push(e ? { ...t, parent_id: e.parent, attrs: { ...t.attrs, ...e.attrs } } : t);
  }
  for (const [, m] of made) if (!placed.has(m.id)) out.push(m);
  return out;
}
