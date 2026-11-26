// Dartboard: a spatial readout of the task database, ported from ~/code/dartboard.
//
// Quadrant = category. Radius = time horizon. Dashed border = not broken down yet.
// ⚡ = quick task. Geometry, physics and the focus chain are unchanged from the
// original; see its README for why they look the way they do.
//
// A root sits at its earliest open deadline: its own due date, or a subtask's if that
// is sooner. By default the board shows only what is due by the end of the coming
// weekend; "show later" (or L) brings back the month and later rings.
//
// An open bubble has its name (and its subtasks) in the middle and its controls on the
// rim: along the bottom, what dragging can't do (⚡, ✓, ✕ to discard, and ↺ once something
// has changed), and opposite them at the top, the ＋ that adds a subtask. Pressing ＋ puts
// a new bubble after the subtasks, to type the name into. Dates are set by dragging a
// root to a ring.
//
// What changed is where it reads and writes. The original read Obsidian markdown and
// only *staged* deltas for misty to drain later, because a bug must never corrupt a
// task file. Here every gesture is a validated, recorded Misty edit, so it lands
// immediately. Edits are still one click from undone: the yellow halo now means
// "changed this session", and ↺ / reset all record `undo_edit`s for those edits.
//
// Reorganising (drag a subtask onto another to merge them, click an open subtask's
// empty space to pop it, Collapse to bring pops back) is a draft, not a stream of
// edits: see reorg.ts and ADR 0003.
import "./board.css";
import { CommandRejected, type Edit, type Task } from "../../api";
import type { ViewContext } from "../types";
import * as R from "./reorg";

export const DARTBOARD_TOOLS = [
  "create_task",
  "set_attributes",
  "unset_attributes",
  "complete_task",
  "discard_task",
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

// Sizes are given for three levels; anything deeper is drawn at the last one. Depth
// itself is unlimited: the database has no cap, and a cap here hid deeper tasks.
const SIZE_LEVELS = 2;

// Diameters by depth (index = depth, clamped). One click expands straight to `open`.
const D_IDLE = [96, 60, 44]; // a closed bubble with nothing open under it
// PROTOTYPE: a closed bubble grows with the open subtasks under it, at any depth, so
// what is left in it can be read off the board. Its AREA grows with the count (each
// subtask adds GROW of the base area), up to MAX_GROW times the base diameter: bands are
// narrow, and a bubble much wider than its band stops saying which band it is in.
// `S` switches it off and on, to compare.
const GROW = 0.25, MAX_GROW = 1.7;
const D_OPEN = [300, 210, 156]; // floor for an open bubble with nothing inside
const D_DONE = [44, 30, 24];
const CHROME = [130, 96, 66]; // vertical room an open bubble needs for its own content
// The bubble being named, which follows an open bubble's subtasks, indexed by that
// bubble's depth. It is bigger than a subtask so there is room to type.
const D_NAMING = [128, 104, 88];
// The controls on an open bubble's rim, by its depth: their diameter, the space between
// them along the arc, and how far they sit inside the border.
const BTN = [28, 22, 18], BTN_GAP = [7, 5, 4], BTN_INSET = [8, 6, 4];

const K_RADIAL = 0.03, K_CENTER = 0.06, K_ANG_SOFT = 0.004, K_ANG_HARD = 0.055;
const K_COLLIDE = 0.35, DAMP = 0.85, KE_FLOOR = 0.02;
// Cooling (as in d3-force). Every force is scaled by `alpha`, which decays towards 0, so
// the board always comes to rest, even when a band holds more bubbles than fit. Without
// it, band containment and collision fight forever and the board never stops jittering.
// An interaction reheats it. Equilibria are unchanged: all forces scale together.
const ALPHA_MIN = 0.004;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300); // ~5s from fully hot at 60fps
const REHEAT = 0.6;
// A travelling bubble keeps the board this warm until it is home (d3's alphaTarget), so a
// long swim always finishes, but never for longer than TRAVEL_MS.
const TRAVEL_HEAT = 0.3, TRAVEL_MS = 8000;
const MAX_SPEED = 14; // px/frame: an opening bubble shoves neighbours, it doesn't fling them
const ZOOM_MIN = 0.25, ZOOM_MAX = 4;
// Past the coming weekend, or undated. Not drawn unless asked for (see isHidden).
const LATER: ReadonlySet<Band> = new Set<Band>(["month", "rim"]);

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
  /** Whoever holds the earliest open due date at or under this node (maybe itself). */
  deadline: BNode | null;
  zap: boolean;
  done: boolean;
  pending: boolean; // changed this session, here or below
  /** Open subtasks under it, at any depth: what is left to do in here. */
  load: number;
  /** Tasks under it that were discarded this session. Not drawn, but ↺ brings them back. */
  lost: string[];
  synthetic: boolean; // made by the draft (a merge); not in the database yet
  drafted: boolean; // the draft moves or creates it
  chain: string[]; // ids root-first, ending with this one
  children: BNode[];
}
interface Root extends BNode {
  band: Band;
  r0: number; r1: number;
  homeRadius: number; homeAngle: number;
  r: number;
  x: number; y: number; vx: number; vy: number;
  /** performance.now() until which it is swimming home (dropped, or its band changed). */
  travelUntil: number;
}

/** An edit made from this board this session, so it can be undone. */
interface Staged { seq: number; type: string; targets: string[] }

const SESSION_KEY = "misty.dartboard.session";
const LATER_KEY = "misty.dartboard.showLater";
const FLAT_KEY = "misty.dartboard.flatSizes";

/** The earliest due date among `ns`. On a tie the first one keeps it. */
const earliest = (ns: (BNode | null)[]) =>
  ns.reduce<BNode | null>((a, c) => (c?.date && (!a || c.date < a.date!) ? c : a), null);
/** The earliest open due date strictly under `n`. */
const deadlineBelow = (n: BNode) => earliest(n.children.filter(c => !c.done).map(c => c.deadline));

type Elems = ReturnType<typeof makeBubbleShell>;

