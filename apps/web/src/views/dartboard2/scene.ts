// The scene: everything the view draws, and where, as one pure function of the data
// and the UI state. The view never decides a position; it copies this to the DOM, and
// pointer hits are resolved against it rather than against elements in mid-transition.

import type { Task } from "../../api";
import { asDate, mmdd, NEAR_RINGS, RINGS, type Ring } from "./dates";
import {
  CORE, CORE_WITH_FIELD, FIELD_RADIUS, closedDiameter, depth, flower, layoutBoard, rimArc, rimTop,
  type Band, type RootSpec,
} from "./layout";
import {
  boardRoots, buildTree, drawnChildren, earliestDue, isDrawable, isNew, openCount, placement,
  quadrantOf, withAncestors, type Node, type Reorg, type Tree,
} from "./model";
import { DIFFERENT_ROOT, touchedIds } from "./reorg";

/** What the user has open and switched on. With the tasks, it decides the whole board. */
export interface UiState {
  /** The open bubbles: a root, then the subtask open inside it, and so on. */
  chain: string[];
  /** The open bubble a new subtask is being typed into, if any. */
  adding: string | null;
  /** The root whose "pick a date" field is showing, if any. */
  dating: string | null;
  showLater: boolean;
  oneSize: boolean;
}

export interface Bubble {
  id: string;
  x: number;
  y: number;
  r: number;
  /** 0 for a root, 1 for its subtasks, … */
  level: number;
  open: boolean;
  /** Radius of the area the label must fit in. */
  labelR: number;
  /** Radius of the name area of an open bubble (clicking it closes; around it pops). */
  core: number;
  root: boolean;
  rootId: string;
  parent: string | null;
  ring: Ring | null;
  title: string;
  /** The meta line; only open bubbles show it. */
  meta: string;
  category: string | null;
  done: boolean;
  overdue: boolean;
  quick: boolean;
  hasSubs: boolean;
  halo: boolean;
  /** Moved or made by the reorganisation in progress. */
  draft: boolean;
  /** Exists only in the draft. */
  isNew: boolean;
  /** In a ring the short view hides, drawn anyway. */
  faded: boolean;
  dating: boolean;
  z: number;
}

export type ControlKind = "add" | "quick" | "complete" | "discard" | "undo";

export interface Control {
  key: string;
  kind: ControlKind;
  id: string;
  x: number;
  y: number;
  /** For toggles: whether it is on. */
  on: boolean;
  z: number;
}

export interface Field {
  key: string;
  kind: "new" | "date";
  /** The bubble it belongs to: the parent of the new subtask, or the root being dated. */
  id: string;
  x: number;
  y: number;
  r: number;
  level: number;
  z: number;
}

export interface Hud {
  /** Open root tasks. */
  roots: number;
  perRing: Record<Ring, number>;
  /** Roots not drawn because the short view hides their ring. */
  hidden: number;
  /** Roots in the rings the short view hides. */
  later: number;
}

export interface Scene {
  today: string;
  bands: Band[];
  radius: number;
  bubbles: Bubble[];
  byId: Map<string, Bubble>;
  controls: Control[];
  fields: Field[];
  hud: Hud;
}

export interface SceneInput {
  tree: Tree;
  ui: UiState;
  today: string;
  /** Tasks this session's edits touched. */
  changed: ReadonlySet<string>;
  /** Those and their ancestors. */
  halo: ReadonlySet<string>;
  /** Tasks the reorganisation touches, and their ancestors. */
  touched: ReadonlySet<string>;
}

/** The halo and "touched by the draft" sets, with ancestors before and after the draft. */
export function marks(
  tasks: readonly Task[], tree: Tree, reorg: Reorg, changed: ReadonlySet<string>,
): { halo: Set<string>; touched: Set<string> } {
  const before = buildTree(tasks);
  const both = (ids: Iterable<string>): Set<string> => {
    const list = [...ids];
    const out = withAncestors(tree, list);
    for (const id of withAncestors(before, list)) out.add(id);
    return out;
  };
  return { halo: both(changed), touched: both(touchedIds(reorg)) };
}

/** The longest prefix of `chain` that can still be open. */
export function validChain(tree: Tree, chain: readonly string[], changed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const n = tree.nodes.get(chain[i]);
    if (!n || !isDrawable(n)) break;
    if (i === 0) {
      if (n.parent !== null || !(n.state === "open" || changed.has(n.id))) break;
    } else if (n.parent !== out[i - 1]) break;
    out.push(n.id);
  }
  return out;
}

