// Geometry, in closed form. Every position is computed from the inputs in one pass:
// there is no simulation and no state, so the same inputs always give the same board.
// World coordinates are pixels at zoom 1, origin at the board's centre, y downwards.

import { RINGS, type Ring } from "./dates";

export interface Point { x: number; y: number }

// ─── sizes ───────────────────────────────────────────────────────────────────

/** Closed diameters by depth: root, subtask, and everything below. */
export const BASE = [96, 60, 44] as const;
/** Radius of the name area in the middle of an open bubble, by depth. */
export const CORE = [64, 48, 40] as const;
/** A root showing its date field needs a wider middle. */
export const CORE_WITH_FIELD = 80;
export const MAX_GROWTH = 1.7;
export const DONE_SCALE = 0.72;
/** The bubble that holds the "new subtask" field, by depth of the new subtask. */
export const FIELD_RADIUS = [48, 44, 40] as const;

export const depth = (level: number): number => Math.min(Math.max(level, 0), 2);

/**
 * A closed bubble's diameter: `base × min(1.7, sqrt(1 + 0.25 n))` for n open subtasks
 * at any depth, or just `base` in one-size mode. Done bubbles are smaller.
 */
export function closedDiameter(level: number, openSubtasks: number, done: boolean, oneSize: boolean): number {
  const base = BASE[depth(level)];
  if (done) return base * DONE_SCALE;
  if (oneSize) return base;
  return base * Math.min(MAX_GROWTH, Math.sqrt(1 + 0.25 * Math.max(0, openSubtasks)));
}

// ─── the rings ───────────────────────────────────────────────────────────────

export interface Band { ring: Ring; inner: number; outer: number }

/** A root to place: which cell it belongs to and how big it is. Order is the caller's. */
export interface RootSpec { id: string; ring: Ring; quadrant: number; d: number }

export interface BoardLayout {
  bands: Band[];
  radius: number;
  at: Map<string, Point>;
}

/** Space between neighbouring bubbles. */
const GAP = 10;
/** Space between a bubble and its band's edge. */
const PAD = 12;
/** Space between bands. */
export const RING_GAP = 16;
/** Half the width of the empty strip along each axis, between quadrants. */
const GUTTER = 12;
/** Narrowest each band may be. Today's is the roomiest. */
const MIN_WIDTH: Record<Ring, number> = {
  overdue: 150, today: 200, tomorrow: 124, weekend: 124, month: 124, later: 124,
};
/** Today's band is at least this much wider than any other. */
const TODAY_LEAD = 1.1;

const QUARTER = Math.PI / 2;

/** Angle of a quadrant's first edge: 0 uni (upper left), then clockwise. */
export const quadrantStart = (q: number): number => Math.PI + QUARTER * q;

/** The angle a bubble of diameter `d` takes up at distance `rho` from the centre. */
const wedge = (d: number, rho: number, gap: number): number =>
  2 * Math.asin(Math.min(1, (d / 2 + gap / 2) / rho));

/** The angle a quadrant offers at distance `rho`, between its gutters. */
const span = (rho: number): number => QUARTER - 2 * Math.asin(Math.min(1, GUTTER / rho));

interface Row { rho: number; dmax: number; need: number; count: number }

/** The row that starts with bubble `from`, as close to the centre as `inner` allows. */
function rowFrom(ds: readonly number[], from: number, inner: number): Row {
  let best: Row | null = null;
  let dmax = 0;
  for (let count = 1; from + count <= ds.length; count++) {
    dmax = Math.max(dmax, ds[from + count - 1]);
    let rho = inner + dmax / 2;
    if (count === 1) {
      // Near the centre a quadrant is too narrow for even one bubble: move out.
      while (wedge(dmax, rho, GAP) > span(rho)) rho += 2;
    }
    let need = 0;
    for (let i = from; i < from + count; i++) need += wedge(ds[i], rho, GAP);
    if (need > span(rho)) break;
    best = { rho, dmax, need, count };
  }
  return best!;
}

/** Fill one cell (a quadrant of a band) row by row, outwards. */
function fillCell(ds: readonly number[], quadrant: number, inner: number): { at: Point[]; outer: number } {
  const at: Point[] = [];
  let edge = inner + PAD;
  let outer = inner;
  for (let i = 0; i < ds.length;) {
    const row = rowFrom(ds, i, edge);
    let angle = quadrantStart(quadrant) + QUARTER / 2 - row.need / 2;
    for (let j = i; j < i + row.count; j++) {
      const w = wedge(ds[j], row.rho, GAP);
      const theta = angle + w / 2;
      at.push({ x: row.rho * Math.cos(theta), y: row.rho * Math.sin(theta) });
      angle += w;
    }
    outer = row.rho + row.dmax / 2 + PAD;
    edge = row.rho + row.dmax / 2 + GAP;
    i += row.count;
  }
  return { at, outer };
}

/**
 * Place every root. Each band is as wide as its fullest quadrant needs (never
 * narrower than its minimum), and today's band is the widest. All roots take part,
 * drawn or not, so hiding a ring's bubbles never moves another bubble.
 */