// Only what a drag can't say. Dates are set by dragging a root to a ring.
const OPS = [
  { op: "zap", glyph: "⚡", tip: "quick task (≤15 min)" },
  { op: "done", glyph: "✓", tip: "done" },
  { op: "discard", glyph: "✕", tip: "discard: not needed, or a duplicate (its subtasks go too)" },
  // only shown while this bubble (or anything under it) changed this session
  { op: "undo", glyph: "↺", tip: "undo this session's changes" },
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
      <button id="collapseBtn" class="tool-btn" title="close everything and bring back popped groups whose parts are untouched" hidden>collapse</button>
      <button id="discardDraftBtn" class="tool-btn" title="throw away this reorganisation" hidden>✕ discard</button>
      <button id="applyBtn" class="tool-btn" title="apply this reorganisation now" hidden>✓ apply now</button>
      <button id="laterBtn" class="tool-btn" title="show or hide tasks past the coming weekend (L)">show later</button>
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
function noAutofill(input: HTMLInputElement | HTMLTextAreaElement) {
  if (input instanceof HTMLInputElement && !input.type) input.type = "text";
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

// ─── titles ────────────────────────────────────────────────────────────────────
// A title is set in a circle, so a line can only be as wide as the circle is at that
// line's height: widest across the middle, narrower above and below. CSS wraps to a box,
// which put the corners of a long title outside the rim and split words to fill it. So
// lines are broken here: whole words, each line filled to its own chord, and as few
// lines as will hold the title. What doesn't fit ends in an ellipsis (the whole title is
// still in the element, and in the tooltip).
const MAX_LINES = { idle: 4, open: 3 }; // an open bubble's title shares it with the subtasks
const ruler = document.createElement("canvas").getContext("2d")!;
const wordWidths = new Map<string, number>();
function wordWidth(font: string, word: string) {
  const key = `${font}\n${word}`;
  let w = wordWidths.get(key);
  if (w === undefined) { ruler.font = font; w = ruler.measureText(word).width; wordWidths.set(key, w); }
  return w;
}

/** Where a title sits in its bubble, measured while it is still on one line. */
interface TitleBox {
  /** Radius the text may reach, and the bubble's centre, in the bubble's own pixels. */
  r: number; cy: number;
  top: number; lineHeight: number; fontSize: number; font: string;
}

/** The width of each of `n` lines. The block stays centred where it was, so it grows
 *  up and down from the one-line position. */
function chords(box: TitleBox, n: number): number[] {
  const top = box.top - ((n - 1) * box.lineHeight) / 2;
  return Array.from({ length: n }, (_, i) => {
    // the far edge of the line's glyphs from the centre: that is where it is narrowest
    const reach = Math.abs(top + (i + 0.5) * box.lineHeight - box.cy) + box.fontSize * 0.55;
    return reach < box.r ? 2 * Math.sqrt(box.r ** 2 - reach ** 2) : 0;
  });
}

/** Break `words` into lines for a circle. Returns each line with its width limit. */
function breakTitle(words: string[], box: TitleBox, maxLines: number): { text: string; max: number }[] {
  const space = wordWidth(box.font, " ");
  const ws = words.map(w => wordWidth(box.font, w));
  let best: { lines: { text: string; max: number }[]; score: number } | null = null;
  let widest = 0; // the widest line tried so far: a word longer than this is cut wherever it goes
  for (let n = 1; n <= Math.min(maxLines, words.length); n++) {
    const cs = chords(box, n);
    if (n > 1 && cs.some(c => c < box.fontSize * 2.5)) break; // no room for another line
    widest = Math.max(widest, ...cs);
    const lines: { text: string; max: number }[] = [];
    let i = 0, shown = 0, clipped = false, cutShort = 0;
    for (let l = 0; l < n; l++) {
      const last = l === n - 1, start = i;
      let w = 0;
      // the last line takes what is left; the others leave a word for each line below
      while (i < words.length && (last || i === start || (w + space + ws[i] <= cs[l] && words.length - i > n - 1 - l))) {
        w += (i > start ? space : 0) + ws[i++];
      }
      if (w > cs[l] + 0.5) {
        clipped = true;
        // A word cut because its line is one of the narrow ones, when it fits a wider
        // line, reads much worse than a cut at the end: "Recon… the quarterly".
        if (!last && ws[start] <= widest) cutShort++;
      }
      shown += Math.min(w, cs[l]);
      lines.push({ text: words.slice(start, i).join(" "), max: cs[l] });
    }
    if (!clipped) return lines; // the fewest lines that hold it all
    const score = shown - cutShort * 10000; // otherwise, whatever shows the most of it
    if (!best || score > best.score) best = { lines, score };
  }
  return best?.lines ?? [{ text: words.join(" "), max: chords(box, 1)[0] }];
}

/** The shell every bubble shares — root and subtask alike. A kid IS a bubble. */
function makeBubbleShell() {
  const g = el("div", "bubble");
  const body = el("div", "body");
  const zap = el("div", "zap", "⚡");
  const text = el("div", "text");
  const meta = el("div", "meta");
  const kids = el("div", "kids");
  // The controls sit on the rim, outside the centred column: `row` covers the bubble and
  // each control is placed on it by angle (see placeControls).
  const row = el("div", "actions");
  const add = el("button", "add-kid", "+");
  add.title = "add a subtask";
  add.setAttribute("aria-label", "add a subtask");
  // The date panel (dropping a root on the rim) is inline, not prompt(): a native modal
  // blocks the thread and its Escape leaks to the window handler, collapsing the bubble.
  const pick = el("div", "datepick");
  const dinput = el("input");
  dinput.type = "date";
  noAutofill(dinput);
  pick.append(dinput, el("div", "hint", "pick a date · esc closes"));
  const btns = new Map<Op, HTMLButtonElement>();
  for (const op of OPS) {
    const b = el("button", "act", op.glyph);
    b.dataset.op = op.op;
    b.title = op.tip;
    b.setAttribute("aria-label", op.tip);
    row.appendChild(b);
    btns.set(op.op, b);
  }
  row.appendChild(add);
  body.append(zap, text, meta, kids, pick);
  g.append(body, row);
  return { g, text, meta, kids, row, zap, add, pick, dinput, btns };
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
  // The open bubble that is getting a new subtask: the ＋ in it has become a bubble with
  // a text box. It isn't a task until ↵. What has been typed lives in `nameBox`.
  let namingIn: string | null = null;
  const gfx = new Map<string, Elems>();
  let tasksCache: Task[] = []; // the database, as last read
  let reorg = R.emptyReorg(); // the draft laid over it
  const baseMap = () => new Map(tasksCache.map(t => [t.id, t]));
  let today = new Date(), tomorrow = today, nextSat = today, weekendEnd = today, monthOut = today;
  // Per tab, like the session: a new tab starts with the short view.
  let showLater = (() => { try { return sessionStorage.getItem(LATER_KEY) === "1"; } catch { return false; } })();
  let sizeByLoad = (() => { try { return sessionStorage.getItem(FLAT_KEY) !== "1"; } catch { return true; } })();

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
    weekendEnd = addDays(nextSat, 1); // its Sunday. On a Sunday, that is next week's
    monthOut = addDays(today, 31);
  }

  // First match wins, so bands collapse gracefully (on a Saturday, `today` wins).
  // A root goes where its earliest open deadline is, and that may be a subtask's: a task
  // with a step due tomorrow needs attention tomorrow, whatever its own date says.
  function bandOf(n: BNode): Band {
    const d = n.deadline?.date;
    if (!d) return "rim"; // no deadline. A scheduled date is an intention, not one
    if (d < today) return "overdue";
    if (+d === +today) return "today";
    if (+d === +tomorrow) return "tomorrow";
    if (d <= weekendEnd) return "weekend";
    if (d <= monthOut) return "month";
    return "rim";
  }

  /** Past the coming weekend, and not asked for. Some stay on the board anyway: an open
   *  one (it is being read), and, faded, one changed this session or by the draft (↺ has
   *  to be able to reach it, and a new task starts undated, so it would vanish as it is
   *  made). A hidden bubble keeps its place in the simulation, so showing it moves nothing. */
  const isLater = (n: Root) => !showLater && LATER.has(n.band);
  const draftedWithin = (n: BNode): boolean => n.drafted || n.children.some(draftedWithin);
  const isHidden = (n: Root) => isLater(n) && !n.pending && !focusPath.includes(n.id) && !draftedWithin(n);

  const tail = () => focusPath[focusPath.length - 1] ?? null;
  const stateOf = (n: BNode) => (focusPath.includes(n.id) ? "open" : "idle");
  const canDecompose = (n: BNode) => !n.synthetic;
  const subtreeIds = (n: BNode): string[] => [n.id, ...n.lost, ...n.children.flatMap(subtreeIds)];
  const walk = (n: BNode, id: string): BNode | null =>
    n.id === id ? n : n.children.reduce<BNode | null>((a, c) => a ?? walk(c, id), null);
  const findNode = (id: string) => { for (const r of nodes) { const f = walk(r, id); if (f) return f; } return null; };

  // ─── tasks → nodes ───────────────────────────────────────────────────────────
  function build(tasks: Task[]) {
    const touched = new Set(session.staged.flatMap(s => s.targets));
    const completedHere = new Set(
      session.staged.filter(s => s.type === "task.completed").flatMap(s => s.targets),
    );
    const discardedHere = new Set(
      session.staged.filter(s => s.type === "task.discarded").flatMap(s => s.targets),
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
    // Discarded here, under `id`: a discarded task's subtasks were discarded with it.
    const lostUnder = (id: string): string[] => (byParent.get(id) ?? [])
      .filter(k => k.state === "discarded" && discardedHere.has(k.id))
      .flatMap(k => [k.id, ...lostUnder(k.id)]);

    const makeNode = (t: Task, depth: number, parentChain: string[]): BNode => {
      const a = t.attrs;
      const date = typeof a.date === "string" ? toDate(a.date) : null;
      const node: BNode = {
        id: t.id, text: t.title, depth,
        category: typeof a.category === "string" ? a.category : null,
        section: typeof a.section === "string" ? a.section : "",
        date, dateType: date ? (a.date_kind === "scheduled" ? "scheduled" : "due") : null,
        deadline: null,
        zap: a.quick === true, done: t.state === "done", pending: false, load: 0, lost: [],
        synthetic: R.isNew(t.id), drafted: reorg.nodes.has(t.id),
        chain: [...parentChain, t.id], children: [],
      };
      if (!parentChain.includes(t.id)) {
        node.children = (byParent.get(t.id) ?? []).filter(kidVisible)
          .map(k => makeNode(k, depth + 1, node.chain));
      }
      if (!parentChain.includes(t.id)) node.lost = lostUnder(t.id);
      node.pending = touched.has(t.id) || node.lost.length > 0 || node.children.some(c => c.pending);
      node.load = node.children.reduce((a, c) => a + (c.done ? 0 : 1 + c.load), 0);
      // Done subtasks (and what is under them) no longer have a deadline to meet.
      node.deadline = earliest([node.dateType === "due" ? node : null, deadlineBelow(node)]);
      return node;
    };

    const prev = new Map(nodes.map(n => [n.id, n]));
    nodes = (byParent.get(null) ?? []).filter(rootVisible).map(t => {
      const old = prev.get(t.id);
      const n = makeNode(t, 0, []) as Root;
      // positions carry over, so a changed band reads as the bubble swimming there
      Object.assign(n, old
        ? { x: old.x, y: old.y, vx: old.vx, vy: old.vy, band: old.band, travelUntil: old.travelUntil }
        : { x: NaN, y: NaN, vx: 0, vy: 0, travelUntil: 0 });
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
    if (namingIn) { // its bubble closed, was merged away, or is gone
      const p = findNode(namingIn);
      if (!p || !canDecompose(p) || !focusPath.includes(p.id)) { namingIn = null; nameBox.value = ""; }
    }
    for (const n of nodes) {
      const band = bandOf(n);
      if (n.band && n.band !== band) n.travelUntil = performance.now() + TRAVEL_MS; // swims there
      n.band = band;
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
    const d = Math.min(n.depth, SIZE_LEVELS);
    if (stateOf(n) === "idle") {
      if (n.done) return D_DONE[d];
      return D_IDLE[d] * (sizeByLoad ? Math.min(MAX_GROW, Math.sqrt(1 + GROW * n.load)) : 1);
    }
    // area-based pack: √(Σ kid areas) is the side of the square they'd tile;
    // ×1.7 is slack for flex-wrap gaps and the circle's unusable corners.
    const area = n.children.reduce((a, k) => a + diamOf(k) ** 2, slotDiam(n) ** 2);
    return Math.max(D_OPEN[d], Math.sqrt(area) * 1.7 + CHROME[d]);
  }

  /** How an open bubble takes a new subtask: the ＋ on its rim, the bubble being named
   *  (which follows its subtasks), or not at all. */
  const slotOf = (n: BNode): "add" | "naming" | null =>
    !canDecompose(n) || datePickFor === n.id ? null : namingIn === n.id ? "naming" : "add";
  /** Room among the subtasks for the bubble being named. The ＋ is on the rim, not here. */
  const slotDiam = (n: BNode) => (slotOf(n) === "naming" ? D_NAMING[Math.min(n.depth, SIZE_LEVELS)] : 0);

  // ─── physics ─────────────────────────────────────────────────────────────────
  /** One step at heat `alpha`. Returns the kinetic energy. */
  function tick(alpha: number) {
    const halfWedge = (HALF_WEDGE * Math.PI) / 180;
    // The open bubble is what you're reading: it holds still and the others make room.
    // So does a bubble being dragged (it's under the pointer, not in the simulation).
    const pinned = (n: Root) => stateOf(n) !== "idle" || drag?.id === n.id;
    for (const n of nodes) {
      if (pinned(n)) continue;
      const dx = n.x - CX, dy = n.y - CY;
      const r = Math.hypot(dx, dy) || 0.001;
      const urx = dx / r, ury = dy / r;
      // radial: hard containment at the annulus edges, weak centering inside
      let dr;
      if (r < n.r0) dr = (n.r0 - r) * K_RADIAL;
      else if (r > n.r1) dr = (n.r1 - r) * K_RADIAL;
      else dr = (n.homeRadius - r) * K_CENTER * K_RADIAL;
      n.vx += urx * dr * alpha; n.vy += ury * dr * alpha;
      // angular: soft pull to the seeded angle, stiffening hard past the wedge edge
      let da = n.homeAngle - Math.atan2(dy, dx);
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const k = (Math.abs(da) > halfWedge ? K_ANG_HARD : K_ANG_SOFT) * alpha;
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
        const p = ((min - d) / d) * K_COLLIDE * 0.5 * alpha;
        // a travelling bubble that shoves a neighbour takes it along: the neighbour swims
        // home too, under the same deadline (so the total stays bounded)
        if (a.travelUntil > b.travelUntil && !pinned(b)) b.travelUntil = a.travelUntil;
        else if (b.travelUntil > a.travelUntil && !pinned(a)) a.travelUntil = b.travelUntil;
        const wa = pinned(a) ? 0 : 1, wb = pinned(b) ? 0 : 1;
        // against a pinned bubble, the free one takes the whole correction
        const share = wa + wb === 1 ? 2 : 1;
        a.vx -= dx * p * wa * share; a.vy -= dy * p * wa * share;
        b.vx += dx * p * wb * share; b.vy += dy * p * wb * share;
      }
    }
    let ke = 0;
    for (const n of nodes) {
      if (pinned(n)) { n.vx = n.vy = 0; continue; }
      n.vx *= DAMP; n.vy *= DAMP;
      const v = Math.hypot(n.vx, n.vy);
      if (v > MAX_SPEED) { n.vx *= MAX_SPEED / v; n.vy *= MAX_SPEED / v; }
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
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) return;
    if (e.key === "0") fitCam();
    if ((e.key === "l" || e.key === "L") && !e.metaKey && !e.ctrlKey && !e.altKey) setShowLater(!showLater);
    if ((e.key === "s" || e.key === "S") && !e.metaKey && !e.ctrlKey && !e.altKey) setSizeByLoad(!sizeByLoad);
    // the bubble being named is the innermost level, so esc leaves it first
    if (e.key === "Escape") { if (namingIn) { endNaming(false); sync(); } else stepOut(); }
    if ((e.key === "+" || e.key === "=") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const n = tail() ? findNode(tail()!) : null;
      if (!n || !canDecompose(n)) return;
      e.preventDefault(); // or the key lands in the text box it just opened
      startNaming(n);
    }
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
        "data-band": band,
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
  // A merged group isn't a task yet, so it has no simple edits until the draft lands.
  const opVisible = (n: BNode, op: (typeof OPS)[number]) => !n.synthetic && (op.op !== "undo" || n.pending);

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
    e.g.addEventListener("click", ev => {
      ev.stopPropagation();
      if (suppressClick) return; // the click that ends a drag
      onBubbleClick(cur());
    });
    e.g.addEventListener("mousedown", ev => ev.stopPropagation()); // never starts a pan
    // Subtasks drag to reorganise; a closed root drags to a ring to reschedule it.
    e.g.addEventListener("pointerdown", ev => {
      if (ev.button !== 0 || (ev.target as Element).closest("button, input, textarea")) return;
      const n = cur();
      if (n.depth === 0 && stateOf(n) !== "idle") return; // an open root is for reading
      ev.stopPropagation();
      drag = { id: n.id, el: e.g, x0: ev.clientX, y0: ev.clientY, started: false, root: n.depth === 0 };
    });
    e.add.addEventListener("click", ev => { ev.stopPropagation(); startNaming(cur()); });
    e.add.addEventListener("mousedown", ev => ev.stopPropagation());
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
    if (namingIn) {
      // A click away settles the bubble being named. On its own parent that is all the
      // click does: there, a click would otherwise close the parent, or pop it.
      const parent = namingIn;
      endNaming();
      if (n.id === parent) return sync();
    }
    // The empty space of an open subtask with subtasks of its own pops that level.
    if (focusPath.includes(n.id) && n.depth > 0 && n.children.length) return doReorg(R.pop(baseMap(), reorg, n.id));
    if (tail() === n.id) return stepOut();
    const i = focusPath.indexOf(n.id);
    if (i !== -1) focusPath = focusPath.slice(0, i + 1); // an ancestor: close what's inside it
    else focusPath = [...n.chain]; // open it (and its ancestors)
    sync();
  }

  /** Out one level — an open subtask leaves you in its parent, not on the board. */
  function stepOut() { const was = focusPath[0]; focusPath = focusPath.slice(0, -1); datePickFor = null; sync(); if (was && !focusPath.length) sendHome(); }
  function clearFocus() { endNaming(); const was = focusPath.length; focusPath = []; datePickFor = null; sync(); if (was) sendHome(); }
  /** After an open bubble closes, the bubbles it pushed aside swim back. The overdue
   *  band usually holds more bubbles than fit, so its cluster is left to settle. */
  function sendHome() {
    const until = performance.now() + TRAVEL_MS;
    for (const n of nodes) if (n.band !== "overdue" && !isHome(n)) n.travelUntil = until;
    kick();
  }
  function sync() { layout(); render(); kick(); syncHold(); }

  // ─── naming a new subtask ────────────────────────────────────────────────────
  // ＋ doesn't open a form. It becomes the new bubble, with a text box where its title
  // will be, so the thing you name is the thing you get. ↵ makes it a task and offers
  // the next one (breaking a task down is usually several steps); esc throws it away;
  // clicking or dragging anything else keeps what was typed.
  // One element for the whole board, since only one bubble is named at a time. It is
  // moved between parents rather than rebuilt, so a refresh never loses half a title.
  const namer = el("div", "bubble kid is-naming");
  const nameBox = el("textarea", "name-box");
  nameBox.rows = 1;
  nameBox.placeholder = "name it…";
  nameBox.setAttribute("aria-label", "name of the new subtask");
  noAutofill(nameBox);
  {
    const body = el("div", "body");
    body.appendChild(nameBox);
    namer.appendChild(body);
  }
  /** What has been typed, as a title: one line, however it was pasted. */
  const typedTitle = () => nameBox.value.replace(/\s+/g, " ").trim();
  /** The box is as tall as its text, so the title stays centred in the bubble. */
  const fitNameBox = () => { nameBox.style.height = "auto"; nameBox.style.height = `${nameBox.scrollHeight}px`; };
  nameBox.addEventListener("input", fitNameBox);
  nameBox.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "Escape") { endNaming(false); return sync(); }
    if (ev.key !== "Enter" || ev.isComposing) return;
    ev.preventDefault(); // a title is one line
    const title = typedTitle();
    if (!title || !namingIn) { endNaming(); return sync(); }
    // The named bubble is the task: it shrinks into place from where it was typed.
    const born = namer.getBoundingClientRect();
    nameBox.value = "";
    fitNameBox();
    void run("create_task", { title, parent_id: namingIn }, born);
  });
  // Inside its parent's bubble, but not part of it: a press here must not open, close,
  // pop or drag the parent.
  for (const type of ["click", "mousedown", "pointerdown"] as const) {
    namer.addEventListener(type, ev => { ev.stopPropagation(); if (type === "click") nameBox.focus(); });
  }

  function startNaming(n: BNode) {
    if (namingIn === n.id) return nameBox.focus();
    endNaming();
    datePickFor = null;
    namingIn = n.id;
    sync();
    if (!REDUCED) namer.animate([{ transform: "scale(.35)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: SPRING });
  }

  /** Stop naming. What was typed becomes a subtask, unless it is being thrown away.
   *  The caller renders. */
  function endNaming(keep = true) {
    if (!namingIn) return;
    const parent = namingIn, title = keep ? typedTitle() : "";
    namingIn = null;
    nameBox.value = "";
    if (title) void run("create_task", { title, parent_id: parent });
  }

  // ─── reorganising (a draft; see reorg.ts) ────────────────────────────────────
  const VOCABULARY =
    "Dartboard bubbles. Each bubble is a task; a bubble inside another is its subtask. " +
    "merge {dragged, target, group}: a new task `group`, titled 'target + dragged', takes " +
    "target's place, and both go inside it. insert {dragged, into}: dragged becomes a subtask " +
    "of `into`. to_root {dragged}: dragged becomes a top-level task in its old root's " +
    "category and section. pop {group}: the group dissolves, its subtasks take its place, and " +
    "the group task is discarded. collapse {restored}: popped groups whose parts were untouched " +
    "come back. Bubbles only move within the root task they are under, or out to the top level.";
  const SETTLE_MS = 6000; // quiet time after the board is closed before the draft applies
  const HOLD_MS = 15000; // lease while a bubble is open or dragged
  const RENEW_MS = 5000; // how often the lease is renewed: well inside HOLD_MS
  const DRAFT_KEY = "misty.dartboard.draft";

  let draftId: string | null = (() => { try { return sessionStorage.getItem(DRAFT_KEY); } catch { return null; } })();
  let draftDue: number | null = null; // performance.now() when it should settle, if released
  let draftBusy = false; // applying / finishing
  let syncChain: Promise<unknown> = Promise.resolve();
  let held = false;
  let leaseAt = 0; // performance.now() when the lease was last sent

  const setDraftId = (id: string | null) => {
    draftId = id;
    try { if (id) sessionStorage.setItem(DRAFT_KEY, id); else sessionStorage.removeItem(DRAFT_KEY); } catch { /* private mode */ }
  };
  const isHeld = () => focusPath.length > 0 || !!drag?.started;
  const queue = (fn: () => Promise<unknown>) => {
    syncChain = syncChain.then(fn).catch(e => flash(e instanceof CommandRejected ? e.message : String(e)));
    return syncChain;
  };

  /** Apply a reorganisation locally, then tell the server. */
  function doReorg(res: R.Result, from?: Map<string, DOMRect>) {
    reorg = res.reorg;
    const op = res.op;
    // A moved or merged bubble closes, along with what's inside it. A popped level
    // leaves the chain, and whatever was open inside it stays open.
    if (op.op === "pop") focusPath = focusPath.filter(id => id !== op.group);
    else if (op.op === "merge" || op.op === "insert" || op.op === "to_root") {
      const cut = focusPath.findIndex(id => id === op.dragged || (op.op === "merge" && id === op.target));
      if (cut !== -1) focusPath = focusPath.slice(0, cut);
    }
    rebuildFromDraft(from);
    const after = R.toStructure(reorg), noop = R.isNoop(reorg);
    draftDue = isHeld() ? null : performance.now() + SETTLE_MS;
    queue(async () => {
      if (noop) { // it cancelled out: nothing to apply
        if (draftId) { const id = draftId; setDraftId(null); await ctx.drafts.discard(id).catch(() => {}); }
        draftDue = null;
        drawHud();
        return;
      }
      if (!draftId) setDraftId((await ctx.drafts.create(VOCABULARY, { settleMs: SETTLE_MS })).id);
      await ctx.drafts.update(draftId!, { append_ops: [op], after, hold_ms: isHeld() ? HOLD_MS : SETTLE_MS });
    });
  }

  function rebuildFromDraft(from?: Map<string, DOMRect>) {
    stampClock();
    const before = snapshot(from);
    build(R.effectiveTasks(tasksCache, reorg));
    layout(); render(before); kick(); syncHold();
  }

  /** Hold the draft while the user is working in a bubble; release it when they leave. */
  function syncHold() {
    const now = isHeld();
    if (now === held) return;
    held = now;
    draftDue = held || !draftId ? null : performance.now() + SETTLE_MS;
    if (draftId) {
      const id = draftId;
      leaseAt = performance.now();
      queue(() => ctx.drafts.update(id, { hold_ms: held ? HOLD_MS : SETTLE_MS }));
    }
  }

  function collapseAll() {
    endNaming();
    const res = R.collapse(baseMap(), reorg);
    focusPath = [];
    datePickFor = null;
    if (res.restored.length) doReorg(res);
    else { reorg = res.reorg; rebuildFromDraft(); }
    sendHome();
  }

  /** Server says the draft is done (or the user forced it): drop the overlay, reload. */
  async function finishDraft(draft: { status: string; error: string | null }, edits: Edit[]) {
    setDraftId(null);
    draftDue = null;
    reorg = R.emptyReorg();
    if (draft.status === "applied") {
      for (const e of edits) session.staged.push({ seq: e.seq, type: e.type, targets: e.targets });
      saveSession();
      if (edits.length) flash(`reorganisation applied · ${edits.length} edit${edits.length === 1 ? "" : "s"} · ↺ undoes`, "info");
    } else if (draft.status === "rejected") {
      flash(`reorganisation not applied: ${draft.error}`);
    }
    await refresh();
  }

  async function pollDraft() {
    if (!draftId || draftBusy) return drawHud();
    draftBusy = true;
    try {
      const { draft, edits } = await ctx.drafts.get(draftId);
      if (draft.status !== "open") await finishDraft(draft, edits);
    } catch { /* server away: try again next tick */ } finally {
      draftBusy = false;
      drawHud();
    }
  }
  const pollTimer = setInterval(() => {
    void pollDraft();
    // Renew the lease now and then, not on every tick: a bubble can stay open for hours.
    if (held && draftId && performance.now() - leaseAt >= RENEW_MS) {
      const id = draftId;
      leaseAt = performance.now();
      queue(() => ctx.drafts.update(id, { hold_ms: HOLD_MS }));
    }
  }, 1000);

  async function applyNow() {
    if (!draftId) return;
    const id = draftId;
    await syncChain;
    draftBusy = true;
    try {
      const { draft, edits } = await ctx.drafts.apply(id);
      await finishDraft(draft, edits);
    } catch (e) { flash(String(e)); } finally { draftBusy = false; }
  }
  async function discardDraft() {
    const id = draftId;
    await syncChain;
    if (id) await ctx.drafts.discard(id).catch(() => {});
    await finishDraft({ status: "discarded", error: null }, []);
  }

  // ─── dragging ────────────────────────────────────────────────────────────────
  // Regions are fixed at the start of the drag, and the first one under the pointer
  // wins: closed bubbles (merge), then open areas innermost first (join), then other
  // roots (refused). Anywhere else, the bubble becomes a root task.
  type Region = { kind: "merge" | "area" | "block"; id: string; el: HTMLElement; cx: number; cy: number; r: number };
  let drag: {
    id: string; el: HTMLElement; x0: number; y0: number; started: boolean; root: boolean;
    float?: HTMLElement; regions?: Region[]; hit?: Region | null;
  } | null = null;
  let suppressClick = false;

  function regionsFor(id: string): Region[] {
    const t = new R.Tree(baseMap(), reorg);
    const x = findNode(id)!;
    const own = new Set(subtreeIds(x));
    const circle = (kind: Region["kind"], nid: string, el: HTMLElement, pad = 0): Region => {
      const b = el.getBoundingClientRect();
      return { kind, id: nid, el, cx: b.left + b.width / 2, cy: b.top + b.height / 2, r: b.width / 2 + pad };
    };
    const merges: Region[] = [], areas: Region[] = [], blocks: Region[] = [];
    for (const [nid, e] of gfx) {
      if (own.has(nid) || !e.g.isConnected) continue;
      const n = findNode(nid);
      if (!n || (n.depth === 0 && isHidden(n as Root))) continue; // nothing there to drop on
      if (n.depth === 0 && n.chain[0] !== x.chain[0]) blocks.push(circle("block", nid, e.g));
      else if (!focusPath.includes(nid) && n.depth > 0 && R.canJoin(t, id, nid)) merges.push(circle("merge", nid, e.g, 4));
    }
    for (const nid of [...focusPath].reverse()) {
      const e = gfx.get(nid);
      if (e?.g.isConnected && !own.has(nid)) areas.push(circle("area", nid, e.g));
    }
    return [...merges, ...areas, ...blocks];
  }

  window.addEventListener("pointermove", ev => {
    if (!drag) return;
    if (drag.started && ev.buttons === 0) return cancelDrag(); // let go outside the window
    if (!drag.started) {
      if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 4) return;
      if (namingIn) { // settle it first; subtask elements are rebuilt, so find ours again
        endNaming();
        sync();
        drag.el = gfx.get(drag.id)?.g ?? drag.el;
      }
      drag.started = true;
      // Regions are measured once, so measure where bubbles land, not mid-animation.
      for (const anim of container.getAnimations({ subtree: true })) anim.finish();
      drag.regions = drag.root ? [] : regionsFor(drag.id);
      const b = drag.el.getBoundingClientRect();
      const f = drag.el.cloneNode(true) as HTMLElement;
      f.classList.add("drag-float");
      f.style.transform = ""; // a root's inline position; the float is placed by CSS
      f.style.width = `${b.width / cam.z}px`;
      f.style.height = `${b.height / cam.z}px`;
      f.style.setProperty("--z", String(cam.z));
      container.appendChild(f);
      drag.float = f;
      drag.el.classList.add("is-drag-src");
      viewport.classList.add("is-dragging");
      syncHold();
    }
    const f = drag.float!;
    f.style.left = `${ev.clientX}px`;
    f.style.top = `${ev.clientY}px`;
    if (drag.root) showSchedule(ev.clientX, ev.clientY);
    const hit = drag.regions!.find(r => Math.hypot(ev.clientX - r.cx, ev.clientY - r.cy) <= r.r) ?? null;
    if (hit !== drag.hit) {
      drag.hit?.el.classList.remove("is-drop-target", "is-drop-area", "is-drop-blocked");
      hit?.el.classList.add(hit.kind === "merge" ? "is-drop-target" : hit.kind === "area" ? "is-drop-area" : "is-drop-blocked");
      drag.hit = hit;
    }
  }, on);

  /** Give up a drag without dropping: the bubble goes back where it was. */
  function cancelDrag() {
    const d = drag;
    drag = null;
    if (!d?.started) return;
    d.hit?.el.classList.remove("is-drop-target", "is-drop-area", "is-drop-blocked");
    d.float?.remove();
    d.el.classList.remove("is-drag-src");
    viewport.classList.remove("is-dragging");
    showSchedule(null);
    rebuildFromDraft();
  }
  // A drag can end without a pointerup: the browser takes the pointer over (a touch
  // scroll), or the button is let go outside the window. While `drag` is set nothing
  // renders, so a drag that never ended would freeze the board.
  window.addEventListener("pointercancel", cancelDrag, on);
  window.addEventListener("blur", cancelDrag, on);

  window.addEventListener("pointerup", ev => {
    const d = drag;
    drag = null;
    if (!d?.started) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (d.root) {
      d.float!.remove();
      d.el.classList.remove("is-drag-src");
      viewport.classList.remove("is-dragging");
      showSchedule(null);
      return void dropRoot(d.id, ev.clientX, ev.clientY);
    }
    d.hit?.el.classList.remove("is-drop-target", "is-drop-area", "is-drop-blocked");
    viewport.classList.remove("is-dragging");
    const fromRect = d.float!.getBoundingClientRect();
    d.float!.remove();
    d.el.classList.remove("is-drag-src");
    const from = new Map([[d.id, fromRect]]);
    const t = new R.Tree(baseMap(), reorg);
    const hit = d.hit;
    if (hit?.kind === "merge") return doReorg(R.merge(baseMap(), reorg, d.id, hit.id), from);
    if (hit?.kind === "area") {
      if (t.parentOf(d.id) === hit.id) return rebuildFromDraft(from); // stayed put
      return doReorg(R.insert(baseMap(), reorg, d.id, hit.id), from);
    }
    if (hit?.kind === "block") {
      flash("bubbles only merge within the same root task");
      return rebuildFromDraft(from);
    }
    doReorg(R.toRoot(baseMap(), reorg, d.id), from);
  }, on);

  // ─── rescheduling by dragging a root to a ring ───────────────────────────────
  // The ring under the pointer sets the date; this is the only way to set one. Today,
  // tomorrow and weekend are due dates. Within the month ring, distance from the centre
  // picks the day. The rim opens a date picker, for a scheduled (not due) date. The angle
  // is ignored: the bubble swims back to its own wedge. The overdue ring would mean a
  // date in the past, so it refuses, and dropping off the board cancels.
  type Schedule =
    | { band: Band; date: string; kind: "due" }
    | { band: "rim"; pick: true }
    | { band: "overdue" | null; refuse: string };

  const toBoard = (clientX: number, clientY: number) => {
    const c = camera.getBoundingClientRect();
    return { x: (clientX - c.left) / cam.z, y: (clientY - c.top) / cam.z };
  };

  function scheduleAt(clientX: number, clientY: number): Schedule {
    const p = toBoard(clientX, clientY);
    const r = Math.hypot(p.x - CX, p.y - CY);
    if (r > BAND.rim[1] + 40) return { band: null, refuse: "off the board · cancel" };
    // the gaps between rings belong to the nearer ring
    const dist = (b: Band) => (r < BAND[b][0] ? BAND[b][0] - r : r > BAND[b][1] ? r - BAND[b][1] : 0);
    const band = (Object.keys(BAND) as Band[]).reduce((a, b) => (dist(b) < dist(a) ? b : a));
    if (band === "overdue") return { band, refuse: "overdue · can't schedule in the past" };
    if (band === "rim") return { band, pick: true };
    if (band === "today") return { band, date: fmt(today), kind: "due" };
    if (band === "tomorrow") return { band, date: fmt(tomorrow), kind: "due" };
    if (band === "weekend") return { band, date: fmt(nextSat), kind: "due" };
    // month: inner edge = the day after the weekend, outer edge = a month out
    const [r0, r1] = BAND.month;
    const f = Math.min(1, Math.max(0, (r - r0) / (r1 - r0)));
    const first = addDays(weekendEnd, 1);
    const span = Math.round((+monthOut - +first) / 86400000);
    return { band, date: fmt(addDays(first, Math.round(f * span))), kind: "due" };
  }

  const scheduleLabel = (s: Schedule) =>
    "refuse" in s ? s.refuse : "pick" in s ? "later · pick a date" : `${BAND_LBL[s.band]} · 📅 ${short(toDate(s.date))}`;

  const dropHint = el("div", "drop-hint");
  dropHint.hidden = true;
  container.appendChild(dropHint);
  function showSchedule(clientX: number | null, clientY = 0) {
    const s = clientX === null ? null : scheduleAt(clientX, clientY);
    for (const lane of chrome.querySelectorAll<SVGElement>(".lane")) {
      lane.classList.toggle("is-hot", !!s && !("refuse" in s) && lane.dataset.band === s.band);
    }
    dropHint.hidden = !s;
    if (!s || clientX === null) return;
    dropHint.textContent = scheduleLabel(s);
    dropHint.classList.toggle("is-refused", "refuse" in s);
    dropHint.style.left = `${clientX + 18}px`;
    dropHint.style.top = `${clientY + 18}px`;
  }

  async function dropRoot(id: string, clientX: number, clientY: number) {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    const s = scheduleAt(clientX, clientY);
    if (!("refuse" in s)) { // start swimming from where it was let go
      const p = toBoard(clientX, clientY);
      Object.assign(n, { x: p.x, y: p.y, vx: 0, vy: 0, travelUntil: performance.now() + TRAVEL_MS });
      paint();
    }
    if ("refuse" in s) { if (s.band === "overdue") flash("can't schedule in the past"); return kick(); }
    if ("pick" in s) { focusPath = [id]; datePickFor = id; return sync(); } // the date picker
    kick();
    await setDate(n, s.date, s.kind);
  }

  // ─── motion ──────────────────────────────────────────────────────────────────
  // Subtask elements are rebuilt on every render, so motion is FLIP: remember where
  // each bubble was (by task id), render, then animate every bubble from its old place
  // to its new one. New bubbles fly out of their parent's centre; vanished ones are
  // drawn once more as a ghost that shrinks into whatever now holds them, or, when
  // they no longer exist (a pop), expands and fades.
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SPRING = "cubic-bezier(.34,1.45,.64,1)"; // back-out
  type Snap = Map<string, { el: HTMLElement; rect: DOMRect }>;

  function snapshot(override?: Map<string, DOMRect>): Snap {
    const out: Snap = new Map();
    for (const el of bubbles.querySelectorAll<HTMLElement>(".bubble[data-id]")) {
      out.set(el.dataset.id!, { el, rect: override?.get(el.dataset.id!) ?? el.getBoundingClientRect() });
    }
    // a bubble that wasn't drawn yet but has somewhere to come from (it was just named)
    for (const [id, rect] of override ?? []) if (!out.has(id)) out.set(id, { el: document.createElement("div"), rect });
    return out;
  }
  const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const parentId = (el: HTMLElement) => el.parentElement?.closest<HTMLElement>(".bubble[data-id]")?.dataset.id;

  function flip(before: Snap) {
    if (REDUCED || !booted) return;
    const after = snapshot();
    for (const [id, { el, rect }] of after) {
      if (!el.classList.contains("kid")) continue;
      const pid = parentId(el);
      const now = centre(rect);
      const pNow = pid ? after.get(pid) : undefined;
      const old = before.get(id);
      if (old) {
        // relative to the parent, so a kid doesn't also replay its parent's motion
        const o = centre(old.rect), pOld = pid ? before.get(pid) : undefined;
        const ref = pOld && pNow ? { x: centre(pOld.rect).x - centre(pNow.rect).x, y: centre(pOld.rect).y - centre(pNow.rect).y } : { x: 0, y: 0 };
        const dx = (o.x - now.x - ref.x) / cam.z, dy = (o.y - now.y - ref.y) / cam.z;
        const sc = old.rect.width / (rect.width || 1);
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sc - 1) < 0.01) continue;
        el.animate([{ transform: `translate(${dx}px,${dy}px) scale(${sc})` }, { transform: "none" }],
          { duration: 480, easing: SPRING });
      } else if (pNow) {
        const p = centre(pNow.rect);
        el.animate([
          { transform: `translate(${(p.x - now.x) / cam.z}px,${(p.y - now.y) / cam.z}px) scale(.15)`, opacity: 0 },
          { transform: "none", opacity: 1 },
        ], { duration: 520, easing: SPRING });
      }
    }
    for (const [id, old] of before) {
      if (after.has(id) || !old.el.classList.contains("kid")) continue;
      const pid = parentId(old.el);
      if (pid && before.has(pid) && !after.has(pid)) continue; // its parent's ghost carries it
      const n = findNode(id);
      // the nearest ancestor still on screen is where it went
      const dest = n ? [...n.chain].reverse().map(a => after.get(a)).find(Boolean) : undefined;
      ghost(old.el, old.rect, dest ? centre(dest.rect) : null);
    }
  }

  function ghost(src: HTMLElement, rect: DOMRect, into: { x: number; y: number } | null) {
    const g = src.cloneNode(true) as HTMLElement;
    g.classList.add("ghost");
    const vp = camera.getBoundingClientRect();
    g.style.left = `${(rect.left - vp.left) / cam.z}px`;
    g.style.top = `${(rect.top - vp.top) / cam.z}px`;
    g.style.width = g.style.height = `${rect.width / cam.z}px`;
    camera.appendChild(g);
    const c = centre(rect);
    const end = into
      ? { transform: `translate(${(into.x - c.x) / cam.z}px,${(into.y - c.y) / cam.z}px) scale(.15)`, opacity: 0 }
      : { transform: "scale(1.3)", opacity: 0 }; // a pop: the level bursts
    g.animate([{ transform: "none", opacity: 1 }, end], { duration: into ? 420 : 480, easing: "cubic-bezier(.33,1,.68,1)" })
      .finished.then(() => g.remove(), () => g.remove());
  }

  // ─── writing ─────────────────────────────────────────────────────────────────
  /** `born`: where on screen the task this creates should appear from. */
  async function run(tool: Exclude<DartboardTool, "undo_edit">, args: Record<string, unknown>, born?: DOMRect) {
    let edit: Edit;
    try {
      edit = await ctx.dispatch(tool, args, { correlationId: session.id });
    } catch (e) {
      flash(e instanceof CommandRejected ? `rejected: ${e.message}` : String(e));
      return false;
    }
    session.staged.push({ seq: edit.seq, type: edit.type, targets: edit.targets });
    saveSession();
    await refresh(born && edit.task_id ? new Map([[edit.task_id, born]]) : undefined);
    return true;
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

  async function setDate(n: BNode, value: string, kind: "due" | "scheduled") {
    if (n.date && fmt(n.date) === value && n.dateType === kind) return; // already there
    if (!(await run("set_attributes", { task_id: n.id, attrs: { date: value, date_kind: kind } }))) return;
    // The date is set, but the bubble swims back if a subtask is due sooner. Say why.
    const sub = deadlineBelow(n);
    if (sub && (kind === "scheduled" || sub.date! < toDate(value))) {
      flash(`date set · still placed by its subtask "${sub.text}", due ${short(sub.date!)}`, "info");
    }
  }

  async function onOp(n: BNode, op: Op) {
    if (op === "undo") {
      // ↺ on a parent undoes what changed beneath it too: the halo it clears is the subtree's.
      const ids = new Set(subtreeIds(n));
      return void undoStaged(s => s.targets.some(t => ids.has(t)));
    }
    if (op === "zap") {
      return n.zap
        ? run("unset_attributes", { task_id: n.id, keys: ["quick"] })
        : run("set_attributes", { task_id: n.id, attrs: { quick: true } });
    }
    if (op === "done") return n.done ? undefined : run("complete_task", { task_id: n.id });
    if (op === "discard") return discard(n);
  }

  /** Discard a task, and with it everything under it: the server won't discard a task
   *  that still has subtasks, so they go first, deepest first. The list comes from the
   *  database rather than the board, so subtasks that aren't drawn (released ones) go
   *  too. One click, like every edit here, and one click back: the message offers undo,
   *  and so does ↺ on the bubble it was in. */
  async function discard(n: BNode) {
    const under = (id: string): string[] => tasksCache
      .filter(t => t.parent_id === id && t.state !== "discarded")
      .flatMap(t => [...under(t.id), t.id]);
    const ids = [...under(n.id), n.id];
    // The draft is laid over the database, so a task it moves isn't where the database
    // says. Discarding one would leave the draft pointing at nothing.
    const inSubtree = new Set(ids);
    const drafted = [...reorg.nodes].some(([id, e]) => inSubtree.has(id) || (e.parent !== null && inSubtree.has(e.parent)))
      || ids.some(id => reorg.removed.has(id));
    if (drafted) return flash("this is being reorganised · apply or discard that first");
    const seqs: number[] = [];
    for (const id of ids) {
      try {
        const edit = await ctx.dispatch("discard_task", { task_id: id }, { correlationId: session.id });
        session.staged.push({ seq: edit.seq, type: edit.type, targets: edit.targets });
        seqs.push(edit.seq);
      } catch (e) {
        flash(e instanceof CommandRejected ? `rejected: ${e.message}` : String(e));
        break;
      }
    }
    saveSession();
    const wasOpen = focusPath.length > 0;
    await refresh();
    if (wasOpen && !focusPath.length) sendHome(); // it was the open root
    if (seqs.length < ids.length) return; // stopped part-way: the reason is on screen
    const rest = ids.length - 1;
    flash(`discarded "${n.text}"${rest ? ` and its ${rest} subtask${rest === 1 ? "" : "s"}` : ""}`, "info",
      { label: "undo", run: () => void undoStaged(s => seqs.includes(s.seq)) });
  }

  /** `action`: a button in the message, for the one thing worth doing about it. */
  function flash(msg: string, kind: "error" | "info" = "error", action?: { label: string; run: () => void }) {
    const f = $("flash");
    f.replaceChildren(msg);
    if (action) {
      const b = el("button", "flash-act", action.label);
      b.addEventListener("click", () => { f.hidden = true; action.run(); });
      f.append(b);
    }
    f.hidden = false;
    f.classList.toggle("is-info", kind === "info");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { f.hidden = true; }, action ? 8000 : 4000);
  }
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  // ─── rendering ───────────────────────────────────────────────────────────────
  // full DOM refresh — cheap at this size, and only on state change (not per frame)
  function render(before: Snap = snapshot()) {
    if (drag?.started) return; // a render would destroy the bubble being dragged
    if (nodes.map(n => n.id).join() !== builtIds) buildBubbles();
    for (const n of nodes) paintBubble(n, gfx.get(n.id));
    fitTitles();
    drawHud();
    paintToolbar();
    restoreCaret();
    flip(before);
  }

  const dateLabel = (n: BNode) => (n.date ? `${n.dateType === "scheduled" ? "⏳" : "📅"} ${short(n.date)}` : "no date");
  /** For a root placed by a subtask's deadline rather than its own date: which one. */
  const placedBy = (n: BNode) => (n.deadline && n.deadline !== n ? `subtask due ${short(n.deadline.date!)}` : "");

  const brokenDown = (n: BNode) => (n.children.length ? `${n.load} open subtask${n.load === 1 ? "" : "s"}` : "not broken down");

  function paintBubble(n: BNode, e: Elems | undefined) {
    if (!e) return;
    const st = stateOf(n);
    const isRoot = n.depth === 0;
    const band = isRoot ? (n as Root).band : null;
    const hidden = isRoot && isHidden(n as Root);
    const faded = isRoot && !hidden && isLater(n as Root) && st === "idle";
    e.g.className = `bubble${isRoot ? "" : " kid is-d" + Math.min(n.depth, SIZE_LEVELS)}` +
      `${n.children.length ? " has-kids" : ""}${band === "overdue" ? " is-overdue" : ""}` +
      `${st !== "idle" ? " is-" + st : ""}${n.pending ? " is-pending" : ""}${n.done ? " is-done" : ""}` +
      `${n.drafted ? " is-drafted" : ""}${n.synthetic ? " is-synthetic" : ""}` +
      `${hidden ? " is-hidden" : ""}${faded ? " is-later" : ""}`;
    e.g.dataset.id = n.id;
    e.text.textContent = n.text;
    e.zap.style.display = n.zap && st === "idle" ? "block" : "none"; // open, the ⚡ control shows it
    // Only what isn't already on show: an open bubble's subtasks are right there.
    const meta = isRoot ? [n.section, dateLabel(n), placedBy(n)] : [n.date ? dateLabel(n) : ""];
    e.meta.textContent = meta.filter(Boolean).join(" · ");
    e.meta.style.display = st === "idle" || !e.meta.textContent ? "none" : "block";
    e.g.title = isRoot
      ? `${n.text}\n${[n.section || "—", dateLabel(n), n.deadline && n.deadline !== n ? `placed by "${n.deadline.text}", due ${short(n.deadline.date!)}` : ""].filter(Boolean).join(" · ")}\n${brokenDown(n)}`
      : `${n.text}\n${brokenDown(n)}`;

    for (const op of OPS) e.btns.get(op.op)!.style.display = opVisible(n, op) ? "" : "none";
    e.add.style.display = slotOf(n) === "add" ? "" : "none";
    if (st === "open") placeControls(n, e);
    e.btns.get("zap")!.classList.toggle("is-on", n.zap);
    e.btns.get("done")!.classList.toggle("is-on", n.done);

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
      if (slotOf(n) === "naming") {
        namer.style.width = namer.style.height = slotDiam(n) + "px";
        namer.className = `bubble kid is-naming is-d${Math.min(n.depth + 1, SIZE_LEVELS)}`;
        e.kids.appendChild(namer);
      }
    }
  }

  /** Put an open bubble's controls on its rim: the edits in a row along the bottom,
   *  centred on the lowest point and following the curve, and the ＋ at the top, opposite
   *  them. The middle is left to the name and the subtasks. */
  function placeControls(n: BNode, e: Elems) {
    const d = Math.min(n.depth, SIZE_LEVELS), btn = BTN[d];
    // the circle the controls' centres sit on (the border is a few px; near enough)
    const orbit = diamOf(n) / 2 - 4 - BTN_INSET[d] - btn / 2;
    const at = (b: HTMLElement, angle: number) => {
      b.style.left = `calc(50% + ${(Math.cos(angle) * orbit).toFixed(1)}px)`;
      b.style.top = `calc(50% + ${(Math.sin(angle) * orbit).toFixed(1)}px)`;
    };
    e.g.style.setProperty("--btn", `${btn}px`);
    const shown = OPS.filter(op => opVisible(n, op)).map(op => e.btns.get(op.op)!);
    const step = (btn + BTN_GAP[d]) / orbit; // radians between neighbours
    // y points down, so 90° is the bottom, and left of it is a larger angle
    shown.forEach((b, i) => at(b, Math.PI / 2 - (i - (shown.length - 1) / 2) * step));
    at(e.add, -Math.PI / 2);
  }

  /** Break every drawn title to fit its circle (see breakTitle). paintBubble leaves each
   *  title on one line; here they are all measured, then all rewritten, so the browser
   *  lays the board out once rather than once per bubble. A bubble's size doesn't depend
   *  on its title, so no bubble's answer changes another's. */
  function fitTitles() {
    paint(); // roots get their size from the simulation; a title is measured against it
    const jobs: { text: HTMLElement; words: string[]; box: TitleBox; maxLines: number }[] = [];
    for (const e of gfx.values()) {
      if (!e.g.isConnected || !e.g.clientWidth) continue; // not drawn
      const words = (e.text.textContent ?? "").split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const cs = getComputedStyle(e.text), fontSize = parseFloat(cs.fontSize);
      const inner = e.g.clientWidth / 2; // inside the border
      jobs.push({
        text: e.text, words,
        maxLines: e.g.classList.contains("is-open") ? MAX_LINES.open : MAX_LINES.idle,
        box: {
          r: inner - Math.max(2, inner * 0.06), cy: e.g.clientHeight / 2,
          top: e.text.offsetTop, lineHeight: e.text.offsetHeight, fontSize,
          font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
        },
      });
    }
    for (const j of jobs) {
      const lines = breakTitle(j.words, j.box, j.maxLines);
      j.text.replaceChildren(...lines.map((ln, i) => {
        // the space keeps the element's text the title, however it is broken
        const span = el("span", "ln", i < lines.length - 1 ? `${ln.text} ` : ln.text);
        span.style.maxWidth = `${Math.floor(ln.max)}px`;
        return span;
      }));
    }
  }

  /** A render takes the focused field out of the document; put the caret back. */
  function restoreCaret() {
    if (namingIn) {
      // At once, not on the next frame: a key pressed in between would go nowhere.
      if (!namer.isConnected) return;
      fitNameBox();
      if (document.activeElement !== nameBox) nameBox.focus({ preventScroll: true });
      return;
    }
    const t = tail(), e = t ? gfx.get(t) : undefined;
    if (e && datePickFor === t) requestAnimationFrame(() => e.dinput.focus());
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
    const shown = nodes.filter(n => !isHidden(n)), hiddenN = nodes.length - shown.length;
    const counts = shown.reduce<Partial<Record<Band, number>>>((a, n) => ((a[n.band] = (a[n.band] ?? 0) + 1), a), {});
    const changed = session.staged.length;
    hud.replaceChildren();
    hud.append(el("div", "count", `${hiddenN ? `${shown.length} of ${nodes.length}` : nodes.length} root tasks · ${fmt(today)}`));
    hud.append(el("div", "bands", (Object.keys(BAND) as Band[]).filter(b => counts[b]).map(b => `${BAND_LBL[b]} ${counts[b]}`).join(" · ")));
    if (hiddenN) hud.append(el("div", "later", `${hiddenN} past the weekend or undated, hidden · L shows them`));
    if (changed) hud.append(el("div", "pending", `${changed} change${changed === 1 ? "" : "s"} this session · ↺ undoes`));
    if (draftId || !R.isNoop(reorg)) {
      const left = draftDue === null ? null : Math.max(0, Math.ceil((draftDue - performance.now()) / 1000));
      hud.append(el("div", "draft", held || left === null
        ? "reorganising · applies once you close the bubble"
        : left > 0 ? `reorganised · applies in ${left}s` : "reorganised · applying…"));
    }
    const pops = reorg.memory.filter(m => !m.forgotten).length;
    if (pops) hud.append(el("div", "draft", `${pops} popped · collapse brings back ${R.wouldRestore(baseMap(), reorg).size}`));
    hud.append(el("div", "keys", "click to open · click a subtask to go deeper · ＋ adds a subtask · esc backs out · scroll to zoom · 0 to fit · L shows later · S sizes by subtasks"));
    hud.append(el("div", "keys", "drag a bubble to a ring to reschedule · drag a subtask onto another to merge · click an open subtask's space to pop it"));
  }

  // ─── toolbar — add task / reset all ──────────────────────────────────────────
  // Persistent DOM, built once (unlike #hud, rebuilt every render — that would
  // blow away focus and typed text in these inputs).
  const addBtn = $<HTMLButtonElement>("addBtn"), resetBtn = $<HTMLButtonElement>("resetBtn");
  const addPanel = $("addPanel"), catRow = $("catRow");
  const sectionInput = $<HTMLInputElement>("sectionInput"), textInput = $<HTMLInputElement>("textInput");
  const sectionOptions = $("sectionOptions");
  const collapseBtn = $<HTMLButtonElement>("collapseBtn");
  const applyBtn = $<HTMLButtonElement>("applyBtn"), discardDraftBtn = $<HTMLButtonElement>("discardDraftBtn");
  const laterBtn = $<HTMLButtonElement>("laterBtn");
  laterBtn.addEventListener("click", () => setShowLater(!showLater), on);
  collapseBtn.addEventListener("click", collapseAll, on);
  applyBtn.addEventListener("click", () => void applyNow(), on);
  discardDraftBtn.addEventListener("click", () => void discardDraft(), on);
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
    if (namingIn) { endNaming(); sync(); } // or the next render would take the caret back
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

  /** Show or hide what is past the coming weekend. Only what is drawn changes. */
  function setShowLater(show: boolean) {
    const was = new Set(nodes.filter(isHidden).map(n => n.id));
    showLater = show;
    try { sessionStorage.setItem(LATER_KEY, show ? "1" : "0"); } catch { /* private mode */ }
    render();
    if (REDUCED) return;
    for (const n of nodes) {
      if (was.has(n.id) && !isHidden(n)) gfx.get(n.id)?.g.animate([{ opacity: 0 }, {}], { duration: 220, easing: "ease-out" });
    }
  }

  /** PROTOTYPE: closed bubbles sized by their open subtasks, or all one size. */
  function setSizeByLoad(on: boolean) {
    sizeByLoad = on;
    try { sessionStorage.setItem(FLAT_KEY, on ? "0" : "1"); } catch { /* private mode */ }
    sync();
    sendHome(); // bubbles that shrank leave gaps; the others close up
    flash(on ? "bubbles sized by their open subtasks · S for one size" : "bubbles all one size · S to size by subtasks", "info");
  }

  function paintToolbar() {
    const later = nodes.filter(n => LATER.has(n.band)).length;
    laterBtn.textContent = showLater ? "hide later" : later ? `show later · ${later}` : "show later";
    laterBtn.setAttribute("aria-pressed", String(showLater));
    laterBtn.classList.toggle("is-on", showLater);
    addPanel.hidden = !addTaskOpen;
    addBtn.textContent = addTaskOpen ? "× close" : "+ add";
    for (const b of catRow.children) b.classList.toggle("is-selected", (b as HTMLElement).dataset.cat === selectedCategory);
    resetBtn.hidden = session.staged.length === 0 && !resetConfirming;
    resetBtn.textContent = resetConfirming ? "confirm reset?" : "↺ reset all";
    resetBtn.classList.toggle("is-confirming", resetConfirming);
    const restorable = R.wouldRestore(baseMap(), reorg).size;
    collapseBtn.hidden = !restorable;
    collapseBtn.textContent = `collapse · restore ${restorable}`;
    const drafting = !!draftId || !R.isNoop(reorg);
    applyBtn.hidden = discardDraftBtn.hidden = !drafting;
  }

  // ─── loop ────────────────────────────────────────────────────────────────────
  // Boot settles synchronously; interaction animates. rAF delivers a variable number
  // of frames, so an animated boot would land differently every load and break the
  // spatial memory the board depends on.
  // Boot cools more slowly than interaction, for a well-settled first layout; it is a
  // fixed number of steps, so the same tasks always land in the same places.
  const MAX_SETTLE = 900;
  const BOOT_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / MAX_SETTLE);
  let alpha = 0;
  function settleNow() {
    for (let a = 1; a > ALPHA_MIN; a *= 1 - BOOT_DECAY) tick(a);
  }
  let raf: number | null = null;
  let physFrames = 0; // frames since the last kick, for tests
  function kick(heat = REHEAT) { alpha = Math.max(alpha, heat); physFrames = 0; if (!raf) raf = requestAnimationFrame(loop); }
  /** Is it inside its band and (if it has a category) its wedge? */
  function isHome(n: Root) {
    const dx = n.x - CX, dy = n.y - CY, r = Math.hypot(dx, dy);
    if (r < n.r0 - 6 || r > n.r1 + 6) return false;
    if (!n.category || !(n.category in QUAD)) return true;
    let da = Math.atan2(dy, dx) - (QUAD[n.category] * Math.PI) / 180;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    return Math.abs(da) <= ((HALF_WEDGE + 4) * Math.PI) / 180;
  }
  function loop() {
    physFrames++;
    const now = performance.now();
    for (const n of nodes) if (n.travelUntil && (now > n.travelUntil || isHome(n))) n.travelUntil = 0;
    const travelling = nodes.some(n => n.travelUntil);
    const ke = tick(alpha);
    alpha += ((travelling ? TRAVEL_HEAT : 0) - alpha) * ALPHA_DECAY;
    paint();
    if (!travelling && alpha < ALPHA_MIN && ke < KE_FLOOR) { alpha = 0; raf = null; return; }
    raf = requestAnimationFrame(loop);
  }

  async function refresh(from?: Map<string, DOMRect>) {
    tasksCache = (await ctx.tasks()).tasks;
    rebuildFromDraft(from);
  }

  // ─── boot ────────────────────────────────────────────────────────────────────
  let booted = false;
  async function boot() {
    stampClock();
    tasksCache = (await ctx.tasks()).tasks;
    // A draft still settling (e.g. across a reload) is laid back over the tasks.
    const open = await ctx.drafts.open().catch(() => []);
    const mine = open.find(d => d.id === draftId) ?? open.at(-1);
    if (mine) { setDraftId(mine.id); reorg = R.fromStructure(mine.after); draftDue = performance.now() + SETTLE_MS; }
    else setDraftId(null);
    build(R.effectiveTasks(tasksCache, reorg));
    settleNow();
    drawChrome(); buildBubbles(); render(); paint(); fitCam();
    viewport.dataset.ready = "1";
    booted = true;
  }

  boot().catch(e => {
    container.innerHTML = `<div class="fatal"><b>misty server not running</b><div>start it:</div><code>uv run misty serve</code><div class="err"></div></div>`;
    container.querySelector(".err")!.textContent = String(e?.message ?? e);
  });

  // test seams — assertions only. Interaction must go through real clicks.
  const summarise = (n: BNode): object => ({
    id: n.id, text: n.text, depth: n.depth, state: stateOf(n), zap: n.zap, done: n.done,
    pending: n.pending, load: n.load, children: n.children.map(summarise),
  });
  const w = window as unknown as Record<string, unknown>;
  w.__state = () => nodes.map(n => ({ ...summarise(n), band: n.band, category: n.category, dateType: n.dateType, hidden: isHidden(n) }));
  w.__focus = () => ({ path: [...focusPath] });
  w.__session = () => ({ id: session.id, staged: session.staged.map(s => ({ ...s })) });
  w.__physics = () => ({ running: raf !== null, frames: physFrames });
  w.__sizes = () => Object.fromEntries(nodes.map(n => [n.text, Math.round(n.r * 2)]));
  w.__draft = () => ({ id: draftId, structure: R.toStructure(reorg), memory: reorg.memory.map(m => ({ ...m })) });
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
    clearInterval(pollTimer);
    container.replaceChildren();
    container.classList.remove("dartboard");
  };
}
