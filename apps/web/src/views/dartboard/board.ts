// Dartboard: a spatial readout of the task database, ported from ~/code/dartboard.
//
// Quadrant = category. Radius = time horizon. Dashed border = not broken down yet.
// ⚡ = quick task. Geometry, physics, the focus chain and the controls are unchanged
// from the original; see its README for why they look the way they do.
//
// What changed is where it reads and writes. The original read Obsidian markdown and
// only *staged* deltas for misty to drain later, because a bug must never corrupt a
// task file. Here every gesture is a validated, recorded Misty edit, so it lands
// immediately. Edits are still one click from undone: the yellow halo now means
// "changed this session", and ↺ / reset all record `undo_edit`s for those edits.
import "./board.css";
import { CommandRejected, type Edit, type Task } from "../../api";
import type { ViewContext } from "../types";

export const DARTBOARD_TOOLS = [
  "create_task",
  "set_attributes",
  "unset_attributes",
  "complete_task",
  "undo_edit",
] as const;
type DartboardTool = (typeof DARTBOARD_TOOLS)[number];

// ─── identity hashing ──────────────────────────────────────────────────────────
// FNV-1a: deterministic across runs and machines. Angles use a continuous frac(),
// never `hash % N` — integer buckets collide, and two bubbles seeded on the exact
// same point never separate.
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const frac = (s: string) => hash(s) / 4294967296;

// ─── geometry ──────────────────────────────────────────────────────────────────
const W = 1800, H = 1800, CX = W / 2, CY = H / 2;

// Bands are annuli, not rings, and not equal width: thin rings can't fit a crowded
// band in a 90° wedge, and collision then shoves bubbles into the next quadrant.
// Containment applies to a bubble's CENTRE, not its edge.
type Band = "overdue" | "today" | "tomorrow" | "weekend" | "month" | "rim";
const BAND: Record<Band, [number, number]> = {
  overdue: [0, 70], today: [95, 330], tomorrow: [355, 440],
  weekend: [465, 600], month: [625, 700], rim: [725, 800],
};
const BAND_LBL: Record<Band, string> = {
  overdue: "overdue", today: "today", tomorrow: "tomorrow",
  weekend: "weekend", month: "month", rim: "later",
};
const CATEGORIES = ["work", "uni", "projects", "admin"] as const;
const QUAD: Record<string, number> = { uni: -135, work: -45, projects: 45, admin: 135 }; // wedge centres, degrees
const JITTER = 78, HALF_WEDGE = 43;

const MAX_DEPTH = 2; // root → subtask → sub-subtask

// Diameters by depth (index = depth). One click expands straight to `open`.
const D_IDLE = [96, 60, 44];
const D_OPEN = [340, 230, 165]; // floor for an open bubble with nothing inside
const D_DONE = [44, 30, 24];
const CHROME = [172, 120, 74]; // vertical room an open bubble needs for its own content

const K_RADIAL = 0.03, K_CENTER = 0.06, K_ANG_SOFT = 0.004, K_ANG_HARD = 0.055;
const K_COLLIDE = 0.35, DAMP = 0.85, KE_FLOOR = 0.02;
const ZOOM_MIN = 0.25, ZOOM_MAX = 4;

// ─── dates (local — toISOString is UTC and rolls over at the wrong hour) ──────
const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const short = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDate = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// ─── model ─────────────────────────────────────────────────────────────────────
interface BNode {
  id: string;
  text: string;
  depth: number;
  category: string | null;
  section: string;
  date: Date | null;
  dateType: "due" | "scheduled" | null;
  zap: boolean;
  done: boolean;
  pending: boolean; // changed this session, here or below
  chain: string[]; // ids root-first, ending with this one
  children: BNode[];
}
interface Root extends BNode {
  band: Band;
  r0: number; r1: number;
  homeRadius: number; homeAngle: number;
  r: number;
  x: number; y: number; vx: number; vy: number;
}

/** An edit made from this board this session, so it can be undone. */
interface Staged { seq: number; type: string; targets: string[] }

const SESSION_KEY = "misty.dartboard.session";

type Elems = ReturnType<typeof makeBubbleShell>;