export function layoutBoard(specs: readonly RootSpec[]): BoardLayout {
  const cells = new Map<string, RootSpec[]>();
  for (const s of specs) {
    const key = `${s.ring}/${s.quadrant}`;
    const cell = cells.get(key);
    if (cell) cell.push(s); else cells.set(key, [s]);
  }
  const run = (todayMin: number): BoardLayout => {
    const bands: Band[] = [];
    const at = new Map<string, Point>();
    let inner = 0;
    for (const ring of RINGS) {
      let outer = inner + (ring === "today" ? todayMin : MIN_WIDTH[ring]);
      for (let q = 0; q < 4; q++) {
        const cell = cells.get(`${ring}/${q}`);
        if (!cell) continue;
        const filled = fillCell(cell.map(s => s.d), q, inner);
        cell.forEach((s, i) => at.set(s.id, filled.at[i]));
        outer = Math.max(outer, filled.outer);
      }
      bands.push({ ring, inner, outer });
      inner = outer + RING_GAP;
    }
    return { bands, at, radius: bands[bands.length - 1].outer };
  };
  // Today's band must be the widest. Widening it pushes the other bands outwards,
  // where they need less width, so look for the narrowest today that still leads.
  const width = (b: Band): number => b.outer - b.inner;
  const lead = (l: BoardLayout): number =>
    width(l.bands[1]) - TODAY_LEAD * Math.max(...l.bands.filter(b => b.ring !== "today").map(width));
  let layout = run(MIN_WIDTH.today);
  if (lead(layout) < 0) {
    let lo = width(layout.bands[1]);
    let hi = Math.ceil(lo - lead(layout));
    layout = run(hi);
    while (lead(layout) < 0) layout = run((hi *= 1.25)); // not expected; keeps the search sound
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const tried = run(mid);
      if (lead(tried) >= 0) {
        hi = mid;
        layout = tried;
      } else {
        lo = mid;
      }
    }
  }
  return layout;
}

/**
 * The ring at a distance from the centre, and how far across it (0 inner … 1 outer).
 * Gaps between rings belong to the nearer ring. Past the outer edge is off the board.
 */
export function ringAt(bands: readonly Band[], dist: number): { ring: Ring; across: number } | null {
  const last = bands[bands.length - 1];
  if (!last || dist > last.outer + RING_GAP / 2) return null;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const next = bands[i + 1];
    const limit = next ? (b.outer + next.inner) / 2 : Infinity;
    if (dist < limit) {
      const across = (dist - b.inner) / (b.outer - b.inner);
      return { ring: b.ring, across: Math.min(1, Math.max(0, across)) };
    }
  }
  return null;
}

// ─── inside an open bubble ───────────────────────────────────────────────────

/** Space between the bubbles inside an open bubble, and around its name. */
const INNER_GAP = 6;
/** Space kept clear inside the rim, where the controls sit. */
export const RIM = 18;

export interface Flower {
  /** Radius of the open bubble that holds everything. */
  radius: number;
  /** Offsets of each petal's centre from the bubble's centre. */
  at: Point[];
}

/**
 * Arrange circles of the given radii around a core disc: each touches the core (or
 * the previous layer), the first sits at the top, and they go round clockwise, evenly
 * spread. When a layer is full the next one starts outside it.
 */
export function flower(core: number, radii: readonly number[], minRadius = 0): Flower {
  const at: Point[] = [];
  let inner = core + INNER_GAP;
  let extent = core;
  for (let i = 0; i < radii.length;) {
    const layer: { rho: number; w: number }[] = [];
    let sum = 0;
    for (; i < radii.length; i++) {
      const rho = inner + radii[i];
      const w = wedge(radii[i] * 2, rho, INNER_GAP);
      if (layer.length && sum + w > 2 * Math.PI) break;
      layer.push({ rho, w });
      sum += w;
    }
    const spread = Math.max(0, 2 * Math.PI - sum) / layer.length;
    let angle = -QUARTER - layer[0].w / 2;
    let reach = inner;
    layer.forEach((p, j) => {
      const theta = angle + p.w / 2;
      at.push({ x: p.rho * Math.cos(theta), y: p.rho * Math.sin(theta) });
      angle += p.w + spread;
      reach = Math.max(reach, p.rho + radii[i - layer.length + j]);
    });
    extent = Math.max(extent, reach);
    inner = reach + INNER_GAP;
  }
  return { radius: Math.max(extent + RIM, minRadius), at };
}

/** Distance between neighbouring controls, along the rim. */
const CONTROL_PITCH = 30;

/**
 * Where `count` controls sit on a rim of the given radius: along the bottom arc,
 * centred on the lowest point, left to right.
 */
export function rimArc(count: number, radius: number): Point[] {
  const step = Math.min(CONTROL_PITCH / radius, count > 1 ? Math.PI / (count - 1) / 1.5 : 1);
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const theta = QUARTER + ((count - 1) / 2 - i) * step;
    out.push({ x: radius * Math.cos(theta), y: radius * Math.sin(theta) });
  }
  return out;
}

/** The top of the rim, where "add a subtask" sits. */
export const rimTop = (radius: number): Point => ({ x: 0, y: -radius });
