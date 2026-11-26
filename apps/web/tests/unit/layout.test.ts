import { test } from "node:test";
import assert from "node:assert/strict";
import { RINGS, type Ring } from "../../src/views/dartboard2/dates.ts";
import {
  BASE, closedDiameter, flower, layoutBoard, quadrantStart, rimArc, rimTop, ringAt, RIM,
  type RootSpec,
} from "../../src/views/dartboard2/layout.ts";

/** A small deterministic generator, so the "random" boards are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function specs(n: number, seed: number): RootSpec[] {
  const next = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    ring: RINGS[Math.floor(next() * RINGS.length)],
    quadrant: Math.floor(next() * 4),
    d: closedDiameter(0, Math.floor(next() * 12), next() < 0.1, false),
  }));
}

test("size: base × min(1.7, sqrt(1 + 0.25 n)), one size on request, done smaller", () => {
  assert.equal(closedDiameter(0, 0, false, false), 96);
  assert.ok(Math.abs(closedDiameter(0, 4, false, false) - 96 * Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(closedDiameter(0, 8, false, false) - 96 * 1.7) < 1e-9);
  assert.ok(Math.abs(closedDiameter(0, 500, false, false) - 96 * 1.7) < 1e-9);
  assert.equal(closedDiameter(0, 8, false, true), 96);
  assert.equal(closedDiameter(1, 0, false, false), 60);
  assert.equal(closedDiameter(2, 0, false, false), 44);
  assert.equal(closedDiameter(9, 0, false, false), 44); // below three levels, reuse the last
  assert.ok(closedDiameter(0, 8, true, false) < 96);
  assert.deepEqual([...BASE], [96, 60, 44]);
});

test("the same roots always land in the same places", () => {
  const a = layoutBoard(specs(120, 7));
  const b = layoutBoard(specs(120, 7));
  assert.deepEqual(a.bands, b.bands);
  assert.deepEqual([...a.at], [...b.at]);
});

test("no two bubbles overlap, and each is inside its band and its quadrant", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const list = specs(160, seed);
    const board = layoutBoard(list);
    const band = new Map(board.bands.map(b => [b.ring, b]));
    for (let i = 0; i < list.length; i++) {
      const s = list[i], p = board.at.get(s.id)!;
      const dist = Math.hypot(p.x, p.y);
      const b = band.get(s.ring)!;
      assert.ok(dist - s.d / 2 >= b.inner - 1e-6, `${s.id} pokes inside ${s.ring}`);
      // Overdue stays small; its bubbles are allowed to spill outwards.
      if (s.ring !== "overdue") assert.ok(dist + s.d / 2 <= b.outer + 1e-6, `${s.id} pokes outside ${s.ring}`);
      // Inside its quadrant: clear of both axes.
      assert.ok(Math.abs(p.x) >= s.d / 2 && Math.abs(p.y) >= s.d / 2, `${s.id} crosses an axis`);
      const angle = (Math.atan2(p.y, p.x) + 2 * Math.PI) % (2 * Math.PI);
      const start = quadrantStart(s.quadrant) % (2 * Math.PI);
      assert.ok(angle >= start && angle <= start + Math.PI / 2, `${s.id} is in the wrong quadrant`);
      for (let j = 0; j < i; j++) {
        const o = list[j], q = board.at.get(o.id)!;
        assert.ok(
          Math.hypot(p.x - q.x, p.y - q.y) >= (s.d + o.d) / 2 - 1e-6,
          `${s.id} overlaps ${o.id} (seed ${seed})`,
        );
      }
    }
  }
});

test("overdue stays small however full it is, and what spills is not overlapped", () => {
  const empty = layoutBoard([]).bands[0];
  const crowd: RootSpec[] = [];
  for (let i = 0; i < 12; i++) crowd.push({ id: `o${i}`, ring: "overdue", quadrant: i % 2, d: 96 });
  for (let i = 0; i < 6; i++) crowd.push({ id: `t${i}`, ring: "today", quadrant: i % 2, d: 96 });
  const board = layoutBoard(crowd);
  assert.deepEqual(board.bands[0], empty);
  assert.ok(empty.outer <= 100);
  const reach = (id: string) => { const p = board.at.get(id)!; return Math.hypot(p.x, p.y) + 48; };
  assert.ok(crowd.some(s => s.ring === "overdue" && reach(s.id) > empty.outer), "the crowd spills");
  for (const [i, s] of crowd.entries()) {
    for (const o of crowd.slice(0, i)) {
      const p = board.at.get(s.id)!, q = board.at.get(o.id)!;
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= 96 - 1e-6, `${s.id} overlaps ${o.id}`);
    }
  }
  // Today still holds its own bubbles.
  for (const s of crowd.filter(s => s.ring === "today")) assert.ok(reach(s.id) <= board.bands[1].outer + 1e-6);
});

test("bands run from the centre outwards without overlapping, and today's is the roomiest", () => {
  for (const list of [[], specs(30, 11), specs(300, 12)]) {
    const { bands } = layoutBoard(list);
    assert.deepEqual(bands.map(b => b.ring), [...RINGS]);
    assert.equal(bands[0].inner, 0);
    for (let i = 1; i < bands.length; i++) assert.ok(bands[i].inner > bands[i - 1].outer);
    const width = (r: Ring) => { const b = bands.find(x => x.ring === r)!; return b.outer - b.inner; };
    for (const r of RINGS) if (r !== "today") assert.ok(width("today") > width(r), `today is narrower than ${r}`);
  }
});

test("a crowded far ring grows; it doesn't squeeze the bubbles", () => {
  const many: RootSpec[] = Array.from({ length: 60 }, (_, i) => ({ id: `l${i}`, ring: "later", quadrant: 1, d: 96 }));
  const board = layoutBoard(many);
  const later = board.bands[5];
  assert.ok(later.outer - later.inner > 150);
  for (const s of many) assert.ok(Math.hypot(board.at.get(s.id)!.x, board.at.get(s.id)!.y) + 48 <= later.outer);
});

test("ringAt: gaps belong to the nearer ring, and past the edge is off the board", () => {
  const { bands } = layoutBoard([]);
  const [overdue, today] = bands;
  assert.equal(ringAt(bands, 0)!.ring, "overdue");
  assert.equal(ringAt(bands, overdue.outer + 1)!.ring, "overdue");
  assert.equal(ringAt(bands, today.inner - 1)!.ring, "today");
  assert.equal(ringAt(bands, today.inner - 1)!.across, 0);
  assert.ok(Math.abs(ringAt(bands, (today.inner + today.outer) / 2)!.across - 0.5) < 1e-9);
  const last = bands[bands.length - 1];
  assert.equal(ringAt(bands, last.outer)!.ring, "later");
  assert.equal(ringAt(bands, last.outer)!.across, 1);
  assert.equal(ringAt(bands, last.outer + 100), null);
});

test("flower: petals touch nothing, clear the core and stay inside the rim", () => {
  for (const radii of [[30], [30, 30], [30, 22, 50, 30, 30], Array<number>(14).fill(30), [150, 30, 30, 22, 22, 22]]) {
    const core = 60;
    const f = flower(core, radii);
    radii.forEach((r, i) => {
      const dist = Math.hypot(f.at[i].x, f.at[i].y);
      assert.ok(dist - r >= core - 1e-6, "a petal covers the name");
      assert.ok(dist + r <= f.radius - RIM + 1e-6, "a petal reaches the rim");
      for (let j = 0; j < i; j++) {
        const gap = Math.hypot(f.at[i].x - f.at[j].x, f.at[i].y - f.at[j].y);
        assert.ok(gap >= r + radii[j] - 1e-6, `petals ${i} and ${j} overlap`);
      }
    });
  }
});

test("flower: the first petal is at the top, and an empty bubble still grows", () => {
  const f = flower(60, [30, 30, 30]);
  assert.ok(Math.abs(f.at[0].x) < 1e-9 && f.at[0].y < 0);
  assert.equal(flower(60, []).radius, 60 + RIM);
  assert.equal(flower(60, [], 200).radius, 200);
});

test("rim controls: + at the top; the rest on the bottom arc, centred on the lowest point", () => {
  assert.deepEqual(rimTop(100), { x: 0, y: -100 });
  for (const n of [1, 2, 3, 4]) {
    const pts = rimArc(n, 100);
    assert.equal(pts.length, n);
    for (const p of pts) {
      assert.ok(Math.abs(Math.hypot(p.x, p.y) - 100) < 1e-9, "not on the rim");
      assert.ok(p.y > 0, "not on the bottom arc");
    }
    for (let i = 1; i < n; i++) assert.ok(pts[i].x > pts[i - 1].x, "not left to right");
    const sum = pts.reduce((a, p) => a + p.x, 0);
    assert.ok(Math.abs(sum) < 1e-9, "not centred on the lowest point");
    for (let i = 1; i < n; i++) {
      assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) >= 24, "controls overlap");
    }
  }
});
