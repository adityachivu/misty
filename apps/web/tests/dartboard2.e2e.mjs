// End-to-end test of the dartboard2 view: a real server on a throwaway database, a
// real browser, real pointer and keyboard input, and assertions on what landed in the
// database (GET /api/tasks, GET /api/edits, GET /api/drafts).
//
//   npm run test:e2e:dartboard2
//
// It builds the app into a temp folder (E2E_DIST=<dir> uses an existing build instead),
// starts `misty serve` on a free port with a temp database, and removes both afterwards.
//
// It never sleeps for a fixed time: it acts, then waits for a stated condition.
// Pointer targets come from the geometry the view publishes (data-x/-y/-r in world
// units, and the camera on .db2-world), which is where things *will* be, so nothing
// here depends on a transition having finished.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { build } from "vite";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "../..");
const NOW = "2026-07-15T09:00:00"; // a Wednesday
const TODAY = "2026-07-15";
const FORBIDDEN = new Set([4322, 4393, 4394, 4395, 4396, 4397, 4398]);
const CLIENT = "web:dartboard2";

// ─── harness ─────────────────────────────────────────────────────────────────

let steps = 0;
function ok(cond, what) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  steps++;
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAILED: ${what}\n  expected ${e}\n  actual   ${a}`);
  steps++;
}

/** Wait for a condition, checking often. Throws, saying what it waited for. */
async function until(check, what, timeout = 10_000) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`TIMED OUT after ${timeout}ms waiting for: ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    }
    await new Promise(r => setTimeout(r, 40));
  }
}

async function freePort() {
  for (;;) {
    const port = await new Promise((done, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => done(port));
      });
    });
    if (!FORBIDDEN.has(port)) return port;
  }
}

const tmp = await mkdtemp(join(tmpdir(), "misty-dartboard2-"));
const dist = process.env.E2E_DIST ?? join(tmp, "dist");
if (!process.env.E2E_DIST) {
  await build({ root: WEB, logLevel: "error", build: { outDir: dist, emptyOutDir: true } });
}
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const serverLog = [];
const server = spawn(
  "uv", ["run", "misty", "serve", "--db", join(tmp, "e2e.db"), "--port", String(port), "--web", dist],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
);
server.stdout.on("data", d => serverLog.push(String(d)));
server.stderr.on("data", d => serverLog.push(String(d)));

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}
const cmd = async (tool, args) => (await api("POST", "/api/commands", { tool, args, actor_id: "seed" })).edit;
const create = async (title, attrs = {}, parent_id = null) =>
  (await cmd("create_task", { title, attrs, parent_id })).task_id;

/** The database, by title (titles are unique in this test). */
async function db() {
  const { head_seq, tasks } = await api("GET", "/api/tasks");
  const byId = new Map(tasks.map(t => [t.id, t]));
  const byTitle = new Map(tasks.map(t => [t.title, t]));
  return {
    head: head_seq,
    tasks,
    get: title => byTitle.get(title),
    parentOf: title => {
      const t = byTitle.get(title);
      return t?.parent_id ? byId.get(t.parent_id).title : null;
    },
    childrenOf: title => tasks.filter(t => t.parent_id === byTitle.get(title).id && t.state !== "discarded").map(t => t.title).sort(),
  };
}
const edits = after => api("GET", `/api/edits?after_seq=${after}`);
const drafts = status => api("GET", `/api/drafts?status=${status}`);

let browser, page;
const problems = [];