/** `section · 📅 MM-DD` (or ⏳ for scheduled, or "no date") `· subtask due MM-DD`. */
export function metaLine(tree: Tree, n: Node): string {
  const parts: string[] = [];
  const section = n.attrs.section;
  if (typeof section === "string" && section.trim()) parts.push(section.trim());
  const date = asDate(n.attrs.date);
  parts.push(date ? `${n.attrs.date_kind === "scheduled" ? "⏳" : "📅"} ${mmdd(date)}` : "no date");
  const due = earliestDue(tree, n.id);
  if (due && due.by !== n.id) parts.push(`subtask due ${mmdd(due.date)}`);
  return parts.join(" · ");
}

/** Room around an open bubble for the controls on its rim. */
const CONTROL_MARGIN = 13;

interface Plan {
  node: Node;
  level: number;
  r: number;
  core: number;
  petals: ({ kind: "closed"; node: Node; r: number } | { kind: "open"; plan: Plan } | { kind: "field"; r: number })[];
  at: { x: number; y: number }[];
}

export function buildScene(input: SceneInput): Scene {
  const { tree, ui, today, changed, halo, touched } = input;
  const chain = ui.chain;
  const bubbles: Bubble[] = [];
  const controls: Control[] = [];
  const fields: Field[] = [];

  const size = (n: Node, level: number): number =>
    closedDiameter(level, openCount(tree, n.id), n.state === "done", ui.oneSize);

  const describe = (
    n: Node, level: number, rootId: string, ring: Ring | null, faded: boolean,
  ): Omit<Bubble, "x" | "y" | "r" | "open" | "labelR" | "core" | "meta" | "dating" | "z"> => {
    const due = earliestDue(tree, n.id);
    return {
      id: n.id, level, root: level === 0, rootId, parent: n.parent, ring,
      title: n.title,
      // A subtask without a category of its own is coloured like its root.
      category: [n.attrs.category, tree.nodes.get(rootId)?.attrs.category]
        .find((c): c is string => typeof c === "string") ?? null,
      done: n.state === "done",
      overdue: n.state === "open" && (ring ? ring === "overdue" : due !== null && due.date < today),
      quick: n.attrs.quick === true,
      hasSubs: drawnChildren(tree, n.id).length > 0,
      halo: halo.has(n.id),
      draft: n.moved,
      isNew: n.isNew,
      faded,
    };
  };

  const plan = (n: Node, level: number): Plan => {
    const next = chain[level + 1];
    const petals: Plan["petals"] = drawnChildren(tree, n.id).map(k =>
      k.id === next
        ? { kind: "open", plan: plan(k, level + 1) }
        : { kind: "closed", node: k, r: size(k, level + 1) / 2 });
    if (ui.adding === n.id) petals.push({ kind: "field", r: FIELD_RADIUS[depth(level)] });
    const core = level === 0 && ui.dating === n.id ? CORE_WITH_FIELD : CORE[depth(level)];
    const radii = petals.map(p => (p.kind === "open" ? p.plan.r + CONTROL_MARGIN : p.r));
    const f = flower(core, radii, size(n, level) / 2 + 14);
    return { node: n, level, r: f.radius, core, petals, at: f.at };
  };

  const emit = (p: Plan, x: number, y: number, rootId: string, ring: Ring | null, faded: boolean): void => {
    const n = p.node;
    const dating = p.level === 0 && ui.dating === n.id;
    const z = 10 + p.level * 2;
    bubbles.push({
      ...describe(n, p.level, rootId, ring, faded),
      x, y, r: p.r, open: true, core: p.core,
      labelR: dating ? p.core - 26 : p.core - 2,
      meta: metaLine(tree, n), dating, z,
    });
    if (!n.isNew) {
      if (ui.adding !== n.id) {
        const top = rimTop(p.r);
        controls.push({ key: `${n.id}:add`, kind: "add", id: n.id, x: x + top.x, y: y + top.y, on: false, z: z + 1 });
      }
      const kinds: ControlKind[] = ["quick"];
      if (n.state === "open") kinds.push("complete");
      kinds.push("discard");
      if (halo.has(n.id)) kinds.push("undo");
      rimArc(kinds.length, p.r).forEach((at, i) => {
        controls.push({
          key: `${n.id}:${kinds[i]}`, kind: kinds[i], id: n.id,
          x: x + at.x, y: y + at.y, on: kinds[i] === "quick" && n.attrs.quick === true, z: z + 1,
        });
      });
    }
    if (dating) {
      fields.push({ key: `date:${n.id}`, kind: "date", id: n.id, x, y: y + 30, r: p.core, level: p.level, z: z + 1 });
    }
    p.petals.forEach((petal, i) => {
      const px = x + p.at[i].x, py = y + p.at[i].y;
      if (petal.kind === "open") emit(petal.plan, px, py, rootId, null, false);
      else if (petal.kind === "closed") {
        bubbles.push({
          ...describe(petal.node, p.level + 1, rootId, null, false),
          x: px, y: py, r: petal.r, open: false, core: petal.r, labelR: petal.r - 5,
          meta: "", dating: false, z: z + 2,
        });
      } else {
        fields.push({ key: `new:${n.id}`, kind: "new", id: n.id, x: px, y: py, r: petal.r, level: p.level + 1, z: z + 3 });
      }
    });
  };

  // Roots, soonest deadline first within each cell. Every root is laid out, so that
  // hiding the far rings leaves the others exactly where they were.
  const roots = boardRoots(tree, changed);
  const placed = new Map(roots.map(n => [n.id, placement(tree, n.id, today)]));
  const ordered = [...roots].sort((a, b) => {
    const da = placed.get(a.id)!.due?.date ?? "9999-99-99";
    const dbb = placed.get(b.id)!.due?.date ?? "9999-99-99";
    return da < dbb ? -1 : da > dbb ? 1 : 0;
  });
  const specs: RootSpec[] = ordered.map(n => ({
    id: n.id, ring: placed.get(n.id)!.ring, quadrant: quadrantOf(n), d: size(n, 0),
  }));
  const board = layoutBoard(specs);

  const perRing = Object.fromEntries(RINGS.map(r => [r, 0])) as Record<Ring, number>;
  let hidden = 0, later = 0, open = 0;
  for (const n of ordered) {
    const ring = placed.get(n.id)!.ring;
    perRing[ring]++;
    if (n.state === "open") open++;
    const far = !NEAR_RINGS.includes(ring);
    if (far) later++;
    const isOpen = chain[0] === n.id;
    if (far && !ui.showLater && !(isOpen || halo.has(n.id) || touched.has(n.id))) {
      hidden++;
      continue;
    }
    const faded = far && !ui.showLater;
    const at = board.at.get(n.id)!;
    if (isOpen) emit(plan(n, 0), at.x, at.y, n.id, ring, faded);
    else {
      const r = size(n, 0) / 2;
      bubbles.push({
        ...describe(n, 0, n.id, ring, faded),
        x: at.x, y: at.y, r, open: false, core: r, labelR: r - 5, meta: "", dating: false, z: 1,
      });
    }
  }

  return {
    today, bands: board.bands, radius: board.radius,
    bubbles, byId: new Map(bubbles.map(b => [b.id, b])),
    controls, fields,
    hud: { roots: open, perRing, hidden, later },
  };
}

