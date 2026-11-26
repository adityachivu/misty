// The view: copies the scene to the DOM and turns input into state transitions.
// It decides no positions (scene.ts does) and talks to no server (sync.ts does).
//
// Elements are persistent: one per task for as long as it is drawn, found by id and
// updated in place, never rebuilt. Pointer hits on bubbles are resolved against the
// scene's geometry, so they don't depend on where a transition has got to.

import "./dartboard2.css";
import type { ViewContext } from "../types";
import {
  addDays, asDate, dropFor, dropLabel, isoOf, mmdd, MONTH_DAYS, NEAR_RINGS, ringFor, RINGS, weekday,
  type Ring,
} from "./dates";
import { fitLabel, fitTitle, type Measure } from "./fit";
import { depth, ringAt } from "./layout";
import {
  buildTree, CATEGORIES, discardOrder, drawnChildren, oneLine, placement, scopeOf, sectionsIn,
  type Tree,
} from "./model";
import { collapse, collapsible, makeRoot, merge, moveInto, pop, touchedIds, type Outcome } from "./reorg";
import {
  buildScene, canReschedule, hitTest, marks, subDrop, validChain,
  type Bubble, type Control, type ControlKind, type Field, type Hit, type Scene, type SubDrop, type UiState,
} from "./scene";
import { KEYS, openSession, readFlag, writeFlag } from "./session";
import { createSync, type BoardTool } from "./sync";

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Title and meta font sizes by depth, closed and open. */
const CLOSED_FONT = [13, 11, 9.5];
const OPEN_FONT = [15, 13, 11.5];
const META_FONT = [10.5, 9.5, 9];
const LINE = 1.18;
const DRAG_THRESHOLD = 5;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SVG = "http://www.w3.org/2000/svg";