const OPS = [
  { op: "today", glyph: "☀️", tip: "today", rootOnly: true },
  { op: "tomorrow", glyph: "➡️", tip: "tomorrow", rootOnly: true },
  { op: "weekend", glyph: "📅", tip: "weekend", rootOnly: true },
  { op: "later", glyph: "⏳", tip: "later — pick a date", rootOnly: true },
  { op: "zap", glyph: "⚡", tip: "quick task (≤15 min)", rootOnly: false },
  { op: "done", glyph: "✓", tip: "done", rootOnly: false },
  { op: "breakdown", glyph: "➕", tip: "break down", rootOnly: false },
  // only shown while this bubble (or anything under it) changed this session
  { op: "undo", glyph: "↺", tip: "undo this session's changes", rootOnly: false },
] as const;
type Op = (typeof OPS)[number]["op"];

const TEMPLATE = `
  <div id="viewport">
    <div id="camera">
      <svg id="chrome" aria-hidden="true"></svg>
      <div id="bubbles"></div>
    </div>
  </div>
  <header id="hud"></header>
  <div id="toolbar">
    <div class="tool-row">
      <button id="addBtn" class="tool-btn" title="add a task">+ add</button>
      <button id="resetBtn" class="tool-btn" title="undo every change made this session" hidden>↺ reset all</button>
    </div>
    <div id="addPanel" hidden>
      <div class="cat-row" id="catRow"></div>
      <input id="sectionInput" list="sectionOptions" placeholder="section (optional)…">
      <datalist id="sectionOptions"></datalist>
      <input id="textInput" placeholder="task text…">
      <div class="hint">↵ adds · esc closes</div>
    </div>
  </div>
  <div id="flash" hidden></div>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// A bare <input> reads to password managers as a login field, so they pop their
// prompt over the bubble. This is the union of switches that silences all of them.
function noAutofill(input: HTMLInputElement) {
  if (!input.type) input.type = "text";
  input.autocomplete = "off";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.spellcheck = false;
  input.name = "dartboard-field";
  input.setAttribute("data-1p-ignore", "");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-bwignore", "");
  input.setAttribute("data-form-type", "other");
}

/** The shell every bubble shares — root and subtask alike. A kid IS a bubble. */
function makeBubbleShell() {
  const g = el("div", "bubble");
  const body = el("div", "body");
  const zap = el("div", "zap", "⚡");
  const text = el("div", "text");
  const meta = el("div", "meta");
  const kids = el("div", "kids");
  const row = el("div", "emoji-row");
  const inv = el("div", "invite");
  const input = el("input");
  input.placeholder = "break it down…";
  noAutofill(input);
  inv.append(input, el("div", "hint", "↵ adds · esc closes"));
  // The ⏳ panel is inline, not prompt(): a native modal blocks the thread and its
  // Escape leaks to the window handler, collapsing the bubble being edited.
  const pick = el("div", "datepick");
  const dinput = el("input");
  dinput.type = "date";
  noAutofill(dinput);
  pick.append(dinput, el("div", "hint", "sets ⏳ · esc closes"));
  const btns = new Map<Op, HTMLButtonElement>();
  for (const op of OPS) {
    const b = el("button", "emoji", op.glyph);
    b.dataset.op = op.op;
    b.title = op.tip;
    row.appendChild(b);
    btns.set(op.op, b);
  }
  body.append(zap, text, meta, kids, inv, pick, row);
  g.appendChild(body);
  return { g, text, meta, kids, row, zap, input, inv, pick, dinput, btns };
}

export function mountDartboard(container: HTMLElement, ctx: ViewContext<DartboardTool>): () => void {
  const ac = new AbortController();
  const on = { signal: ac.signal };
  container.classList.add("dartboard");
  container.innerHTML = TEMPLATE;
  const $ = <T extends Element = HTMLElement>(id: string) => container.querySelector(`#${id}`) as T;
  const viewport = $("viewport"), camera = $("camera"), bubbles = $("bubbles"), hud = $("hud");
  const chrome = $<SVGSVGElement>("chrome");

  // ─── state ───────────────────────────────────────────────────────────────────
  let nodes: Root[] = [];
  // The focus is a CHAIN: opening a subtask leaves its parent open around it.
  let focusPath: string[] = [];
  let datePickFor: string | null = null;
  const gfx = new Map<string, Elems>();
  let today = new Date(), tomorrow = today, nextSat = today, monthOut = today;

  const session: { id: string; staged: Staged[] } = (() => {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "");
      if (typeof s?.id === "string" && Array.isArray(s.staged)) return s;
    } catch { /* first load */ }
    return { id: crypto.randomUUID(), staged: [] };
  })();
  const saveSession = () => sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));

  function stampClock() {
    today = new Date(); today.setHours(0, 0, 0, 0);
    tomorrow = addDays(today, 1);
    nextSat = addDays(today, (6 - today.getDay() + 7) % 7); // 0 if today is Saturday
    monthOut = addDays(today, 31);
  }

  // First match wins, so bands collapse gracefully (on a Saturday, `today` wins).
  function bandOf(n: BNode): Band {
    if (n.dateType === "scheduled" || !n.date) return "rim"; // intention, not deadline
    const d = n.date;
    if (d < today) return "overdue";
    if (+d === +today) return "today";
    if (+d === +tomorrow) return "tomorrow";
    if (d <= nextSat) return "weekend";
    if (d <= monthOut) return "month";
    return "rim";
  }

  const tail = () => focusPath[focusPath.length - 1] ?? null;
  const stateOf = (n: BNode) => (focusPath.includes(n.id) ? "open" : "idle");
  const canDecompose = (n: BNode) => n.depth < MAX_DEPTH;
  const subtreeIds = (n: BNode): string[] => [n.id, ...n.children.flatMap(subtreeIds)];
  const walk = (n: BNode, id: string): BNode | null =>
    n.id === id ? n : n.children.reduce<BNode | null>((a, c) => a ?? walk(c, id), null);
  const findNode = (id: string) => { for (const r of nodes) { const f = walk(r, id); if (f) return f; } return null; };

  // ─── tasks → nodes ───────────────────────────────────────────────────────────
  function build(tasks: Task[]) {
    const touched = new Set(session.staged.flatMap(s => s.targets));
    const completedHere = new Set(
      session.staged.filter(s => s.type === "task.completed").flatMap(s => s.targets),
    );
    const byParent = new Map<string | null, Task[]>();
    for (const t of tasks) {
      const list = byParent.get(t.parent_id) ?? [];
      list.push(t);
      byParent.set(t.parent_id, list);
    }
    // A done root stays on the board (faded) only if it was completed here, this
    // session, so ↺ can still reach it. Subtasks show done ones, like the original.
    const rootVisible = (t: Task) => t.state === "open" || (t.state === "done" && completedHere.has(t.id));
    const kidVisible = (t: Task) => t.state === "open" || t.state === "done";

    const makeNode = (t: Task, depth: number, parentChain: string[]): BNode => {
      const a = t.attrs;
      const date = typeof a.date === "string" ? toDate(a.date) : null;
      const node: BNode = {
        id: t.id, text: t.title, depth,
        category: typeof a.category === "string" ? a.category : null,
        section: typeof a.section === "string" ? a.section : "",
        date, dateType: date ? (a.date_kind === "scheduled" ? "scheduled" : "due") : null,
        zap: a.quick === true, done: t.state === "done", pending: false,
        chain: [...parentChain, t.id], children: [],
      };
      if (depth < MAX_DEPTH) {
        node.children = (byParent.get(t.id) ?? []).filter(kidVisible)
          .map(k => makeNode(k, depth + 1, node.chain));
      }
      node.pending = touched.has(t.id) || node.children.some(c => c.pending);
      return node;
    };

    const prev = new Map(nodes.map(n => [n.id, n]));
    nodes = (byParent.get(null) ?? []).filter(rootVisible).map(t => {
      const old = prev.get(t.id);
      const n = makeNode(t, 0, []) as Root;
      // positions carry over, so a changed band reads as the bubble swimming there
      Object.assign(n, old ? { x: old.x, y: old.y, vx: old.vx, vy: old.vy } : { x: NaN, y: NaN, vx: 0, vy: 0 });
      return n;
    });
    layout();
    for (const n of nodes) {
      if (Number.isNaN(n.x)) { // new: deterministic seed at its home position
        n.x = CX + Math.cos(n.homeAngle) * n.homeRadius;
        n.y = CY + Math.sin(n.homeAngle) * n.homeRadius;
      }
    }
    // a focused task that's gone (e.g. undone) takes what's inside it with it
    const gone = focusPath.findIndex(id => !findNode(id));
    if (gone !== -1) focusPath = focusPath.slice(0, gone);
  }

  /** Band, home and size for each root, from its date and the current focus. */
  function layout() {
    for (const n of nodes) {
      n.band = bandOf(n);
      [n.r0, n.r1] = BAND[n.band];
      n.homeRadius = (n.r0 + n.r1) / 2;
      // An uncategorised task (e.g. captured by an agent) has no wedge: it lives
      // anywhere in its band until it is given a category.
      const deg = n.category && n.category in QUAD
        ? QUAD[n.category] + frac(n.id) * JITTER - JITTER / 2
        : frac(n.id) * 360;
      n.homeAngle = (deg * Math.PI) / 180;
      n.r = diamOf(n) / 2;
    }
  }

  // An open bubble must fit its (possibly open) children, so size resolves bottom-up.
  function diamOf(n: BNode): number {
    const d = Math.min(n.depth, MAX_DEPTH);
    if (stateOf(n) === "idle") return n.done ? D_DONE[d] : D_IDLE[d];
    // area-based pack: √(Σ kid areas) is the side of the square they'd tile;
    // ×1.7 is slack for flex-wrap gaps and the circle's unusable corners.
    const area = n.children.reduce((a, k) => a + diamOf(k) ** 2, 0);
    return Math.max(D_OPEN[d], Math.sqrt(area) * 1.7 + CHROME[d]);
  }

  // ─── physics ─────────────────────────────────────────────────────────────────
  function tick() {
    const halfWedge = (HALF_WEDGE * Math.PI) / 180;
    for (const n of nodes) {
      const dx = n.x - CX, dy = n.y - CY;
      const r = Math.hypot(dx, dy) || 0.001;
      const urx = dx / r, ury = dy / r;
      // radial: hard containment at the annulus edges, weak centering inside
      let dr;
      if (r < n.r0) dr = (n.r0 - r) * K_RADIAL;
      else if (r > n.r1) dr = (n.r1 - r) * K_RADIAL;
      else dr = (n.homeRadius - r) * K_CENTER * K_RADIAL;
      n.vx += urx * dr; n.vy += ury * dr;
      // angular: soft pull to the seeded angle, stiffening hard past the wedge edge
      let da = n.homeAngle - Math.atan2(dy, dx);
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const k = Math.abs(da) > halfWedge ? K_ANG_HARD : K_ANG_SOFT;
      n.vx += -ury * da * r * k; n.vy += urx * da * r * k;
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const min = a.r + b.r + 8;
        if (d >= min) continue;
        if (d < 0.01) { // coincident: direction undefined, so pick a hashed one
          const t = frac(a.id + b.id) * Math.PI * 2;
          dx = Math.cos(t); dy = Math.sin(t); d = 0.01;
        }
        const p = ((min - d) / d) * K_COLLIDE * 0.5;
        // an expanded bubble holds its ground; neighbours do the moving
        const wa = stateOf(a) === "idle" ? 1 : 0.15, wb = stateOf(b) === "idle" ? 1 : 0.15;
        a.vx -= dx * p * wa; a.vy -= dy * p * wa;
        b.vx += dx * p * wb; b.vy += dy * p * wb;
      }
    }
    let ke = 0;
    for (const n of nodes) {
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
      ke += n.vx * n.vx + n.vy * n.vy;
    }
    return ke;
  }

  // ─── camera ──────────────────────────────────────────────────────────────────
  const cam = { x: 0, y: 0, z: 1 };
  const applyCam = () => { camera.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`; };
  function fitCam() {
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    cam.z = Math.min(vw / W, vh / H) * 0.96;
    cam.x = (vw - W * cam.z) / 2;
    cam.y = (vh - H * cam.z) / 2;
    applyCam();
  }

  viewport.addEventListener("wheel", e => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const bx = (mx - cam.x) / cam.z, by = (my - cam.y) / cam.z; // board point under cursor
    cam.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.z * Math.exp(-e.deltaY * 0.0016)));
    cam.x = mx - bx * cam.z;
    cam.y = my - by * cam.z;
    applyCam();
  }, { passive: false, ...on });

  let pan: { sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
  viewport.addEventListener("mousedown", e => {
    if ((e.target as Element).closest(".bubble")) return;
    pan = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    viewport.classList.add("is-panning");
  }, on);
  window.addEventListener("mousemove", e => {
    if (!pan) return;
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    cam.x = pan.cx + dx; cam.y = pan.cy + dy;
    applyCam();
  }, on);
  window.addEventListener("mouseup", e => {
    // a click on empty space (not a drag) clears the focus
    if (pan && !pan.moved && !(e.target as Element).closest(".bubble")) clearFocus();
    pan = null;
    viewport.classList.remove("is-panning");
  }, on);
  window.addEventListener("keydown", e => {
    if (e.key === "0" && document.activeElement?.tagName !== "INPUT") fitCam();
    if (e.key === "Escape" && document.activeElement?.tagName !== "INPUT") stepOut();
  }, on);
  window.addEventListener("resize", fitCam, on);

  // ─── chrome ──────────────────────────────────────────────────────────────────
  const SVGNS = "http://www.w3.org/2000/svg";
  const mk = (tag: string, attrs: Record<string, string | number> = {}) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  };

  function drawChrome() {
    camera.style.width = W + "px"; camera.style.height = H + "px";
    chrome.setAttribute("viewBox", `0 0 ${W} ${H}`);
    chrome.setAttribute("width", String(W)); chrome.setAttribute("height", String(H));
    chrome.replaceChildren();
    const RIM = BAND.rim[1];
    // Each band is one stroked circle whose stroke-width IS the annulus.
    (Object.entries(BAND) as [Band, [number, number]][]).forEach(([band, [r0, r1]], i) => {
      chrome.appendChild(mk("circle", {
        cx: CX, cy: CY, r: (r0 + r1) / 2, fill: "none",
        class: band === "overdue" ? "lane lane-overdue" : `lane lane-${i % 2 ? "a" : "b"}`,
        "stroke-width": r1 - r0,
      }));
    });
    chrome.appendChild(mk("circle", { cx: CX, cy: CY, r: BAND.overdue[1], class: "overdue-ring" }));
    for (const a of [45, 135, 225, 315]) {
      const rad = (a * Math.PI) / 180;
      chrome.appendChild(mk("line", {
        class: "divider",
        x1: CX + Math.cos(rad) * BAND.overdue[1], y1: CY + Math.sin(rad) * BAND.overdue[1],
        x2: CX + Math.cos(rad) * RIM, y2: CY + Math.sin(rad) * RIM,
      }));
    }
    for (const [q, deg] of Object.entries(QUAD)) {
      const rad = (deg * Math.PI) / 180;
      const t = mk("text", {
        class: "quad", x: CX + Math.cos(rad) * (RIM + 46), y: CY + Math.sin(rad) * (RIM + 46),
        "text-anchor": "middle", "dominant-baseline": "middle",
      });
      t.textContent = q;
      chrome.appendChild(t);
    }
    for (const band of Object.keys(BAND) as Band[]) {
      const t = mk("text", { class: "band-lbl", x: CX + 9, y: CY - BAND[band][1] + 24 });
      t.textContent = BAND_LBL[band];
      chrome.appendChild(t);
    }
  }

  // ─── bubbles ─────────────────────────────────────────────────────────────────
  // Date ops are root-only: a subtask has no band (it lives inside its parent), so
  // a date set on one would be a change the board couldn't show you.
  const opVisible = (n: BNode, op: (typeof OPS)[number]) =>
    (!op.rootOnly || n.depth === 0) &&
    (op.op !== "breakdown" || canDecompose(n)) &&
    (op.op !== "undo" || n.pending);

  function makeBubble(node: BNode): Elems {
    const e = makeBubbleShell();
    // Root shells outlive refreshes, but nodes are rebuilt from the database on each
    // one, so handlers resolve the current node by id rather than closing over it.
    const cur = () => findNode(node.id) ?? node;
    for (const [op, b] of e.btns) {
      // Without stopPropagation, pressing ⚡ would also fire the bubble's click.
      b.addEventListener("click", ev => { ev.stopPropagation(); onOp(cur(), op); });
      b.addEventListener("mousedown", ev => ev.stopPropagation());
    }
    e.g.addEventListener("click", ev => { ev.stopPropagation(); onBubbleClick(cur()); });
    e.g.addEventListener("mousedown", ev => ev.stopPropagation()); // never starts a pan
    e.input.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter" && e.input.value.trim()) { addChild(cur(), e.input.value.trim()); e.input.value = ""; }
      else if (ev.key === "Escape") { e.input.blur(); stepOut(); }
    });
    e.input.addEventListener("click", ev => ev.stopPropagation());
    e.dinput.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Escape") { datePickFor = null; sync(); }
    });
    e.dinput.addEventListener("click", ev => ev.stopPropagation());
    e.dinput.addEventListener("change", () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.dinput.value)) return;
      datePickFor = null;
      setDate(cur(), e.dinput.value, "scheduled");
    });
    return e;
  }

  let builtIds = "";
  function buildBubbles() {
    gfx.clear();
    bubbles.replaceChildren();
    for (const n of nodes) {
      const e = makeBubble(n);
      bubbles.appendChild(e.g);
      gfx.set(n.id, e);
    }
    builtIds = nodes.map(n => n.id).join();
  }

  // One click opens; clicking the open bubble again closes it.
  function onBubbleClick(n: BNode) {
    datePickFor = null;
    if (tail() === n.id) return stepOut();
    const i = focusPath.indexOf(n.id);
    if (i !== -1) focusPath = focusPath.slice(0, i + 1); // an ancestor: close what's inside it
    else focusPath = [...n.chain]; // open it (and its ancestors)
    sync();
  }

  /** Out one level — an open subtask leaves you in its parent, not on the board. */
  function stepOut() { focusPath = focusPath.slice(0, -1); datePickFor = null; sync(); }
  function clearFocus() { focusPath = []; datePickFor = null; sync(); }
  function sync() { layout(); render(); kick(); }

  // ─── writing ─────────────────────────────────────────────────────────────────
  async function run(tool: Exclude<DartboardTool, "undo_edit">, args: Record<string, unknown>) {
    let edit: Edit;
    try {
      edit = await ctx.dispatch(tool, args, { correlationId: session.id });
    } catch (e) {
      flash(e instanceof CommandRejected ? `rejected: ${e.message}` : String(e));
      return;
    }
    session.staged.push({ seq: edit.seq, type: edit.type, targets: edit.targets });
    saveSession();
    await refresh();
  }

  /** Undo this session's edits that match, newest first. Stops at the first conflict. */
  async function undoStaged(match: (s: Staged) => boolean) {
    const todo = session.staged.filter(match).sort((a, b) => b.seq - a.seq);
    let undone = 0;
    for (const s of todo) {
      try {
        await ctx.dispatch("undo_edit", { seq: s.seq }, { correlationId: session.id });
      } catch (e) {
        flash(e instanceof CommandRejected ? `can't undo: ${e.message}` : String(e));
        break;
      }
      session.staged = session.staged.filter(x => x.seq !== s.seq);
      undone++;
    }
    saveSession();
    await refresh();
    return undone;
  }

  function setDate(n: BNode, value: string, kind: "due" | "scheduled") {
    if (n.date && fmt(n.date) === value && n.dateType === kind) return; // already there
    return run("set_attributes", { task_id: n.id, attrs: { date: value, date_kind: kind } });
  }

  async function onOp(n: BNode, op: Op) {
    if (op === "undo") {
      // ↺ on a parent undoes what changed beneath it too: the halo it clears is the subtree's.
      const ids = new Set(subtreeIds(n));
      return void undoStaged(s => s.targets.some(t => ids.has(t)));
    }
    if (op === "today") return setDate(n, fmt(today), "due");
    if (op === "tomorrow") return setDate(n, fmt(tomorrow), "due");
    if (op === "weekend") return setDate(n, fmt(nextSat), "due");
    if (op === "zap") {
      return n.zap
        ? run("unset_attributes", { task_id: n.id, keys: ["quick"] })
        : run("set_attributes", { task_id: n.id, attrs: { quick: true } });
    }
    if (op === "done") return n.done ? undefined : run("complete_task", { task_id: n.id });
    if (op === "breakdown") { focusPath = [...n.chain]; datePickFor = null; return sync(); }
    if (op === "later") { datePickFor = datePickFor === n.id ? null : n.id; sync(); }
  }

  function addChild(n: BNode, text: string) {
    return run("create_task", { title: text, parent_id: n.id });
  }

  function flash(msg: string) {
    const f = $("flash");
    f.textContent = msg; f.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { f.hidden = true; }, 4000);
  }
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  // ─── rendering ───────────────────────────────────────────────────────────────
  // full DOM refresh — cheap at this size, and only on state change (not per frame)
  function render() {
    if (nodes.map(n => n.id).join() !== builtIds) buildBubbles();
    for (const n of nodes) paintBubble(n, gfx.get(n.id));
    drawHud();
    paintToolbar();
    restoreCaret();
  }

  const dateLabel = (n: BNode) => `${n.dateType === "scheduled" ? "⏳" : "📅"} ${n.date ? short(n.date) : "—"}`;

  function paintBubble(n: BNode, e: Elems | undefined) {
    if (!e) return;
    const st = stateOf(n);
    const isRoot = n.depth === 0;
    const band = isRoot ? (n as Root).band : null;
    e.g.className = `bubble${isRoot ? "" : " kid is-d" + Math.min(n.depth, MAX_DEPTH)}` +
      `${n.children.length ? " has-kids" : ""}${band === "overdue" ? " is-overdue" : ""}` +
      `${st !== "idle" ? " is-" + st : ""}${n.pending ? " is-pending" : ""}${n.done ? " is-done" : ""}`;
    e.text.textContent = n.text;
    e.zap.style.display = n.zap ? "block" : "none";
    e.meta.style.display = st === "idle" ? "none" : "block";
    const subs = n.children.length ? `${n.children.length} sub` : "no subtasks";
    e.meta.textContent = isRoot
      ? `${n.section || "—"} · ${dateLabel(n)}`
      : `${subs}${n.date ? ` · ${dateLabel(n)}` : ""}`;
    e.g.title = isRoot
      ? `${n.text}\n${n.section || "—"} · ${dateLabel(n)}\n${n.children.length ? n.children.length + " subtasks" : "not broken down"}`
      : `${n.text}\n${n.children.length ? n.children.length + " subtasks" : "not broken down"}`;

    for (const op of OPS) e.btns.get(op.op)!.style.display = opVisible(n, op) ? "block" : "none";
    e.btns.get("zap")!.classList.toggle("is-on", n.zap);
    e.btns.get("later")!.classList.toggle("is-on", datePickFor === n.id);

    e.inv.style.display = st === "open" && canDecompose(n) && datePickFor !== n.id ? "block" : "none";
    e.pick.style.display = datePickFor === n.id ? "block" : "none";
    if (datePickFor === n.id && !e.dinput.value) e.dinput.value = fmt(addDays(today, 31));

    // children are rebuilt each render; at ≤3 levels the subtree is a handful of nodes
    e.kids.replaceChildren();
    if (st === "open") {
      for (const k of n.children) {
        const ke = makeBubble(k);
        gfx.set(k.id, ke);
        e.kids.appendChild(ke.g);
        paintBubble(k, ke);
        ke.g.style.width = ke.g.style.height = diamOf(k) + "px";
      }
    }
  }

  /** Every render destroys the focused input — put the caret back on the tail's. */
  function restoreCaret() {
    const t = tail();
    if (!t) return;
    const n = findNode(t), e = gfx.get(t);
    if (!n || !e) return;
    if (datePickFor === t) return void requestAnimationFrame(() => e.dinput.focus());
    if (canDecompose(n)) requestAnimationFrame(() => e.input.focus());
  }

  // per-frame: positions only (roots only — kids are laid out by flexbox inside them)
  function paint() {
    for (const n of nodes) {
      const e = gfx.get(n.id);
      if (!e) continue;
      const d = n.r * 2;
      e.g.style.width = e.g.style.height = d + "px";
      e.g.style.transform = `translate(${(n.x - n.r).toFixed(2)}px,${(n.y - n.r).toFixed(2)}px)`;
    }
  }

  function drawHud() {
    const counts = nodes.reduce<Partial<Record<Band, number>>>((a, n) => ((a[n.band] = (a[n.band] ?? 0) + 1), a), {});
    const changed = session.staged.length;
    hud.replaceChildren();
    hud.append(el("div", "count", `${nodes.length} root tasks · ${fmt(today)}`));
    hud.append(el("div", "bands", (Object.keys(BAND) as Band[]).filter(b => counts[b]).map(b => `${BAND_LBL[b]} ${counts[b]}`).join(" · ")));
    if (changed) hud.append(el("div", "pending", `${changed} change${changed === 1 ? "" : "s"} this session · ↺ undoes`));
    hud.append(el("div", "keys", "click to open · click a subtask to go deeper · esc backs out · scroll to zoom · 0 to fit"));
  }

  // ─── toolbar — add task / reset all ──────────────────────────────────────────
  // Persistent DOM, built once (unlike #hud, rebuilt every render — that would
  // blow away focus and typed text in these inputs).
  const addBtn = $<HTMLButtonElement>("addBtn"), resetBtn = $<HTMLButtonElement>("resetBtn");
  const addPanel = $("addPanel"), catRow = $("catRow");
  const sectionInput = $<HTMLInputElement>("sectionInput"), textInput = $<HTMLInputElement>("textInput");
  const sectionOptions = $("sectionOptions");
  let addTaskOpen = false, resetConfirming = false;
  let selectedCategory: string = CATEGORIES[0];
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  for (const cat of CATEGORIES) {
    const b = el("button", "cat-btn", cat);
    b.dataset.cat = cat;
    b.addEventListener("click", () => { selectedCategory = cat; refreshSectionOptions(); paintToolbar(); });
    catRow.appendChild(b);
  }

  function refreshSectionOptions() {
    const sections = [...new Set(nodes.filter(n => n.category === selectedCategory && n.section).map(n => n.section))].sort();
    sectionOptions.replaceChildren(...sections.map(s => { const o = el("option"); o.value = s; return o; }));
  }
  function openAddPanel() {
    addTaskOpen = true;
    refreshSectionOptions();
    paintToolbar();
    requestAnimationFrame(() => sectionInput.focus());
  }
  function closeAddPanel() {
    addTaskOpen = false;
    sectionInput.value = ""; textInput.value = "";
    paintToolbar();
  }
  addBtn.addEventListener("click", () => (addTaskOpen ? closeAddPanel() : openAddPanel()));

  for (const inp of [sectionInput, textInput]) {
    noAutofill(inp);
    inp.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Escape") return closeAddPanel();
      if (ev.key !== "Enter") return;
      if (inp === sectionInput) textInput.focus();
      else submitCreate();
    });
  }

  /** A new root starts undated (on the rim), so it still gets triaged like any other. */
  function submitCreate() {
    const title = textInput.value.trim();
    if (!title) return;
    const section = sectionInput.value.trim();
    const attrs = { category: selectedCategory, ...(section ? { section } : {}) };
    closeAddPanel();
    return run("create_task", { title, attrs });
  }

  resetBtn.addEventListener("click", async () => {
    // no blocking native confirm(): a second click within 4s confirms
    if (!resetConfirming) {
      resetConfirming = true;
      paintToolbar();
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { resetConfirming = false; paintToolbar(); }, 4000);
      return;
    }
    clearTimeout(resetTimer);
    resetConfirming = false;
    const undone = await undoStaged(() => true);
    flash(`undid ${undone} change${undone === 1 ? "" : "s"}`);
  });

  function paintToolbar() {
    addPanel.hidden = !addTaskOpen;
    addBtn.textContent = addTaskOpen ? "× close" : "+ add";
    for (const b of catRow.children) b.classList.toggle("is-selected", (b as HTMLElement).dataset.cat === selectedCategory);
    resetBtn.hidden = session.staged.length === 0 && !resetConfirming;
    resetBtn.textContent = resetConfirming ? "confirm reset?" : "↺ reset all";
    resetBtn.classList.toggle("is-confirming", resetConfirming);
  }

  // ─── loop ────────────────────────────────────────────────────────────────────
  // Boot settles synchronously; interaction animates. rAF delivers a variable number
  // of frames, so an animated boot would land differently every load and break the
  // spatial memory the board depends on.
  const MAX_SETTLE = 900;
  function settleNow() {
    let quiet = 0;
    for (let i = 0; i < MAX_SETTLE; i++) if (tick() < KE_FLOOR && ++quiet > 20) break;
  }
  let raf: number | null = null, settled = 0;
  function kick() { settled = 0; if (!raf) raf = requestAnimationFrame(loop); }
  function loop() {
    const ke = tick();
    paint();
    if (ke < KE_FLOOR && ++settled > 20) { raf = null; return; }
    raf = requestAnimationFrame(loop);
  }

  async function refresh() {
    stampClock();
    build((await ctx.tasks()).tasks);
    sync();
  }

  // ─── boot ────────────────────────────────────────────────────────────────────
  async function boot() {
    stampClock();
    build((await ctx.tasks()).tasks);
    settleNow();
    drawChrome(); buildBubbles(); render(); paint(); fitCam();
    viewport.dataset.ready = "1";
  }

  boot().catch(e => {
    container.innerHTML = `<div class="fatal"><b>misty server not running</b><div>start it:</div><code>uv run misty serve</code><div class="err"></div></div>`;
    container.querySelector(".err")!.textContent = String(e?.message ?? e);
  });

  // test seams — assertions only. Interaction must go through real clicks.
  const summarise = (n: BNode): object => ({
    id: n.id, text: n.text, depth: n.depth, state: stateOf(n), zap: n.zap, done: n.done,
    pending: n.pending, children: n.children.map(summarise),
  });
  const w = window as unknown as Record<string, unknown>;
  w.__state = () => nodes.map(n => ({ ...summarise(n), band: n.band, category: n.category, dateType: n.dateType }));
  w.__focus = () => ({ path: [...focusPath] });
  w.__session = () => ({ id: session.id, staged: session.staged.map(s => ({ ...s })) });
  w.__audit = () => nodes.filter(n => n.category && n.category in QUAD).filter(n => {
    const dx = n.x - CX, dy = n.y - CY, r = Math.hypot(dx, dy);
    let da = Math.atan2(dy, dx) - (QUAD[n.category!] * Math.PI) / 180;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    return Math.abs(da) > ((HALF_WEDGE + 4) * Math.PI) / 180 || r < n.r0 - 6 || r > n.r1 + 6;
  }).map(n => `${n.text} [${n.category}/${n.band}]`);

  return () => {
    ac.abort();
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(flashTimer);
    clearTimeout(resetTimer);
    container.replaceChildren();
    container.classList.remove("dartboard");
  };
}