export type Hit =
  | { kind: "bubble"; id: string; open: boolean; inCore: boolean }
  | { kind: "field"; key: string };

/** What is at a point of the world: the topmost field or bubble, or nothing. */
export function hitTest(scene: Scene, x: number, y: number, skip?: string): Hit | null {
  for (const f of scene.fields) {
    if (f.kind === "new" && Math.hypot(x - f.x, y - f.y) <= f.r) return { kind: "field", key: f.key };
  }
  let best: Bubble | null = null;
  for (const b of scene.bubbles) {
    if (b.id === skip) continue;
    if (Math.hypot(x - b.x, y - b.y) > b.r) continue;
    if (!best || b.z > best.z) best = b;
  }
  if (!best) return null;
  return {
    kind: "bubble", id: best.id, open: best.open,
    inCore: Math.hypot(x - best.x, y - best.y) <= best.core,
  };
}

export type SubDrop =
  | { kind: "merge"; target: string; label: string }
  | { kind: "into"; parent: string; label: string }
  | { kind: "stay"; label: string }
  | { kind: "root"; label: string }
  | { kind: "refuse"; label: string };

/** What letting go of the subtask `dragged` at a point would do. */
export function subDrop(scene: Scene, dragged: string, x: number, y: number): SubDrop {
  const me = scene.byId.get(dragged);
  const hit = hitTest(scene, x, y, dragged);
  if (!me || hit?.kind === "field") return { kind: "stay", label: "cancel" };
  if (!hit) return { kind: "root", label: "make it a root task" };
  const b = scene.byId.get(hit.id)!;
  if (b.rootId !== me.rootId) return { kind: "refuse", label: DIFFERENT_ROOT };
  if (!hit.open) return { kind: "merge", target: b.id, label: `merge with "${b.title}"` };
  if (b.id === me.parent) return { kind: "stay", label: `stays in "${b.title}"` };
  return { kind: "into", parent: b.id, label: `move into "${b.title}"` };
}

/** Whether a root can be dragged onto a ring to reschedule it. */
export function canReschedule(b: Bubble): boolean {
  return b.root && !b.open && !b.done && !isNew(b.id);
}