const CONTROL_TEXT: Record<ControlKind, { glyph: string; label: string }> = {
  add: { glyph: "＋", label: "add a subtask" },
  quick: { glyph: "⚡", label: "quick task (15 minutes or less)" },
  complete: { glyph: "✓", label: "mark done" },
  discard: { glyph: "✕", label: "discard this task and its subtasks" },
  undo: { glyph: "↺", label: "undo this session's changes here" },
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  if (className) el.setAttribute("class", className);
  return el;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface BubbleEl {
  el: HTMLDivElement;
  label: HTMLDivElement;
  fitKey: string;
}

interface FieldEl {
  el: HTMLDivElement;
  input: HTMLInputElement;
}

interface Press {
  pointerId: number;
  sx: number;
  sy: number;
  lastX: number;
  lastY: number;
  hit: Hit | null;
  mode: "press" | "pan" | "root" | "sub";
  id: string | null;
  /** Pointer's offset from the dragged bubble's centre, in world units. */
  ox: number;
  oy: number;
}

export function mountBoard(host: HTMLElement, ctx: ViewContext<BoardTool>): () => void {
  // ─── static structure ──────────────────────────────────────────────────────
  const root = h("div", "db2");
  root.style.setProperty("--db2-font", FONT);
  const board = h("div", "db2-board");
  const world = h("div", "db2-world");
  const rings = svg("svg", "db2-rings");
  const bubbleLayer = h("div", "db2-bubbles");
  const controlLayer = h("div", "db2-controls");
  world.append(rings, bubbleLayer, controlLayer);
  board.append(world);

  const hud = h("div", "db2-hud");
  const hudMain = h("div", "db2-hud-main");
  const hudRings = h("div", "db2-hud-rings");
  const hudExtra = h("div", "db2-hud-extra");
  const hudDraft = h("div", "db2-hud-draft");
  hudDraft.setAttribute("role", "status");
  hud.append(hudMain, hudRings, hudExtra, hudDraft);

  const toolbar = h("div", "db2-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "board");
  const tool = (name: string, text: string, title: string): HTMLButtonElement => {
    const b = h("button", "db2-tool", text);
    b.type = "button";
    b.dataset.tool = name;
    b.title = title;
    toolbar.append(b);
    return b;
  };
  const laterBtn = tool("later", "show later", "show or hide the month and later rings (L)");
  const addBtn = tool("add", "+ add", "add a task");
  const collapseBtn = tool("collapse", "collapse", "close everything and bring back the levels you dissolved");
  const applyBtn = tool("apply", "✓ apply now", "apply the reorganisation now");
  const discardBtn = tool("discard", "✕ discard", "throw the reorganisation away");
  const resetBtn = tool("reset", "↺ reset all", "undo everything done in this session");
  const fitBtn = tool("fit", "fit", "fit the board to the window (0)");

  const panel = h("div", "db2-panel");
  panel.hidden = true;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "add a task");
  const catRow = h("div", "db2-cats");
  const catBtns = new Map<string, HTMLButtonElement>();
  for (const c of CATEGORIES) {
    const b = h("button", `db2-cat db2-c-${c}`, c);
    b.type = "button";
    b.dataset.category = c;
    catBtns.set(c, b);
    catRow.append(b);
  }
  const sectionInput = h("input", "db2-panel-section");
  sectionInput.type = "text";
  sectionInput.placeholder = "section (optional)";
  sectionInput.setAttribute("aria-label", "section");
  const sectionList = h("datalist");
  sectionList.id = `db2-sections-${Math.random().toString(36).slice(2)}`;
  sectionInput.setAttribute("list", sectionList.id);
  const titleInput = h("input", "db2-panel-title");
  titleInput.type = "text";
  titleInput.placeholder = "new task, then Enter";
  titleInput.setAttribute("aria-label", "title of the new task");
  panel.append(catRow, sectionInput, sectionList, titleInput);

  const msg = h("div", "db2-msg");
  msg.hidden = true;
  msg.setAttribute("role", "status");
  const msgText = h("span", "db2-msg-text");
  const msgBtn = h("button", "db2-msg-action");
  msgBtn.type = "button";
  msg.append(msgText, msgBtn);

  const dragLabel = h("div", "db2-draglabel");
  dragLabel.hidden = true;

  root.append(board, hud, toolbar, panel, msg, dragLabel);
  host.append(root);

  // The rings: one element per band, updated in place.
  const axes = svg("path", "db2-axes");
  rings.append(axes);
  const bandEls = new Map<Ring, { shape: SVGCircleElement; label: SVGTextElement }>();
  for (const ring of [...RINGS].reverse()) {
    const shape = svg("circle", `db2-band db2-band-${ring}`);
    shape.dataset.ring = ring;
    rings.append(shape);
    bandEls.set(ring, { shape, label: svg("text", "db2-ringlabel") });
  }
  for (const ring of RINGS) {
    const { label } = bandEls.get(ring)!;
    label.textContent = ring;
    rings.append(label);
  }
  const quadrantEls = CATEGORIES.map(c => {
    const t = svg("text", `db2-quadlabel db2-c-${c}`);
    t.textContent = c;
    rings.append(t);
    return t;
  });

  // ─── state ─────────────────────────────────────────────────────────────────
  const store = window.sessionStorage;
  const session = openSession(store, () => crypto.randomUUID());
  const ui: UiState = {
    chain: [], adding: null, dating: null,
    showLater: readFlag(store, KEYS.showLater),
    oneSize: readFlag(store, KEYS.oneSize),
  };
  const camera = { k: 1, tx: 0, ty: 0, auto: true };
  let scene: Scene | null = null;
  let tree: Tree = buildTree([]);
  let press: Press | null = null;
  let category: string = "work";
  let resetArmed: number | null = null;
  let msgTimer: number | null = null;
  let msgAction: (() => void) | null = null;
  let acting: Promise<void> = Promise.resolve();
  let disposed = false;

  const bubbleEls = new Map<string, BubbleEl>();
  const controlEls = new Map<string, HTMLButtonElement>();
  const fieldEls = new Map<string, FieldEl>();

  const sync = createSync(ctx, session, store, {
    data: onData,
    status: () => { renderHud(); renderToolbar(); },
    message: text => say(text),
  }, {
    now: () => performance.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: handle => window.clearInterval(handle as number),
  });

  // ─── text measuring ────────────────────────────────────────────────────────
  const canvas = document.createElement("canvas").getContext("2d");
  const widths = new Map<string, number>();
  const measurer = (weight: number, size: number): Measure => text => {
    const key = `${weight}/${size}/${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      if (canvas) {
        canvas.font = `${weight} ${size}px ${FONT}`;
        w = canvas.measureText(text).width + 1.5;
      } else {
        w = text.length * size * 0.62;
      }
      widths.set(key, w);
    }
    return w;
  };

  // ─── messages ──────────────────────────────────────────────────────────────
  function say(text: string, action?: { label: string; run: () => void }): void {
    if (disposed) return;
    msgText.textContent = text;
    msgAction = action ? action.run : null;
    msgBtn.hidden = !action;
    msgBtn.textContent = action ? action.label : "";
    msg.hidden = false;
    if (msgTimer !== null) window.clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => {
      msg.hidden = true;
      msgAction = null;
      msgTimer = null;
    }, action ? 8000 : 6000);
  }
  msgBtn.addEventListener("click", () => {
    const run = msgAction;
    msg.hidden = true;
    msgAction = null;
    run?.();
  });

  /**
   * Run commands one user action at a time, then reload. `job` may return something
   * to do once the fresh data is in.
   */
  function act(job: () => Promise<(() => void) | void>): Promise<void> {
    acting = acting.then(async () => {
      let after: (() => void) | void = undefined;
      try {
        after = await job();
      } catch (e) {
        say(errorText(e));
      }
      try {
        await sync.refresh();
      } catch (e) {
        say(`couldn't reload: ${errorText(e)}`);
      }
      if (after && !disposed) after();
    });
    return acting;
  }

  // ─── state transitions ─────────────────────────────────────────────────────
  /** The draft is held while a bubble is open or a bubble is being dragged. */
  function syncHold(): void {
    sync.setHeld(ui.chain.length > 0 || press?.mode === "root" || press?.mode === "sub");
  }

  function setChain(next: string[]): void {
    ui.chain = next;
    if (ui.adding && !next.includes(ui.adding)) ui.adding = null;
    if (ui.dating && next[0] !== ui.dating) ui.dating = null;
    syncHold();
    render();
  }

  /** Fresh tasks (or a draft settled): close what can't be open any more, and draw. */
  function onData(): void {
    if (disposed) return;
    tree = buildTree(sync.tasks(), sync.reorg());
    const valid = validChain(tree, ui.chain, session.changed());
    if (valid.length !== ui.chain.length) {
      ui.chain = valid;
      if (ui.adding && !valid.includes(ui.adding)) ui.adding = null;
      if (ui.dating && valid[0] !== ui.dating) ui.dating = null;
      syncHold();
    }
    render();
    root.dataset.head = String(sync.headSeq());
    root.dataset.ready = "1";
  }

  function applyOutcome(o: Outcome): boolean {
    if (o.kind === "refused") say(o.message);
    if (o.kind !== "changed") return false;
    sync.change(o.reorg, o.op);
    return true;
  }

  // ─── drawing ───────────────────────────────────────────────────────────────
  function render(): void {
    if (disposed) return;
    const tasks = sync.tasks();
    const reorg = sync.reorg();
    tree = buildTree(tasks, reorg);
    const changed = session.changed();
    const { halo, touched } = marks(tasks, tree, reorg, changed);
    scene = buildScene({ tree, ui, today: isoOf(new Date()), changed, halo, touched });
    drawRings(scene);
    drawBubbles(scene);
    drawControls(scene);
    drawFields(scene);
    renderHud();
    renderToolbar();
    if (camera.auto) fit();
  }

  function drawRings(s: Scene): void {
    const R = s.radius;
    axes.setAttribute("d", `M${-R} 0H${R}M0 ${-R}V${R}`);
    for (const b of s.bands) {
      const { shape, label } = bandEls.get(b.ring)!;
      const mid = (b.inner + b.outer) / 2;
      if (b.inner === 0) {
        shape.setAttribute("r", String(b.outer));
        shape.setAttribute("stroke-width", "0");
        shape.classList.add("db2-disc");
      } else {
        shape.setAttribute("r", String(mid));
        shape.setAttribute("stroke-width", String(b.outer - b.inner));
      }
      // Names read left to right, along the axis to the right of the centre. The strip
      // between the quadrants there is always clear of bubbles.
      label.setAttribute("transform", `translate(${mid} 0)`);
      shape.dataset.inner = String(b.inner);
      shape.dataset.outer = String(b.outer);
    }
    const d = (R + 30) * Math.SQRT1_2;
    const corners = [[-d, -d], [d, -d], [d, d], [-d, d]];
    quadrantEls.forEach((t, i) => {
      t.setAttribute("x", String(corners[i][0]));
      t.setAttribute("y", String(corners[i][1]));
      t.setAttribute("text-anchor", corners[i][0] < 0 ? "end" : "start");
    });
  }

  function drawBubbles(s: Scene): void {
    const openRoot = ui.chain[0];
    for (const b of s.bubbles) {
      let e = bubbleEls.get(b.id);
      if (!e) {
        const el = h("div", "db2-bubble");
        el.dataset.id = b.id;
        el.setAttribute("role", "button");
        el.tabIndex = 0;
        const label = h("div", "db2-label");
        const quick = h("span", "db2-quick", "⚡");
        quick.setAttribute("aria-hidden", "true");
        el.append(label, quick);
        bubbleLayer.append(el);
        e = { el, label, fitKey: "" };
        bubbleEls.set(b.id, e);
      }
      const { el } = e;
      const dragging = press?.id === b.id && (press.mode === "root" || press.mode === "sub");
      if (!dragging) el.style.transform = `translate(${b.x - b.r}px, ${b.y - b.r}px)`;
      el.style.width = el.style.height = `${2 * b.r}px`;
      el.style.zIndex = String(b.z);
      const d = depth(b.level);
      const on = (name: string, yes: boolean): void => { el.classList.toggle(name, yes); };
      on("db2-open", b.open);
      on("db2-root", b.root);
      on("db2-l0", d === 0);
      on("db2-l1", d === 1);
      on("db2-l2", d === 2);
      on("db2-done", b.done);
      on("db2-overdue", b.overdue);
      on("db2-solid", b.hasSubs);
      on("db2-halo", b.halo);
      on("db2-draft", b.draft);
      on("db2-faded", b.faded);
      on("db2-isquick", b.quick);
      on("db2-dating", b.dating);
      on("db2-dim", openRoot !== undefined && b.rootId !== openRoot);
      for (const c of CATEGORIES) on(`db2-c-${c}`, b.category === c);
      el.title = b.title;
      el.setAttribute("aria-label", b.title);
      el.setAttribute("aria-expanded", String(b.open));
      el.dataset.x = b.x.toFixed(2);
      el.dataset.y = b.y.toFixed(2);
      el.dataset.r = b.r.toFixed(2);
      el.dataset.open = b.open ? "1" : "0";
      el.dataset.level = String(b.level);
      if (b.ring) el.dataset.ring = b.ring; else delete el.dataset.ring;
      setLabel(e, b);
    }
    for (const [id, e] of bubbleEls) {
      if (s.byId.has(id)) continue;
      e.el.remove();
      bubbleEls.delete(id);
    }
  }

  function setLabel(e: BubbleEl, b: Bubble): void {
    const key = [b.title, b.meta, b.labelR.toFixed(1), b.level, b.open ? 1 : 0].join("\u0001");
    if (e.fitKey === key) return;
    e.fitKey = key;
    const d = depth(b.level);
    const size = b.open ? OPEN_FONT[d] : CLOSED_FONT[d];
    const lh = Math.round(size * LINE * 10) / 10;
    const mlh = Math.round(META_FONT[d] * LINE * 10) / 10;
    const fit = b.open
      ? fitLabel(b.title, b.meta, b.labelR, lh, mlh, measurer(600, size), measurer(400, META_FONT[d]))
      : { title: fitTitle(b.title, b.labelR, lh, measurer(600, size)), meta: { lines: [] as string[], truncated: false } };
    e.label.style.setProperty("--fs", `${size}px`);
    e.label.style.setProperty("--lh", `${lh}px`);
    e.label.style.setProperty("--mfs", `${META_FONT[d]}px`);
    e.label.style.setProperty("--mlh", `${mlh}px`);
    e.label.replaceChildren(
      ...fit.title.lines.map(line => h("div", "db2-t", line)),
      ...fit.meta.lines.map(line => h("div", "db2-m", line)),
    );
  }

  function drawControls(s: Scene): void {
    const seen = new Set<string>();
    for (const c of s.controls) {
      seen.add(c.key);
      let el = controlEls.get(c.key);
      if (!el) {
        el = h("button", `db2-ctl db2-ctl-${c.kind}`, CONTROL_TEXT[c.kind].glyph);
        el.type = "button";
        el.dataset.kind = c.kind;
        el.dataset.id = c.id;
        el.title = CONTROL_TEXT[c.kind].label;
        el.setAttribute("aria-label", CONTROL_TEXT[c.kind].label);
        const control: Control = c;
        el.addEventListener("click", () => onControl(control.kind, control.id));
        controlLayer.append(el);
        controlEls.set(c.key, el);
      }
      el.style.left = `${c.x}px`;
      el.style.top = `${c.y}px`;
      el.style.zIndex = String(c.z);
      if (c.kind === "quick") el.setAttribute("aria-pressed", String(c.on));
    }
    for (const [key, el] of controlEls) {
      if (seen.has(key)) continue;
      el.remove();
      controlEls.delete(key);
    }
  }

  function drawFields(s: Scene): void {
    const seen = new Set<string>();
    for (const f of s.fields) {
      seen.add(f.key);
      let e = fieldEls.get(f.key);
      if (!e) {
        e = f.kind === "new" ? makeNewField(f) : makeDateField(f);
        controlLayer.append(e.el);
        fieldEls.set(f.key, e);
        e.input.focus({ preventScroll: true });
      }
      e.el.style.left = `${f.x}px`;
      e.el.style.top = `${f.y}px`;
      e.el.style.zIndex = String(f.z);
      if (f.kind === "new") e.el.style.width = e.el.style.height = `${2 * f.r}px`;
    }
    for (const [key, e] of fieldEls) {
      if (seen.has(key)) continue;
      e.el.remove();
      fieldEls.delete(key);
    }
  }

  function makeNewField(f: Field): FieldEl {
    const el = h("div", "db2-new");
    el.dataset.parent = f.id;
    const input = h("input");
    input.type = "text";
    input.placeholder = "new subtask";
    input.setAttribute("aria-label", "title of the new subtask");
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        endAdding(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        endAdding(false, false);
      }
    });
    el.append(input);
    return { el, input };
  }

  function makeDateField(f: Field): FieldEl {
    const el = h("div", "db2-date");
    el.dataset.task = f.id;
    const input = h("input");
    input.type = "date";
    input.setAttribute("aria-label", "scheduled date");
    input.value = addDays(isoOf(new Date()), MONTH_DAYS);
    const set = h("button", "db2-date-set", "set");
    set.type = "button";
    const commit = (): void => {
      const date = asDate(input.value);
      if (!date) {
        say("pick a date first");
        return;
      }
      ui.dating = null;
      render();
      schedule(f.id, date, "scheduled");
    };
    set.addEventListener("click", commit);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ui.dating = null;
        render();
      }
    });
    el.append(input, set);
    return { el, input };
  }

  function renderHud(): void {
    if (!scene) return;
    const { hud: n, today } = scene;
    hudMain.textContent = `${plural(n.roots, "task")} · ${DAYS[weekday(today)]} ${today}`;
    hudRings.textContent = RINGS.map(r => `${r} ${n.perRing[r]}`).join(" · ");
    const changes = session.edits().length;
    hudExtra.textContent = `${n.hidden} hidden · ${plural(changes, "change")} this session`;
    const phase = sync.phase();
    const left = sync.secondsLeft();
    hudDraft.textContent =
      phase === "holding" ? "reorganising · applies once you close the bubble"
      : phase === "settling" ? (left > 0 ? `reorganised · applies in ${left}s` : "reorganised · applying…")
      : "";
    hudDraft.dataset.phase = phase;
  }

  function renderToolbar(): void {
    if (!scene) return;
    laterBtn.textContent = `${ui.showLater ? "hide" : "show"} later (${scene.hud.later})`;
    laterBtn.setAttribute("aria-pressed", String(ui.showLater));
    addBtn.setAttribute("aria-expanded", String(!panel.hidden));
    const groups = collapsible(sync.tasks(), sync.reorg());
    collapseBtn.hidden = groups === 0;
    collapseBtn.textContent = `collapse (${groups})`;
    collapseBtn.title = `close everything and bring back ${plural(groups, "group")}`;
    const drafting = sync.phase() !== "none";
    applyBtn.hidden = discardBtn.hidden = !drafting;
    const edits = session.edits().length;
    resetBtn.hidden = edits === 0;
    resetBtn.textContent = resetArmed !== null ? `really undo ${plural(edits, "change")}?` : "↺ reset all";
  }

  // ─── camera ────────────────────────────────────────────────────────────────
  function applyCamera(): void {
    world.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`;
    world.dataset.k = String(camera.k);
    world.dataset.tx = String(camera.tx);
    world.dataset.ty = String(camera.ty);
  }

  function fit(): void {
    const w = board.clientWidth, hgt = board.clientHeight;
    const R = fitRadius() + 60;
    camera.k = Math.max(0.05, Math.min(w, hgt) / (2 * R));
    camera.tx = w / 2;
    camera.ty = hgt / 2;
    camera.auto = true;
    applyCamera();
  }

  /**
   * How much of the board "fit" shows: all of it with the later rings on; otherwise
   * the near rings, and any bubble that is drawn beyond them.
   */
  function fitRadius(): number {
    if (!scene) return 600;
    if (ui.showLater) return scene.radius;
    let R = scene.bands[NEAR_RINGS.length - 1].outer;
    for (const b of scene.bubbles) {
      const band = b.ring ? scene.bands.find(x => x.ring === b.ring) : undefined;
      if (band) R = Math.max(R, band.outer);
    }
    return R;
  }

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = board.getBoundingClientRect();
    return {
      x: (clientX - rect.left - camera.tx) / camera.k,
      y: (clientY - rect.top - camera.ty) / camera.k,
    };
  }

  // ─── actions ───────────────────────────────────────────────────────────────
  function activate(hit: Hit | null): void {
    if (!scene) return;
    if (!hit) {
      if (!panel.hidden) togglePanel(false);
      if (ui.chain.length) setChain([]);
      return;
    }
    if (hit.kind === "field") {
      fieldEls.get(hit.key)?.input.focus({ preventScroll: true });
      return;
    }
    const b = scene.byId.get(hit.id);
    if (!b) return;
    if (!b.open) {
      if (b.root) setChain([b.id]);
      else {
        const at = ui.chain.indexOf(b.parent ?? "");
        if (at >= 0) setChain([...ui.chain.slice(0, at + 1), b.id]);
      }
      return;
    }
    const at = ui.chain.indexOf(b.id);
    if (at < 0) return;
    if (at < ui.chain.length - 1) {
      setChain(ui.chain.slice(0, at + 1)); // an open ancestor: close what is open inside it
      return;
    }
    if (!b.root && !hit.inCore && drawnChildren(tree, b.id).length > 0) {
      // The empty space of an open subtask that has subtasks: dissolve that level.
      if (applyOutcome(pop(sync.tasks(), sync.reorg(), b.id))) setChain(ui.chain.slice(0, at));
      return;
    }
    setChain(ui.chain.slice(0, at));
  }

  function onControl(kind: ControlKind, id: string): void {
    const node = tree.nodes.get(id);
    if (!node) return;
    switch (kind) {
      case "add":
        startAdding(id);
        break;
      case "quick":
        void act(async () => {
          if (node.attrs.quick === true) await sync.run("unset_attributes", { task_id: id, keys: ["quick"] });
          else await sync.run("set_attributes", { task_id: id, attrs: { quick: true } });
        });
        break;
      case "complete": {
        const at = ui.chain.indexOf(id);
        if (at >= 0) setChain(ui.chain.slice(0, at));
        void act(async () => { await sync.run("complete_task", { task_id: id }); });
        break;
      }
      case "discard":
        discardTask(id);
        break;
      case "undo": {
        const seqs = session.under(scopeOf(sync.tasks(), tree, id)).map(e => e.seq);
        if (!seqs.length) return;
        void act(async () => {
          const res = await sync.undo(seqs, true);
          return () => say(res.error
            ? `undid ${plural(res.undone, "change")} · stopped: ${res.error}`
            : `undid ${plural(res.undone, "change")}`);
        });
        break;
      }
    }
  }

  function discardTask(id: string): void {
    const node = tree.nodes.get(id);
    if (!node) return;
    const tasks = sync.tasks();
    const order = discardOrder(tasks, id);
    const scope = scopeOf(tasks, tree, id);
    const touched = touchedIds(sync.reorg());
    if ([...scope].some(t => touched.has(t))) {
      say("can't discard: the reorganisation in progress touches it · apply or discard that first");
      return;
    }
    const title = node.title;
    const subtasks = order.length - 1;
    const seqs: number[] = [];
    void act(async () => {
      for (const taskId of order) seqs.push((await sync.run("discard_task", { task_id: taskId })).seq);
      return () => say(
        `discarded "${title}"${subtasks > 0 ? ` and its ${plural(subtasks, "subtask")}` : ""}`,
        {
          label: "undo",
          run: () => void act(async () => {
            const res = await sync.undo([...seqs].reverse(), true);
            return () => say(res.error ? `undo stopped: ${res.error}` : `restored "${title}"`);
          }),
        },
      );
    });
  }

  function startAdding(parent: string): void {
    if (ui.adding !== parent) {
      ui.adding = parent;
      render();
    }
    fieldEls.get(`new:${parent}`)?.input.focus({ preventScroll: true });
  }

  /**
   * Finish the "new subtask" field. `commit` creates what was typed; `keep` leaves an
   * empty field in place for the next one (Enter). An empty field just closes.
   */
  function endAdding(commit: boolean, keep: boolean): void {
    const parent = ui.adding;
    if (!parent) return;
    const field = fieldEls.get(`new:${parent}`);
    const title = oneLine(field?.input.value ?? "");
    if (commit && title) {
      if (keep && field) field.input.value = "";
      else ui.adding = null;
      void act(async () => { await sync.run("create_task", { title, parent_id: parent }); });
    } else {
      ui.adding = null;
    }
    render();
  }

  function schedule(id: string, date: string, kind: "due" | "scheduled"): void {
    const node = tree.nodes.get(id);
    if (!node) return;
    const sameKind = (node.attrs.date_kind === "scheduled" ? "scheduled" : "due") === kind;
    if (asDate(node.attrs.date) === date && sameKind) return; // already has that date
    void act(async () => {
      await sync.run("set_attributes", { task_id: id, attrs: { date, date_kind: kind } });
      return () => {
        const today = isoOf(new Date());
        const expected = kind === "due" ? ringFor(date, today) : "later";
        const now = placement(tree, id, today);
        const by = now.due && now.due.by !== id ? tree.nodes.get(now.due.by) : undefined;
        if (by && now.due && now.ring !== expected) {
          say(`date set · still placed by its subtask "${by.title}", due ${mmdd(now.due.date)}`);
        }
      };
    });
  }

  function dropRoot(id: string, x: number, y: number): void {
    if (!scene) return;
    const at = ringAt(scene.bands, Math.hypot(x, y));
    const drop = dropFor(at ? at.ring : null, at ? at.across : 0, scene.today);
    if (drop.kind === "refuse") say("can't schedule in the past");
    else if (drop.kind === "pick") {
      ui.dating = id;
      setChain([id]);
    } else if (drop.kind === "set") schedule(id, drop.date, "due");
  }

  function dropSub(id: string, drop: SubDrop): void {
    const tasks = sync.tasks(), reorg = sync.reorg();
    if (drop.kind === "refuse") say(drop.label);
    else if (drop.kind === "merge") applyOutcome(merge(tasks, reorg, id, drop.target));
    else if (drop.kind === "into") applyOutcome(moveInto(tasks, reorg, id, drop.parent));
    else if (drop.kind === "root") applyOutcome(makeRoot(tasks, reorg, id));
  }

  function back(): void {
    if (ui.adding) endAdding(false, false);
    else if (ui.dating) {
      ui.dating = null;
      render();
    } else if (!panel.hidden) togglePanel(false);
    else if (ui.chain.length) setChain(ui.chain.slice(0, -1));
  }

  function toggleLater(): void {
    // Showing or hiding the far rings must not move a bubble, on the board or on the
    // screen: the camera stays where it is ("fit" reframes it).
    camera.auto = false;
    ui.showLater = !ui.showLater;
    writeFlag(store, KEYS.showLater, ui.showLater);
    render();
  }

  function toggleSize(): void {
    ui.oneSize = !ui.oneSize;
    writeFlag(store, KEYS.oneSize, ui.oneSize);
    render();
  }

  function togglePanel(show: boolean): void {
    panel.hidden = !show;
    if (show) {
      refreshPanel();
      titleInput.focus();
    }
    renderToolbar();
  }

  function refreshPanel(): void {
    for (const [c, b] of catBtns) b.setAttribute("aria-pressed", String(c === category));
    sectionList.replaceChildren(...sectionsIn(sync.tasks(), category).map(s => {
      const o = h("option");
      o.value = s;
      return o;
    }));
  }

  // ─── input: toolbar and panel ──────────────────────────────────────────────
  laterBtn.addEventListener("click", toggleLater);
  addBtn.addEventListener("click", () => togglePanel(panel.hidden !== false));
  fitBtn.addEventListener("click", fit);
  applyBtn.addEventListener("click", () => sync.applyNow());
  discardBtn.addEventListener("click", () => sync.discard());
  collapseBtn.addEventListener("click", () => {
    const res = collapse(sync.tasks(), sync.reorg());
    if (!res.restored.length) return;
    sync.change(res.reorg, { op: "collapse", restored: res.restored });
    setChain([]);
  });
  resetBtn.addEventListener("click", () => {
    if (resetArmed === null) {
      resetArmed = window.setTimeout(() => {
        resetArmed = null;
        renderToolbar();
      }, 4000);
      renderToolbar();
      return;
    }
    window.clearTimeout(resetArmed);
    resetArmed = null;
    const seqs = [...session.edits()].map(e => e.seq).sort((a, b) => b - a);
    void act(async () => {
      const res = await sync.undo(seqs, false);
      return () => say(res.error
        ? `undid ${plural(res.undone, "change")} · ${seqs.length - res.undone} couldn't be undone: ${res.error}`
        : `undid ${plural(res.undone, "change")}`);
    });
    renderToolbar();
  });
  for (const [c, b] of catBtns) {
    b.addEventListener("click", () => {
      category = c;
      refreshPanel();
      titleInput.focus();
    });
  }
  const panelKeys = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(false);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const title = oneLine(titleInput.value);
    if (!title) return;
    const attrs: Record<string, unknown> = { category };
    const section = oneLine(sectionInput.value);
    if (section) attrs.section = section;
    titleInput.value = "";
    void act(async () => { await sync.run("create_task", { title, attrs }); });
  };
  titleInput.addEventListener("keydown", panelKeys);
  sectionInput.addEventListener("keydown", e => {
    if (e.key === "Escape") panelKeys(e);
    else if (e.key === "Enter") {
      e.preventDefault();
      titleInput.focus();
    }
  });

  // Clicking anything else keeps what was typed into the "new subtask" field and
  // creates it. Presses on the board do this themselves, once they know what was hit.
  root.addEventListener("click", e => {
    const target = e.target as Element;
    if (!ui.adding || target === board || target.closest(".db2-new") || target.closest(".db2-bubble")) return;
    if (target.closest(".db2-world") && !target.closest("button, input")) return;
    endAdding(true, false);
  }, true);

  // ─── input: the board ──────────────────────────────────────────────────────
  board.addEventListener("pointerdown", e => {
    if (e.button !== 0 || press || !scene) return;
    if ((e.target as Element).closest("button, input, .db2-new, .db2-date")) return;
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    const hit = hitTest(scene, p.x, p.y);
    const b = hit?.kind === "bubble" ? scene.byId.get(hit.id) : undefined;
    press = {
      pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, lastX: e.clientX, lastY: e.clientY,
      hit, mode: "press", id: b ? b.id : null,
      ox: b ? p.x - b.x : 0, oy: b ? p.y - b.y : 0,
    };
    board.setPointerCapture(e.pointerId);
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active) && !active.closest(".db2-new")) active.blur();
  });

  board.addEventListener("pointermove", e => {
    if (!press || e.pointerId !== press.pointerId || !scene) return;
    if (press.mode === "press") {
      if (Math.hypot(e.clientX - press.sx, e.clientY - press.sy) < DRAG_THRESHOLD) return;
      const b = press.id ? scene.byId.get(press.id) : undefined;
      if (b && !b.open && b.root && canReschedule(b)) press.mode = "root";
      else if (b && !b.open && !b.root) press.mode = "sub";
      else press.mode = "pan";
      if (press.mode !== "pan") {
        bubbleEls.get(press.id!)?.el.classList.add("db2-dragging");
        syncHold(); // a drag is under way
      } else {
        board.classList.add("db2-panning");
      }
    }
    if (press.mode === "pan") {
      camera.tx += e.clientX - press.lastX;
      camera.ty += e.clientY - press.lastY;
      camera.auto = false;
      applyCamera();
    } else {
      const p = toWorld(e.clientX, e.clientY);
      const b = scene.byId.get(press.id!);
      const el = bubbleEls.get(press.id!)?.el;
      if (!b || !el) {
        endPress(e, true);
        return;
      }
      el.style.transform = `translate(${p.x - press.ox - b.r}px, ${p.y - press.oy - b.r}px)`;
      let text: string;
      let lit: Ring | null = null;
      let target: string | null = null;
      if (press.mode === "root") {
        const at = ringAt(scene.bands, Math.hypot(p.x, p.y));
        lit = at ? at.ring : null;
        text = dropLabel(dropFor(lit, at ? at.across : 0, scene.today));
      } else {
        const drop = subDrop(scene, b.id, p.x, p.y);
        text = drop.label;
        target = drop.kind === "merge" ? drop.target : drop.kind === "into" ? drop.parent : null;
      }
      feedback(text, lit, target, e.clientX, e.clientY);
    }
    press.lastX = e.clientX;
    press.lastY = e.clientY;
  });

  function feedback(text: string | null, lit: Ring | null, target: string | null, cx = 0, cy = 0): void {
    dragLabel.hidden = text === null;
    if (text !== null) {
      dragLabel.textContent = text;
      const rect = root.getBoundingClientRect();
      dragLabel.style.transform = `translate(${cx - rect.left + 16}px, ${cy - rect.top + 16}px)`;
    }
    for (const [ring, { shape }] of bandEls) shape.classList.toggle("db2-lit", ring === lit);
    for (const [id, e] of bubbleEls) e.el.classList.toggle("db2-target", id === target);
  }

  function endPress(e: PointerEvent, cancelled: boolean): void {
    if (!press || e.pointerId !== press.pointerId) return;
    const done = press;
    press = null;
    if (board.hasPointerCapture(e.pointerId)) board.releasePointerCapture(e.pointerId);
    board.classList.remove("db2-panning");
    feedback(null, null, null);
    if (done.id) bubbleEls.get(done.id)?.el.classList.remove("db2-dragging");
    if (!scene) return;
    const p = toWorld(e.clientX, e.clientY);
    // Decide against the board as it was drawn when the pointer came up, then let
    // the "new subtask" field go (which may move things), then act.
    const sub = !cancelled && done.mode === "sub" && done.id ? subDrop(scene, done.id, p.x, p.y) : null;
    if (!cancelled) endAdding(true, false);
    if (cancelled || done.mode === "pan") {
      // nothing to do
    } else if (done.mode === "press") activate(done.hit);
    else if (done.mode === "root" && done.id) dropRoot(done.id, p.x, p.y);
    else if (sub && done.id) dropSub(done.id, sub);
    syncHold();
    render();
  }
  board.addEventListener("pointerup", e => endPress(e, false));
  board.addEventListener("pointercancel", e => endPress(e, true));

  board.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = board.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const k = Math.min(4, Math.max(0.08, camera.k * Math.exp(-e.deltaY * 0.0015)));
    camera.tx = px - ((px - camera.tx) * k) / camera.k;
    camera.ty = py - ((py - camera.ty) * k) / camera.k;
    camera.k = k;
    camera.auto = false;
    applyCamera();
  }, { passive: false });

  // ─── input: keyboard ───────────────────────────────────────────────────────
  const onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as Element | null;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const bubble = target instanceof HTMLElement ? target.closest<HTMLElement>(".db2-bubble") : null;
    if (bubble && scene && (e.key === "Enter" || e.key === " ")) {
      const b = scene.byId.get(bubble.dataset.id ?? "");
      if (b) {
        e.preventDefault();
        activate({ kind: "bubble", id: b.id, open: b.open, inCore: true });
      }
      return;
    }
    if (target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
    switch (e.key) {
      case "Escape": back(); break;
      case "s": case "S": toggleSize(); break;
      case "l": case "L": toggleLater(); break;
      case "0": fit(); break;
      case "+": case "=": {
        const inner = ui.chain[ui.chain.length - 1];
        const node = inner ? tree.nodes.get(inner) : undefined;
        if (node && !node.isNew) {
          e.preventDefault();
          startAdding(inner);
        }
        break;
      }
      default: return;
    }
  };
  document.addEventListener("keydown", onKey);

  const onResize = (): void => { if (camera.auto) fit(); };
  window.addEventListener("resize", onResize);
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void sync.refresh().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", onVisible);
  // "Today" moves on at midnight: the rings are a function of the date.
  const dayTimer = window.setInterval(() => {
    if (scene && scene.today !== isoOf(new Date())) render();
  }, 30_000);

  // ─── go ────────────────────────────────────────────────────────────────────
  fit();
  sync.start().catch(e => say(`couldn't load the tasks: ${errorText(e)}`));

  return () => {
    disposed = true;
    sync.stop();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("resize", onResize);
    window.clearInterval(dayTimer);
    if (msgTimer !== null) window.clearTimeout(msgTimer);
    if (resetArmed !== null) window.clearTimeout(resetArmed);
    root.remove();
  };
}