async function main() {
  await until(async () => (await fetch(`${BASE}/api/tasks`)).ok, "the server to answer", 60_000);

  // ── seed ────────────────────────────────────────────────────────────────────
  const id = {};
  id.thesis = await create("Thesis", { category: "uni", section: "writing", date: TODAY });
  id.outline = await create("Outline", {}, id.thesis);
  id.intro = await create("Draft intro", {}, id.thesis);
  id.figures = await create("Figures", {}, id.thesis);
  id.fig1 = await create("Fig 1", {}, id.figures);
  id.fig1a = await create("Fig 1a", {}, id.fig1);
  id.fig1b = await create("Fig 1b", {}, id.fig1);
  id.fig2 = await create("Fig 2", {}, id.figures);
  id.figOld = await create("Fig old", {}, id.figures);
  await cmd("release_task", { task_id: id.figOld });
  id.notes = await create("Old notes", {}, id.thesis);
  await cmd("complete_task", { task_id: id.notes });
  id.biblio = await create("Bibliography", {}, id.thesis);
  id.proof = await create("Proofread", {}, id.thesis);
  id.taxes = await create("Taxes", { category: "admin", date: "2026-07-16" });
  id.receipts = await create("Gather receipts", {}, id.taxes);
  id.deploy = await create("Deploy", { category: "work" });
  id.smoke = await create("Smoke test", { date: "2026-07-14" }, id.deploy);
  id.garden = await create("Garden", { category: "projects", date: "2026-07-17" });
  id.paper = await create("Read paper", { category: "uni", section: "reading", date: "2026-08-10" });
  id.someday = await create("Someday", { category: "projects" });
  id.loose = await create("Loose", { date: TODAY });
  id.groceries = await create("Groceries", { category: "admin", date: TODAY });
  id.milk = await create("Milk", {}, id.groceries);
  id.eggs = await create("Eggs", {}, id.groceries);
  id.bread = await create("Bread", {}, id.groceries);
  await cmd("release_task", { task_id: id.bread });
  await create("A task with a very long title that cannot possibly fit inside one small circle", { category: "work", date: "2026-07-16" });
  const seeded = await db();

  // ── browser ─────────────────────────────────────────────────────────────────
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    // E2E_REDUCED_MOTION=1 runs the same test with transitions off: it must not matter.
    reducedMotion: process.env.E2E_REDUCED_MOTION ? "reduce" : "no-preference",
  });
  page = await context.newPage();
  page.on("pageerror", e => problems.push(`page error: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") problems.push(`console error: ${m.text()}`); });
  await page.clock.setFixedTime(new Date(NOW));

  const open = async () => {
    await page.goto(`${BASE}/?view=dartboard2`);
    await page.waitForSelector(".db2[data-ready]");
  };

  /** Everything the view publishes about where things are, in client pixels. */
  const geo = () => page.evaluate(() => {
    const w = document.querySelector(".db2-world");
    const k = +w.dataset.k, tx = +w.dataset.tx, ty = +w.dataset.ty;
    const rect = document.querySelector(".db2-board").getBoundingClientRect();
    const P = (x, y) => ({ x: rect.left + tx + k * x, y: rect.top + ty + k * y });
    return {
      k, tx, ty,
      centre: P(0, 0),
      bubbles: [...document.querySelectorAll(".db2-bubble")].map(e => ({
        id: e.dataset.id, title: e.title, ...P(+e.dataset.x, +e.dataset.y), r: k * +e.dataset.r,
        wx: +e.dataset.x, wy: +e.dataset.y, wr: +e.dataset.r,
        open: e.dataset.open === "1", level: +e.dataset.level, ring: e.dataset.ring ?? null,
        cls: e.className.split(" "),
      })),
      bands: Object.fromEntries([...document.querySelectorAll(".db2-band")].map(e =>
        [e.dataset.ring, { inner: +e.dataset.inner, outer: +e.dataset.outer, lit: e.classList.contains("db2-lit") }])),
      controls: [...document.querySelectorAll(".db2-ctl")].map(e => ({
        kind: e.dataset.kind, id: e.dataset.id, pressed: e.getAttribute("aria-pressed"),
        ...P(parseFloat(e.style.left), parseFloat(e.style.top)),
      })),
    };
  });
  const bubble = async title => {
    const b = (await geo()).bubbles.find(x => x.title === title);
    if (!b) throw new Error(`no bubble titled "${title}"`);
    return b;
  };
  const has = async title => (await geo()).bubbles.some(x => x.title === title);
  const click = async title => {
    const b = await bubble(title);
    await page.mouse.click(b.x, b.y);
  };
  const control = async (title, kind) => {
    const g = await geo();
    const b = g.bubbles.find(x => x.title === title);
    const c = g.controls.find(x => x.id === b?.id && x.kind === kind);
    if (!c) throw new Error(`no ${kind} control on "${title}"`);
    return c;
  };
  const press = async (title, kind) => {
    const c = await control(title, kind);
    await page.mouse.click(c.x, c.y);
  };
  /** A point inside an open bubble that is on nothing else: not its name, a subtask or a control. */
  const emptySpace = async title => {
    const g = await geo();
    const b = g.bubbles.find(x => x.title === title);
    const rr = b.r - 7 * g.k;
    for (const deg of [0, 180, 25, 155, -25, 205, 50, 130, -50, 230, 70, 110]) {
      const p = { x: b.x + rr * Math.cos((deg * Math.PI) / 180), y: b.y + rr * Math.sin((deg * Math.PI) / 180) };
      const onBubble = g.bubbles.some(o => o.id !== b.id && o.level > b.level && Math.hypot(p.x - o.x, p.y - o.y) <= o.r + 2);
      const onControl = g.controls.some(c => Math.hypot(p.x - c.x, p.y - c.y) <= 16);
      if (!onBubble && !onControl) return p;
    }
    throw new Error(`no empty space in "${title}"`);
  };
  /** A point of the board with no bubble on it, clear of the HUD and the toolbar. */
  const emptyBoard = async () => {
    const g = await geo();
    for (let y = 930; y > 200; y -= 40) {
      for (let x = 60; x < 1340; x += 40) {
        if (!g.bubbles.some(o => Math.hypot(x - o.x, y - o.y) <= o.r + 6)) return { x, y };
      }
    }
    throw new Error("no empty board");
  };
  /** A point on a ring, `across` of the way from its inner to its outer edge, at an angle. */
  const onRing = async (ring, across = 0.5, deg = 0) => {
    const g = await geo();
    const b = g.bands[ring];
    const rad = (b.inner + across * (b.outer - b.inner)) * g.k;
    return { x: g.centre.x + rad * Math.cos((deg * Math.PI) / 180), y: g.centre.y + rad * Math.sin((deg * Math.PI) / 180) };
  };
  const drag = async (from, to, during) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 4, from.y + 7);
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await page.mouse.move(to.x, to.y);
    if (during) await during();
    await page.mouse.up();
  };
  const dragBubble = async (title, to, during) => {
    const b = await bubble(title);
    await drag({ x: b.x, y: b.y }, to, during);
  };
  const text = sel => page.evaluate(s => document.querySelector(s)?.textContent ?? null, sel);
  const visible = sel => page.evaluate(s => {
    const el = document.querySelector(s);
    return !!el && !el.hidden && !el.closest("[hidden]");
  }, sel);
  const message = () => page.evaluate(() => {
    const m = document.querySelector(".db2-msg");
    return m.hidden ? null : m.querySelector(".db2-msg-text").textContent;
  });
  const hudDraft = () => text(".db2-hud-draft");
  const session = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("misty.dartboard2.session")));
  /** The page has drawn the database as it is now. */
  const caughtUp = async () => {
    const head = (await db()).head;
    await until(async () => (await page.evaluate(() => +document.querySelector(".db2").dataset.head)) >= head,
      `the board to show seq ${head}`);
  };
  /** Remember an element, to prove later that it is still the same one. */
  const mark = (title, tag) => page.evaluate(([t, g]) => {
    const el = [...document.querySelectorAll(".db2-bubble")].find(e => e.title === t);
    el.__mark = g;
  }, [title, tag]);
  const marked = title => page.evaluate(t => {
    const el = [...document.querySelectorAll(".db2-bubble")].find(e => e.title === t);
    return el ? el.__mark ?? null : null;
  }, title);
  const positions = async () => Object.fromEntries(
    (await geo()).bubbles.map(b => [b.title, [b.wx, b.wy, b.wr]]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  // ── A. load, layout, determinism ────────────────────────────────────────────
  await open();
  ok((await text(".db2-hud-main")).startsWith("9 tasks · Wed 2026-07-15"), `HUD says 9 tasks and today's date: ${await text(".db2-hud-main")}`);
  eq(await text(".db2-hud-rings"), "overdue 1 · today 3 · tomorrow 2 · weekend 1 · month 1 · later 1", "counts per ring");
  ok((await text(".db2-hud-extra")).startsWith("2 hidden · 0 changes"), "2 hidden, no changes yet");
  eq(await text('.db2-tool[data-tool="later"]'), "show later (2)", "the later button says how many");
  ok(!(await visible('.db2-tool[data-tool="reset"]')), "no reset button with nothing to undo");
  ok(!(await visible('.db2-tool[data-tool="apply"]')) && !(await visible('.db2-tool[data-tool="collapse"]')), "no draft buttons without a draft");

  let g = await geo();
  eq(g.bubbles.map(b => b.title).sort(), ["A task with a very long title that cannot possibly fit inside one small circle", "Deploy", "Garden", "Groceries", "Loose", "Taxes", "Thesis"], "the short view draws the near rings' roots");
  const ringOf = t => g.bubbles.find(b => b.title === t).ring;
  eq([ringOf("Thesis"), ringOf("Taxes"), ringOf("Deploy"), ringOf("Garden"), ringOf("Loose")],
    ["today", "tomorrow", "overdue", "weekend", "today"], "each root is in the ring of its earliest open deadline");
  for (const b of g.bubbles) {
    const band = g.bands[b.ring], dist = Math.hypot(b.wx, b.wy);
    // The overdue disc stays small: its bubbles start inside it and may reach past its edge.
    const spills = b.ring === "overdue";
    ok(dist - b.wr >= band.inner && (spills ? dist <= band.outer : dist + b.wr <= band.outer), `${b.title} lies inside the ${b.ring} ring`);
  }
  ok(g.bands.overdue.outer <= 100, `the overdue disc is small: ${g.bands.overdue.outer}`);
  const at = t => g.bubbles.find(b => b.title === t);
  ok(at("Thesis").wx < 0 && at("Thesis").wy < 0, "uni is upper left");
  ok(at("Deploy").wx > 0 && at("Deploy").wy < 0, "work is upper right");
  ok(at("Garden").wx > 0 && at("Garden").wy > 0, "projects is lower right");
  ok(at("Taxes").wx < 0 && at("Taxes").wy > 0, "admin is lower left");
  const widths = Object.fromEntries(Object.entries(g.bands).map(([r, b]) => [r, b.outer - b.inner]));
  ok(Object.entries(widths).every(([r, w]) => r === "today" || widths.today > w), "today's ring is the roomiest");
  // Size: base × min(1.7, sqrt(1 + 0.25 n)). Thesis has 9 open subtasks at any depth, which hits the cap;
  // Groceries has 2 (its released one doesn't count); Deploy has 1.
  ok(Math.abs(at("Thesis").wr - 48 * 1.7) < 0.01, `Thesis is sized by its open subtasks, capped: ${at("Thesis").wr}`);
  ok(Math.abs(at("Groceries").wr - 48 * Math.sqrt(1.5)) < 0.01, `Groceries is sized by its 2 open subtasks: ${at("Groceries").wr}`);
  ok(Math.abs(at("Deploy").wr - 48 * Math.sqrt(1.25)) < 0.01, `Deploy is sized by its 1 open subtask: ${at("Deploy").wr}`);
  ok(Math.abs(at("Garden").wr - 48) < 0.01, "a bubble without subtasks is the base size");
  ok(at("Thesis").cls.includes("db2-solid") && !at("Garden").cls.includes("db2-solid"), "solid border with subtasks, dashed without");
  ok(at("Deploy").cls.includes("db2-overdue"), "an overdue root is marked");

  // Titles fit their circle: every line of text lies inside the rim.
  const overflow = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll(".db2-bubble")) {
      const c = el.getBoundingClientRect();
      const cx = c.left + c.width / 2, cy = c.top + c.height / 2, r = c.width / 2;
      for (const line of el.querySelectorAll(".db2-t, .db2-m")) {
        if (!line.textContent) continue;
        const range = document.createRange();
        range.selectNodeContents(line);
        const b = range.getBoundingClientRect();
        for (const [x, y] of [[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom]]) {
          if (Math.hypot(x - cx, y - cy) > r + 0.5) bad.push(`${el.title}: "${line.textContent}"`);
        }
      }
    }
    return bad;
  });
  eq(overflow, [], "no title text crosses a rim");
  const long = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".db2-bubble")].find(e => e.title.startsWith("A task with"));
    return [...el.querySelectorAll(".db2-t")].map(l => l.textContent).join(" ");
  });
  ok(long.endsWith("…") && "A task with a very long title that cannot possibly fit inside one small circle".startsWith(long.slice(0, -1).trimEnd()),
    `a long title ends in an ellipsis after whole words: "${long}"`);

  // The same data gives the same board on every load.
  const first = await positions();
  const camera = [g.k, g.tx, g.ty];
  await open();
  eq(await positions(), first, "a reload puts every bubble in the same place");

  // Showing the later rings moves nothing else, on the board or on the screen.
  await mark("Thesis", "kept");
  await page.keyboard.press("l");
  g = await geo();
  eq(g.bubbles.length, 9, "L shows the month and later rings' roots");
  eq(await text('.db2-tool[data-tool="later"]'), "hide later (2)", "the button now hides them");
  const withLater = await positions();
  for (const t of Object.keys(first)) eq(withLater[t], first[t], `${t} didn't move when later was shown`);
  eq([g.k, g.tx, g.ty], camera, "the camera didn't move either");
  eq([ringOf("Read paper"), ringOf("Someday")], ["month", "later"], "the far roots are in their rings");
  await open(); // the choice lasts for the tab
  eq((await geo()).bubbles.length, 9, "show later survives a reload");
  await page.click('.db2-tool[data-tool="later"]');
  eq(await positions(), first, "hiding them again restores the short view exactly");

  // S switches between sized-by-subtasks and one size, per tab.
  await page.keyboard.press("s");
  ok(Math.abs((await bubble("Thesis")).wr - 48) < 0.01, "S: one size");
  await page.keyboard.press("s");
  eq(await positions(), first, "S again: back to exactly the same board");

  // Camera: scroll zooms about the pointer, dragging empty board pans, 0 fits.
  const spot = await emptyBoard();
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.wheel(0, -300);
  g = await geo();
  ok(g.k > camera[0], "scrolling zooms in");
  await page.mouse.wheel(0, 300);
  const before = await geo();
  const free = await emptyBoard();
  await drag(free, { x: free.x + 60, y: free.y - 30 });
  g = await geo();
  ok(Math.abs(g.tx - before.tx - 60) < 1 && Math.abs(g.ty - before.ty + 30) < 1, "dragging empty board pans");
  await page.keyboard.press("0");
  g = await geo();
  eq([g.k, g.tx, g.ty], camera, "0 fits the board again");

  // ── B. opening and closing ──────────────────────────────────────────────────
  await mark("Thesis", "same");
  await click("Thesis");
  g = await geo();
  ok(at("Thesis").open, "one click opens a bubble");
  eq(await marked("Thesis"), "same", "the bubble is the same element, open");
  eq(g.bubbles.filter(b => b.level === 1).map(b => b.title).sort(), ["Bibliography", "Draft intro", "Figures", "Old notes", "Outline", "Proofread"], "its open and done subtasks are inside it");
  ok(at("Old notes").cls.includes("db2-done"), "a done subtask is faded");
  for (const b of g.bubbles.filter(x => x.level === 1)) {
    ok(Math.hypot(b.x - at("Thesis").x, b.y - at("Thesis").y) + b.r <= at("Thesis").r, `${b.title} is inside Thesis`);
  }
  eq(first.Thesis.slice(0, 2), [at("Thesis").wx, at("Thesis").wy], "opening doesn't move the bubble");
  eq(await page.evaluate(() => [...document.querySelectorAll(".db2-bubble.db2-open .db2-m")].map(e => e.textContent).join(" · ")),
    "writing · 📅 07-15", "the open bubble shows its meta line");
  eq(g.controls.filter(c => c.id === id.thesis).map(c => c.kind), ["add", "quick", "complete", "discard"], "controls: + ⚡ ✓ ✕ (no ↺ yet)");
  const add = g.controls.find(c => c.kind === "add"), rim = g.controls.filter(c => c.kind !== "add");
  ok(Math.abs(add.x - at("Thesis").x) < 0.5 && add.y < at("Thesis").y, "+ is at the top of the rim");
  ok(rim.every(c => c.y > at("Thesis").y && Math.abs(Math.hypot(c.x - at("Thesis").x, c.y - at("Thesis").y) - at("Thesis").r) < 0.5), "the others are on the bottom arc of the rim");
  ok(Math.abs(rim.reduce((a, c) => a + c.x - at("Thesis").x, 0)) < 0.5, "centred on the lowest point");

  await click("Figures");
  g = await geo();
  ok(at("Thesis").open && at("Figures").open, "a subtask opens inside its parent, which stays open");
  eq(g.bubbles.filter(b => b.level === 2).map(b => b.title).sort(), ["Fig 1", "Fig 2"], "released subtasks aren't drawn");
  await page.keyboard.press("Escape");
  g = await geo();
  ok(at("Thesis").open && !at("Figures").open, "Esc backs out one level");
  await page.keyboard.press("Escape");
  ok(!(await bubble("Thesis")).open, "Esc again closes the root");
  ok(!(await has("Outline")), "closed bubbles don't show their subtasks");

  await click("Thesis");
  await click("Figures");
  let p = await emptySpace("Thesis");
  await page.mouse.click(p.x, p.y);
  g = await geo();
  ok(at("Thesis").open && !at("Figures").open, "clicking an open ancestor closes what is open inside it");
  await click("Figures");
  p = await emptyBoard();
  await page.mouse.click(p.x, p.y);
  ok(!(await bubble("Thesis")).open, "clicking empty board closes everything");
  await click("Thesis");
  await click("Thesis");
  ok(!(await bubble("Thesis")).open, "clicking the innermost open bubble closes it");
  await page.evaluate(t => [...document.querySelectorAll(".db2-bubble")].find(e => e.title === t).focus(), "Thesis");
  await page.keyboard.press("Enter");
  ok((await bubble("Thesis")).open, "Enter on a focused bubble opens it");
  await page.keyboard.press("Enter");
  ok(!(await bubble("Thesis")).open, "and closes it again");
  eq((await db()).head, seeded.head, "nothing so far wrote anything");
  eq(await positions(), first, "and every bubble is back where it was");

  // ── C. adding subtasks ──────────────────────────────────────────────────────
  await click("Thesis");
  await press("Thesis", "add");
  g = await geo();
  ok(!g.controls.some(c => c.kind === "add" && c.id === id.thesis), "the + hides while a new bubble is being named");
  ok(await page.evaluate(() => document.activeElement === document.querySelector(".db2-new input")), "the new bubble's field has focus");
  await page.evaluate(() => { document.querySelector(".db2-new input").__mark = "field"; });
  await page.keyboard.type("Abstract");
  await page.keyboard.press("Enter");
  await until(async () => (await db()).get("Abstract"), "Abstract to be created");
  let d = await db();
  eq(d.parentOf("Abstract"), "Thesis", "Enter creates the subtask under the open bubble");
  const sid = (await session()).id;
  const created = (await edits(seeded.head))[0];
  eq([created.type, created.actor.id, created.correlation_id], ["task.created", CLIENT, sid], "sent as this view, with the session id");
  await caughtUp();
  eq(await page.evaluate(() => { const i = document.querySelector(".db2-new input"); return [i.value, i.__mark, document.activeElement === i]; }),
    ["", "field", true], "and offers another empty one: the same field, still focused");
  ok(await has("Abstract"), "the new subtask is drawn");
  ok((await bubble("Thesis")).cls.includes("db2-halo") && (await bubble("Abstract")).cls.includes("db2-halo"), "a halo marks the change and its ancestors");

  await page.keyboard.type("  Related   work ");
  await click("Outline"); // clicking anything else keeps what was typed and creates it
  await until(async () => (await db()).get("Related work"), "Related work to be created");
  eq((await db()).parentOf("Related work"), "Thesis", "the title is one line, with whitespace collapsed");
  g = await geo();
  ok(at("Outline").open, "and the click did what it would have done anyway");
  ok(!(await visible(".db2-new")), "the field is gone");
  await caughtUp();
  await page.keyboard.press("Escape");

  await page.keyboard.press("+");
  ok(await visible(".db2-new"), "+ on the keyboard adds to the innermost open bubble");
  await page.keyboard.type("junk");
  await page.keyboard.press("Escape");
  ok(!(await visible(".db2-new")), "Esc throws the new bubble away");
  ok((await bubble("Thesis")).open, "and the bubble stays open");
  await page.keyboard.press("=");
  await page.keyboard.press("Enter");
  ok(!(await visible(".db2-new")), "Enter on an empty field just closes it");
  ok((await geo()).controls.some(c => c.kind === "add" && c.id === id.thesis), "and the + is back");
  d = await db();
  ok(!d.get("junk") && d.head === seeded.head + 2, "neither wrote anything");

  // A data refresh keeps the element under the pointer, the focus and the typed text.
  await press("Thesis", "add");
  await page.keyboard.type("half typed");
  await page.evaluate(() => { document.querySelector(".db2-new input").__mark = "typing"; });
  await mark("Outline", "outline");
  const elsewhere = await create("Made elsewhere", {}, id.thesis);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await caughtUp();
  ok(await has("Made elsewhere"), "a refresh draws what changed elsewhere");
  eq(await page.evaluate(() => { const i = document.querySelector(".db2-new input"); return [i.value, i.__mark, document.activeElement === i]; }),
    ["half typed", "typing", true], "the field kept its text and its focus through the refresh");
  eq([await marked("Outline"), await marked("Thesis")], ["outline", "same"], "and the bubbles are the same elements");
  await page.keyboard.press("Escape");
  await cmd("discard_task", { task_id: elsewhere });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await caughtUp();
  ok(!(await has("Made elsewhere")), "a discarded task is no longer drawn");

  // ── D. the controls on the rim ──────────────────────────────────────────────
  await click("Outline");
  await press("Outline", "complete");
  await until(async () => (await db()).get("Outline").state === "done", "Outline to be done");
  await caughtUp();
  g = await geo();
  ok(at("Outline").cls.includes("db2-done") && !at("Outline").open && at("Thesis").open, "✓ completes the task; it is drawn done, inside its parent");
  eq((await control("Thesis", "undo")).kind, "undo", "↺ appears on a bubble with changes under it");
  await press("Thesis", "undo");
  await until(async () => (await db()).get("Outline").state === "open", "the changes under Thesis to be undone");
  await caughtUp();
  d = await db();
  eq([d.get("Abstract").state, d.get("Related work").state, d.get("Outline").state], ["discarded", "discarded", "open"], "↺ undid the session's edits under Thesis, newest first");
  eq((await edits(d.head - 3)).map(e => [e.type, e.reverts_seq != null]), [["edit.reverted", true], ["edit.reverted", true], ["edit.reverted", true]], "as three undo edits");
  g = await geo();
  ok(!g.controls.some(c => c.kind === "undo") && !at("Thesis").cls.includes("db2-halo"), "the ↺ and the halo are gone");
  eq((await session()).edits, [], "and the session has nothing left to undo");
  await page.keyboard.press("Escape");

  await click("Taxes");
  await press("Taxes", "quick");
  await until(async () => (await db()).get("Taxes").attrs.quick === true, "Taxes to be quick");
  await caughtUp();
  eq((await control("Taxes", "quick")).pressed, "true", "⚡ is shown pressed");
  ok((await bubble("Taxes")).cls.includes("db2-isquick"), "and the bubble shows ⚡");
  await press("Taxes", "quick");
  await until(async () => !("quick" in (await db()).get("Taxes").attrs), "Taxes to stop being quick");
  await caughtUp();
  eq((await edits((await db()).head - 2)).map(e => e.type), ["task.attrs_set", "task.attrs_unset"], "⚡ sets, then unsets, the attribute");
  await page.keyboard.press("Escape");

  // ✕ discards the task and everything under it, deepest first; undo restores it all.
  await click("Groceries");
  const beforeDiscard = (await db()).head;
  await press("Groceries", "discard");
  await until(async () => (await db()).get("Groceries").state === "discarded", "Groceries to be discarded");
  d = await db();
  eq(["Milk", "Eggs", "Bread", "Groceries"].map(t => d.get(t).state), Array(4).fill("discarded"), "its subtasks went too, the released one included");
  const discards = await edits(beforeDiscard);
  eq(discards.map(e => e.type), Array(4).fill("task.discarded"), "one discard each");
  eq(discards[3].task_id, id.groceries, "the task itself last");
  await until(async () => (await message()) === 'discarded "Groceries" and its 3 subtasks', "the discard message");
  ok(!(await has("Groceries")), "it is no longer drawn");
  await page.click(".db2-msg-action");
  await until(async () => (await db()).get("Milk").state === "open", "the discard to be undone (Milk was discarded first, so it is restored last)");
  d = await db();
  eq(["Milk", "Eggs", "Bread", "Groceries"].map(t => d.get(t).state), ["open", "open", "released", "open"], "undo put everything back as it was");
  await caughtUp();
  ok(await has("Groceries"), "and it is drawn again");

  // A root completed in this session stays on the board, faded, so undo can reach it.
  await click("Loose");
  await press("Loose", "complete");
  await until(async () => (await db()).get("Loose").state === "done", "Loose to be done");
  await caughtUp();
  g = await geo();
  ok(at("Loose").cls.includes("db2-done") && !at("Loose").open, "a root completed this session is still drawn, as done");
  ok(Math.abs(at("Loose").wr - 48 * 0.72) < 0.01, "done bubbles are smaller");
  ok((await text(".db2-hud-main")).startsWith("8 tasks"), "and no longer counts as a task");

  // Reset all: confirm, then undo every edit of the session.
  eq((await session()).edits.length, 3, "three edits left in the session (the ⚡ pair and the ✓)");
  eq(await text('.db2-tool[data-tool="reset"]'), "↺ reset all", "reset all is offered");
  await page.click('.db2-tool[data-tool="reset"]');
  eq(await text('.db2-tool[data-tool="reset"]'), "really undo 3 changes?", "the first click asks");
  await page.click('.db2-tool[data-tool="reset"]');
  await until(async () => (await session()).edits.length === 0, "the session to be reset");
  await caughtUp();
  ok(!(await visible('.db2-tool[data-tool="reset"]')), "nothing left to reset");
  d = await db();
  for (const t of seeded.tasks) {
    const now = d.tasks.find(x => x.id === t.id);
    eq([now.title, now.state, now.parent_id, now.attrs], [t.title, t.state, t.parent_id, t.attrs], `${t.title} is as it was seeded`);
  }
  eq(await positions(), first, "and the board is exactly as it was at the start");

  // ── E. rescheduling by dragging a root ──────────────────────────────────────
  let head = (await db()).head;
  await dragBubble("Garden", await onRing("tomorrow", 0.5, 200), async () => {
    eq(await text(".db2-draglabel"), "tomorrow · 📅 07-16", "the label by the pointer says what would happen");
    ok((await geo()).bands.tomorrow.lit, "the ring under the pointer lights up");
  });
  await until(async () => (await db()).get("Garden").attrs.date === "2026-07-16", "Garden to be due tomorrow");
  eq((await db()).get("Garden").attrs.date_kind, "due", "as a due date");
  await caughtUp();
  g = await geo();
  ok(at("Garden").ring === "tomorrow" && at("Garden").wx > 0 && at("Garden").wy > 0, "it sits in tomorrow's ring, in its own quadrant: the angle is ignored");
  ok(!(await visible(".db2-draglabel")) && !g.bands.tomorrow.lit, "the drag feedback is gone");
  head = (await db()).head;
  await dragBubble("Garden", await onRing("tomorrow", 0.3, 100));
  await dragBubble("Garden", await onRing("overdue", 0.2, 45), async () => {
    eq(await text(".db2-draglabel"), "overdue · can't schedule in the past", "the overdue disc refuses");
  });
  eq(await message(), "can't schedule in the past", "and says so");
  const off = await geo();
  await dragBubble("Garden", { x: off.centre.x + (off.bands.later.outer + 14) * off.k, y: off.centre.y }, async () => {
    eq(await text(".db2-draglabel"), "off the board · cancel", "off the board cancels");
  });
  await dragBubble("Garden", await onRing("weekend", 0.5, 300), async () => {
    eq(await text(".db2-draglabel"), "weekend · 📅 07-18", "weekend means the coming Saturday");
  });
  await until(async () => (await db()).get("Garden").attrs.date === "2026-07-18", "Garden to be due on Saturday");
  eq((await db()).head, head + 1, "dropping on the date it has, on the past, or off the board wrote nothing");
  await caughtUp();
  await dragBubble("Garden", await onRing("month", 0.5, 0), async () => {
    eq(await text(".db2-draglabel"), "month · 📅 08-02", "the month ring picks a date by how far across");
  });
  await until(async () => (await db()).get("Garden").attrs.date === "2026-08-02", "Garden to be due on 08-02");
  await caughtUp();
  g = await geo();
  ok(at("Garden").ring === "month" && at("Garden").cls.includes("db2-faded") && at("Garden").cls.includes("db2-halo"),
    "changed this session, it stays drawn (faded) in a hidden ring");
  await dragBubble("Garden", await onRing("month", 0, 0));
  await until(async () => (await db()).get("Garden").attrs.date === "2026-07-20", "the inner edge to be the Monday after the weekend");
  await caughtUp();
  await dragBubble("Garden", await onRing("month", 1, 0));
  await until(async () => (await db()).get("Garden").attrs.date === "2026-08-15", "the outer edge to be 31 days out");
  await caughtUp();

  await dragBubble("Garden", await onRing("later", 0.5, 0), async () => {
    eq(await text(".db2-draglabel"), "later · pick a date", "later asks for a date");
  });
  ok((await bubble("Garden")).open, "the bubble opens");
  eq(await page.evaluate(() => { const i = document.querySelector(".db2-date input"); return [i.type, i.value, document.activeElement === i]; }),
    ["date", "2026-08-15", true], "showing an inline date field, 31 days out by default");
  await page.fill(".db2-date input", "2026-09-01");
  await page.keyboard.press("Enter");
  await until(async () => (await db()).get("Garden").attrs.date === "2026-09-01", "Garden to be scheduled");
  eq((await db()).get("Garden").attrs.date_kind, "scheduled", "as a scheduled date");
  await caughtUp();
  g = await geo();
  ok(at("Garden").ring === "later" && !(await visible(".db2-date")), "it sits in later, and the field is gone");
  eq(await page.evaluate(() => [...document.querySelectorAll(".db2-bubble.db2-open .db2-m")].map(e => e.textContent).join(" · ")),
    "⏳ 09-01", "its meta line shows the scheduled date");
  await page.keyboard.press("Escape");

  await dragBubble("Deploy", await onRing("today", 0.5, 300));
  await until(async () => (await db()).get("Deploy").attrs.date === TODAY, "Deploy to be due today");
  await until(async () => (await message()) === 'date set · still placed by its subtask "Smoke test", due 07-14', "the note that a subtask still places it");
  await caughtUp();
  eq((await bubble("Deploy")).ring, "overdue", "it stays where its subtask's deadline puts it");
  await click("Deploy");
  eq(await page.evaluate(() => [...document.querySelectorAll(".db2-bubble.db2-open .db2-m")].map(e => e.textContent).join(" · ")),
    "📅 07-15 · subtask due 07-14", "and its meta line says why");
  await page.keyboard.press("Escape");
  const reschedules = (await edits(head)).filter(e => e.actor.id === CLIENT);
  ok(reschedules.every(e => e.type === "task.attrs_set" && e.correlation_id === sid), "every reschedule was one set_attributes for this session");

  // ── F. reorganising: a draft, not edits ─────────────────────────────────────
  head = (await db()).head;
  await click("Thesis");
  const target = await bubble("Outline");
  await dragBubble("Draft intro", { x: target.x, y: target.y }, async () => {
    eq(await text(".db2-draglabel"), 'merge with "Outline"', "the label names the merge");
  });
  g = await geo();
  const group = g.bubbles.find(b => b.title === "Outline + Draft intro");
  ok(group && group.level === 1 && group.cls.includes("db2-draft"), "merge: a new group, marked as the draft's, takes the target's place");
  ok(!(await has("Outline")) && !(await has("Draft intro")), "and holds both");
  eq(await hudDraft(), "reorganising · applies once you close the bubble", "the HUD says a reorganisation is in progress");
  ok((await visible('.db2-tool[data-tool="apply"]')) && (await visible('.db2-tool[data-tool="discard"]')), "apply now and discard are offered");
  let draft = (await until(async () => {
    const list = await drafts("open");
    return list.length === 1 && list[0].ops.length === 1 && list[0].hold_until ? list : null;
  }, "the draft to reach the server"))[0];
  eq([draft.client, draft.settle_ms, draft.vocabulary.length > 100], [CLIENT, 6000, true], "a draft of this client, settling in 6s, with a vocabulary");
  eq(draft.after, {
    nodes: [
      { id: id.intro, parent: "new:g1", title: null, attrs: {} },
      { id: id.outline, parent: "new:g1", title: null, attrs: {} },
      { id: "new:g1", parent: id.thesis, title: "Outline + Draft intro", attrs: {} },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    removed: [],
  }, "its `after` is the intended structure");
  eq(draft.ops[0], { op: "merge", dragged: id.intro, target: id.outline, group: "new:g1", title: "Outline + Draft intro" }, "and its op says what was done");
  ok(Date.parse(draft.hold_until) - Date.parse(draft.updated_at) > 10_000, "it is held while the bubble is open");
  eq((await db()).head, head, "nothing is written while reorganising");

  await click("Outline + Draft intro");
  g = await geo();
  ok(g.bubbles.find(b => b.title === "Outline + Draft intro").open, "the group opens like any bubble");
  eq(g.bubbles.filter(b => b.level === 2).map(b => b.title).sort(), ["Draft intro", "Outline"], "with its two parts inside");
  ok(!g.controls.some(c => c.id === "new:g1"), "a group that isn't in the database yet has no controls");
  await page.keyboard.press("Escape");

  const other = await bubble("Taxes");
  await dragBubble("Figures", { x: other.x, y: other.y }, async () => {
    eq(await text(".db2-draglabel"), "bubbles only merge within the same root task", "another root's bubble refuses");
  });
  eq(await message(), "bubbles only merge within the same root task", "and says so");

  // Pop works at any depth; but two nested levels can't go in one draft (the server
  // would reject it), so the second is refused. Collapse brings the first back.
  await click("Figures");
  await click("Fig 1");
  p = await emptySpace("Fig 1");
  await page.mouse.click(p.x, p.y);
  g = await geo();
  ok(!(await has("Fig 1")) && at("Figures").open, "pop inside a subtask: the inner level is gone, the one around it still open");
  eq(g.bubbles.filter(b => b.level === 2).map(b => b.title).sort(), ["Fig 1a", "Fig 1b", "Fig 2"], "and its subtasks moved up one level");
  p = await emptySpace("Figures");
  await page.mouse.click(p.x, p.y);
  ok((await message()).startsWith("can't dissolve two nested levels"), `the nested pop is refused: ${await message()}`);
  ok((await bubble("Figures")).open, "and Figures stays as it was");
  await page.click('.db2-tool[data-tool="collapse"]');
  draft = (await until(async () => {
    const list = await drafts("open");
    return list[0]?.ops.length === 3 ? list : null;
  }, "the pop and its collapse to reach the server"))[0];
  eq([draft.ops.map(o => o.op), draft.after.removed, draft.after.nodes.length], [["merge", "pop", "collapse"], [], 3], "Fig 1 is back: only the merge is left");
  await click("Thesis");
  ok(!(await has("Fig 1a")), "the board is closed up again");

  // Pop: the empty space of an open subtask that has subtasks dissolves that level.
  await click("Figures");
  p = await emptySpace("Figures");
  await page.mouse.click(p.x, p.y);
  g = await geo();
  ok(!(await has("Figures")), "pop: the level is gone");
  eq(g.bubbles.filter(b => b.level === 1 && ["Fig 1", "Fig 2"].includes(b.title)).length, 2, "and its subtasks took its place");
  ok(at("Thesis").open, "the parent stays open");
  eq(await text('.db2-tool[data-tool="collapse"]'), "collapse (1)", "collapse says how many groups it would restore");
  draft = (await until(async () => {
    const list = await drafts("open");
    return list[0]?.ops.length === 4 ? list : null;
  }, "the pop to reach the server"))[0];
  eq(draft.after.removed, [id.figures], "the popped task is to be removed");
  eq(draft.after.nodes.filter(n => n.parent === id.thesis && n.id !== "new:g1").map(n => n.id).sort(), [id.fig1, id.fig2, id.figOld].sort(),
    "and every subtask moves up, the released one too");
  eq(draft.ops[3].op, "pop", "as a pop op");

  // Collapse: close everything and bring the popped level back.
  const released = Date.now();
  await page.click('.db2-tool[data-tool="collapse"]');
  g = await geo();
  ok(!at("Thesis").open, "collapse closes everything");
  ok(!(await visible('.db2-tool[data-tool="collapse"]')), "nothing left to collapse");
  draft = (await until(async () => {
    const list = await drafts("open");
    return list[0]?.ops.length === 5 ? list : null;
  }, "the collapse to reach the server"))[0];
  eq([draft.after.removed, draft.after.nodes.length, draft.ops[4]], [[], 3, { op: "collapse", restored: [id.figures] }], "Figures is restored: only the merge is left");
  await until(async () => /^reorganised · applies in \d+s$/.test(await hudDraft()), "the HUD to count down to the apply");

  // With the board closed the lease is released and the server applies the draft ~6s later.
  await until(async () => (await db()).get("Outline + Draft intro"), "the server to apply the draft", 20_000);
  const took = Date.now() - released;
  ok(took > 4500, `it waited for the draft to settle (${took}ms)`);
  d = await db();
  eq([d.parentOf("Outline + Draft intro"), d.parentOf("Outline"), d.parentOf("Draft intro"), d.parentOf("Fig 1"), d.get("Figures").state],
    ["Thesis", "Outline + Draft intro", "Outline + Draft intro", "Figures", "open"], "the database has the merge, and Figures untouched");
  const applied = (await drafts("applied"))[0];
  const draftEdits = await edits(head);
  eq(draftEdits.map(e => [e.type, e.correlation_id === applied.id, e.actor.id]),
    [["task.created", true, CLIENT], ["task.reparented", true, CLIENT], ["task.reparented", true, CLIENT]], "as three edits that share the draft's id");
  await until(async () => (await message()) === "reorganisation applied · 3 edits · ↺ undoes", "the applied message");
  await caughtUp();
  const inSession = new Set((await session()).edits.map(e => e.seq));
  ok(draftEdits.every(e => inSession.has(e.seq)), "the draft's edits joined the session, so ↺ can undo them");
  ok((await bubble("Thesis")).cls.includes("db2-halo"), "and Thesis has a halo");
  eq(await hudDraft(), "", "the HUD no longer mentions a reorganisation");
  ok(!(await visible('.db2-tool[data-tool="apply"]')), "and the draft buttons are gone");

  // A subtask dropped on empty board becomes a root, keeping its old root's category and section.
  head = (await db()).head;
  await click("Thesis");
  await dragBubble("Figures", await emptyBoard(), async () => {
    eq(await text(".db2-draglabel"), "make it a root task", "the label says it would become a root");
  });
  g = await geo();
  ok(at("Figures").level === 0 && at("Figures").ring === "later" && at("Figures").cls.includes("db2-draft") && at("Figures").wx < 0 && at("Figures").wy < 0,
    "it is drawn as a root in its old root's quadrant, though later is hidden");
  draft = (await until(async () => ((await drafts("open"))[0]?.ops.length === 1 ? drafts("open") : null), "the new draft"))[0];
  eq(draft.after, { nodes: [{ id: id.figures, parent: null, title: null, attrs: { category: "uni", section: "writing" } }], removed: [] }, "the draft gives it the category and section");
  await page.click('.db2-tool[data-tool="apply"]');
  await until(async () => (await db()).get("Figures").parent_id === null, "apply now to apply it");
  d = await db();
  eq(d.get("Figures").attrs, { category: "uni", section: "writing" }, "Figures is a uni root in the writing section");
  eq((await edits(head)).map(e => e.type), ["task.reparented", "task.attrs_set"], "as a move and a set_attributes");
  await caughtUp();

  // Dropping inside an open bubble moves a subtask there; moving it back cancels the draft.
  head = (await db()).head;
  if (!(await bubble("Thesis")).open) await click("Thesis");
  await click("Outline + Draft intro");
  await dragBubble("Outline", await emptySpace("Thesis"), async () => {
    eq(await text(".db2-draglabel"), 'move into "Thesis"', "the label names the open bubble");
  });
  g = await geo();
  ok(at("Outline").level === 1 && at("Outline").cls.includes("db2-draft"), "the subtask is now Thesis's, marked as moved");
  ok(g.bubbles.find(b => b.title === "Outline + Draft intro"), "a task that exists doesn't dissolve when it holds one bubble");
  draft = (await until(async () => ((await drafts("open"))[0]?.ops.length === 1 ? drafts("open") : null), "the move's draft"))[0];
  eq(draft.after, { nodes: [{ id: id.outline, parent: id.thesis, title: null, attrs: {} }], removed: [] }, "one move");
  await dragBubble("Outline", await emptySpace("Outline + Draft intro"));
  await until(async () => (await drafts("open")).length === 0, "the draft that cancelled out to be discarded");
  eq((await drafts("discarded")).length, 1, "it was discarded, not applied");
  eq(await hudDraft(), "", "and the HUD is quiet again");
  eq((await db()).head, head, "nothing was written");
  await dragBubble("Draft intro", await emptySpace("Outline + Draft intro"));
  ok(!(await visible('.db2-tool[data-tool="apply"]')), "dropping a subtask in the bubble it is already in does nothing");
  await page.keyboard.press("Escape");

  // An open draft is laid back over the tasks after a reload.
  const biblio = await bubble("Bibliography");
  await dragBubble("Proofread", { x: biblio.x, y: biblio.y });
  await until(async () => (await drafts("open"))[0]?.ops.length === 1, "the merge to reach the server");
  await open();
  await until(async () => (await page.evaluate(() => document.querySelector(".db2-hud-draft").dataset.phase)) === "settling", "the reloaded board to show the draft");
  ok((await bubble("Thesis")).cls.includes("db2-halo"), "the halo survived the reload");
  await click("Thesis");
  g = await geo();
  const again = g.bubbles.find(b => b.title === "Bibliography + Proofread");
  ok(again && again.cls.includes("db2-draft") && !(await has("Proofread")), "the draft's group is drawn again");
  eq(await hudDraft(), "reorganising · applies once you close the bubble", "and opening a bubble holds the draft again");

  // ✕ refuses while the reorganisation touches the task.
  head = (await db()).head;
  await press("Thesis", "discard");
  ok((await message()).startsWith("can't discard"), `discard is refused: ${await message()}`);
  eq((await db()).head, head, "and nothing is discarded");

  // Discard throws the draft away.
  await page.click('.db2-tool[data-tool="discard"]');
  await until(async () => (await drafts("open")).length === 0, "the draft to be discarded");
  ok(!(await has("Bibliography + Proofread")) && (await has("Proofread")), "the board shows the tasks as they are");
  eq((await db()).head, head, "and nothing was written");

  // A draft the server can't apply is reported, and the board reloads.
  const biblio2 = await bubble("Bibliography");
  await dragBubble("Proofread", { x: biblio2.x, y: biblio2.y });
  await until(async () => (await drafts("open"))[0]?.ops.length === 1, "the merge to reach the server");
  await cmd("discard_task", { task_id: id.proof }); // someone else discards a task the draft needs
  await page.click('.db2-tool[data-tool="apply"]');
  await until(async () => (await message())?.startsWith("reorganisation not applied: "), "the rejection to be shown");
  await caughtUp();
  ok(!(await has("Bibliography + Proofread")) && !(await has("Proofread")) && (await has("Bibliography")), "the board reloaded: no group, no Proofread");
  eq((await drafts("rejected")).length, 1, "the draft is marked rejected");
  await page.keyboard.press("Escape");

  // ↺ on a bubble undoes the reorganisation's edits under it.
  await click("Thesis");
  await press("Thesis", "undo");
  await until(async () => (await db()).get("Outline + Draft intro").state === "discarded", "the merge to be undone");
  d = await db();
  eq([d.parentOf("Outline"), d.parentOf("Draft intro")], ["Thesis", "Thesis"], "the parts are back under Thesis");
  await caughtUp();
  await page.keyboard.press("Escape");

  // ── G. adding a root from the toolbar ───────────────────────────────────────
  await page.click('.db2-tool[data-tool="add"]');
  ok(await visible(".db2-panel"), "+ add opens a panel");
  eq(await page.evaluate(() => [...document.querySelectorAll(".db2-cat")].map(b => b.textContent)), ["uni", "work", "projects", "admin"], "with the four categories");
  await page.click('.db2-cat[data-category="uni"]');
  eq(await page.evaluate(() => [...document.querySelectorAll(".db2-panel datalist option")].map(o => o.value)), ["reading", "writing"], "and suggests the sections used in that category");
  await page.click('.db2-cat[data-category="projects"]');
  await page.fill(".db2-panel-section", "home");
  await page.fill(".db2-panel-title", "Paint the fence");
  await page.keyboard.press("Enter");
  await until(async () => (await db()).get("Paint the fence"), "the root to be created");
  d = await db();
  eq([d.get("Paint the fence").parent_id, d.get("Paint the fence").attrs], [null, { category: "projects", section: "home" }], "a root with its category and section, and no date");
  await caughtUp();
  g = await geo();
  ok(at("Paint the fence").ring === "later" && at("Paint the fence").cls.includes("db2-faded") && at("Paint the fence").cls.includes("db2-halo"),
    "it appears in later, drawn faded although later is hidden");
  await page.keyboard.press("Escape");
  ok(!(await visible(".db2-panel")), "Esc closes the panel");

  // ── H. the two views don't affect each other ────────────────────────────────
  const sheets = () => page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href.split("/").pop()));
  ok((await sheets()).every(s => s.startsWith("dartboard2-")), `only this view's stylesheet is loaded: ${await sheets()}`);
  await page.goto(`${BASE}/?view=dartboard`);
  await page.waitForFunction(() => document.querySelector("#app").children.length > 0);
  ok(!(await page.evaluate(() => !!document.querySelector(".db2"))), "the old view is still there under its own name");
  ok((await sheets()).every(s => !s.startsWith("dartboard2-")), "and it doesn't load this view's stylesheet");
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => document.querySelector("#app").children.length > 0);
  ok(await page.evaluate(() => !!document.querySelector(".db2")), "with no view named, this one is shown");

  eq(problems, [], "no errors in the page");

  // The log replays to the same tasks: everything written was an ordinary, valid edit.
  const verify = await promisify(execFile)("uv", ["run", "misty", "db", "verify", "--db", join(tmp, "e2e.db")], { cwd: REPO })
    .then(r => ({ code: 0, out: r.stdout + r.stderr }), e => ({ code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }));
  ok(verify.code === 0, `misty db verify passes: ${verify.out.trim()}`);
}

let failed = null;
const started = Date.now();
try {
  await main();
} catch (e) {
  failed = e;
  if (page) {
    const shot = join(tmpdir(), `dartboard2-e2e-failure-${Date.now()}.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    console.error(`screenshot: ${shot}`);
  }
} finally {
  await browser?.close().catch(() => undefined);
  server.kill();
  await new Promise(r => { if (server.exitCode !== null) r(); else server.once("exit", r); setTimeout(r, 3000); });
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}
if (failed) {
  console.error(failed.stack ?? String(failed));
  if (problems.length) console.error(`page problems:\n  ${problems.join("\n  ")}`);
  console.error(`dartboard2 e2e: FAILED after ${steps} checks, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(1);
}
console.log(`dartboard2 e2e: ok · ${steps} checks · ${((Date.now() - started) / 1000).toFixed(1)}s`);
