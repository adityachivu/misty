// Drives the dartboard with REAL CLICKS against a real misty server on a throwaway
// database, and checks every gesture against what landed in the edit log.
// window.__state() is for assertions only, never for driving.
//
//   npm run build && npm run test:e2e        (SCREENSHOTS=dir to save screenshots)
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "misty-e2e-"));
const DB = join(dir, "misty.db");
const SHOTS = process.env.SCREENSHOTS;

// ── server ───────────────────────────────────────────────────────────────────
const server = spawn("uv", ["run", "misty", "serve", "--db", DB, "--port", String(PORT)], { cwd: REPO, stdio: "pipe" });
const serverErr = [];
server.stderr.on("data", d => serverErr.push(String(d)));
const cleanup = () => { try { server.kill(); } catch {} rmSync(dir, { recursive: true, force: true }); };
process.once("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => process.exit(1));
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/api/tasks`)).ok) break; } catch {}
  if (i > 100) throw new Error("server never came up:\n" + serverErr.join(""));
  await new Promise(r => setTimeout(r, 100));
}

const command = async (tool, args) => {
  const r = await fetch(`${BASE}/api/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args, actor_id: "seed" }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${tool}: ${body.detail}`);
  return body.edit;
};
const db = async () => (await (await fetch(`${BASE}/api/tasks`)).json()).tasks;
const dbTask = async title => (await db()).find(t => t.title === title);
const edits = async () => (await fetch(`${BASE}/api/edits`)).json();

// ── fixture: Wednesday 2026-07-15 ────────────────────────────────────────────
const create = async (title, attrs = {}, parent_id = null) =>
  (await command("create_task", { title, attrs, parent_id })).task_id;
const evals = await create("understand evaluations", { category: "work", section: "EMAS Alert Automation", date: "2026-07-15", date_kind: "due" });
await create("metrics", {}, evals);
await create("baseline", {}, evals);
await create("gemma 4 project", { category: "projects" });
await create("pay rent", { category: "admin", section: "Home", date: "2026-07-14", date_kind: "due" });
await create("plan exam prep", { category: "uni", date: "2026-07-16", date_kind: "due" });
await create("captured by an agent");   // no category, no date

// ── checks ───────────────────────────────────────────────────────────────────
let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 50)); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// bands are the viewer's today, so pin it to the fixture date
await page.clock.setFixedTime(new Date("2026-07-15T09:00:00"));
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
await page.goto(BASE);
await page.waitForSelector("#viewport[data-ready]");

const state = () => page.evaluate(() => window.__state());
const walk = (n, label) => n.text === label ? n : (n.children ?? []).reduce((a, c) => a ?? walk(c, label), null);
const nodeOf = async label => { for (const n of await state()) { const f = walk(n, label); if (f) return f; } return null; };
const rootBubble = async label => page.locator("#bubbles > .bubble").nth((await state()).findIndex(n => n.text === label));
const kidBubble = label => page.locator("#bubbles .bubble.kid").filter({ has: page.locator("> .body > .text", { hasText: label }) }).first();
const clickBubble = async loc => { await loc.click(); await page.waitForTimeout(150); };
const clickOp = async (loc, op) => { await loc.locator(`> .body > .emoji-row > .emoji[data-op="${op}"]`).click(); await page.waitForTimeout(150); };
const shot = async name => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) });

// bands and wedges come from the database attributes
const bands = Object.fromEntries((await state()).map(n => [n.text, n.band]));
check("bands from date/date_kind", bands, {
  "understand evaluations": "today", "gemma 4 project": "rim", "pay rent": "overdue",
  "plan exam prep": "tomorrow", "captured by an agent": "rim",
});
check("every categorised bubble sits in its wedge and band", await page.evaluate(() => window.__audit()), []);
await shot("1-boot");

// one click opens: subtasks and controls at once
const evalsB = await rootBubble("understand evaluations");
check("bubbles start idle", (await nodeOf("understand evaluations")).state, "idle");
await clickBubble(evalsB);
check("a single click opens it", (await nodeOf("understand evaluations")).state, "open");
check("...showing its subtasks", await evalsB.locator("> .body > .kids > .bubble.kid > .body > .text").allInnerTexts(), ["metrics", "baseline"]);
check("...and the seven controls (↺ hidden until something changes)",
  await evalsB.locator("> .body > .emoji-row > .emoji:visible").allTextContents(), ["☀️", "➡️", "📅", "⏳", "⚡", "✓", "➕"]);
check("meta shows section + date", (await evalsB.locator("> .body > .meta").innerText()).includes("EMAS Alert Automation"), true);
await shot("2-open");

// a subtask opens inside its parent, with only ✓ ⚡ ➕
await clickBubble(kidBubble("metrics"));
check("focus is a chain", (await page.evaluate(() => window.__focus())).path.length, 2);
check("subtask controls: no date ops", await kidBubble("metrics").locator("> .body > .emoji-row > .emoji:visible").allTextContents(), ["⚡", "✓", "➕"]);
await clickOp(kidBubble("metrics"), "done");
check("✓ on a subtask completes it in the db", await until(async () => (await dbTask("metrics"))?.state === "done"), true);
check("...and it shows done + pending", await until(async () => { const n = await nodeOf("metrics"); return n?.done && n.pending; }), true);
const doneEdit = (await edits()).at(-1);
check("the edit is attributed to the dartboard", doneEdit.actor, { kind: "user", id: "web:dartboard" });
check("...and tagged with this board session", doneEdit.correlation_id, (await page.evaluate(() => window.__session())).id);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
check("esc backs out one level at a time, to idle", (await nodeOf("understand evaluations")).state, "idle");

// ➡️ moves a root to tomorrow: the attribute changes, the bubble swims
await clickBubble(await rootBubble("pay rent"));
await clickOp(await rootBubble("pay rent"), "tomorrow");
check("➡️ sets date + date_kind in the db", await until(async () => (await dbTask("pay rent")).attrs.date === "2026-07-16"), true);
check("...and the bubble's band follows", (await nodeOf("pay rent")).band, "tomorrow");
await clickOp(await rootBubble("pay rent"), "zap");
check("⚡ sets quick", await until(async () => (await dbTask("pay rent")).attrs.quick === true), true);
await clickOp(await rootBubble("pay rent"), "zap");
check("⚡ again unsets it", await until(async () => !("quick" in (await dbTask("pay rent")).attrs)), true);

// ⏳ later: inline date panel, sets a scheduled date → rim
await clickBubble(await rootBubble("plan exam prep"));
await clickOp(await rootBubble("plan exam prep"), "later");
await (await rootBubble("plan exam prep")).locator("> .body > .datepick input").fill("2026-09-01");
check("⏳ sets a scheduled date", await until(async () => (await dbTask("plan exam prep")).attrs.date_kind === "scheduled"), true);
check("...which lives on the rim", await until(async () => (await nodeOf("plan exam prep")).band === "rim"), true);

// ➕ break down: an open childless bubble invites a subtask
await clickBubble(await rootBubble("gemma 4 project"));
await page.keyboard.type("write the outline");
await page.keyboard.press("Enter");
const gemmaId = (await dbTask("gemma 4 project")).id;
check("typing + ↵ creates a subtask in the db", await until(async () => (await dbTask("write the outline"))?.parent_id === gemmaId), true);
check("...shown inside the open parent", await until(async () => (await (await rootBubble("gemma 4 project")).locator("> .body > .kids .text").allInnerTexts()).includes("write the outline")), true);
check("parent is now pending (↺ visible)", await (await rootBubble("gemma 4 project")).locator('> .body > .emoji-row > .emoji[data-op="undo"]').isVisible(), true);
await shot("3-breakdown");

// ↺ on the parent undoes the subtree's changes
await clickOp(await rootBubble("gemma 4 project"), "undo");
check("↺ discards the new subtask (via undo_edit)", await until(async () => (await dbTask("write the outline")).state === "discarded"), true);
check("...and the halo clears", (await nodeOf("gemma 4 project")).pending, false);

// + add: a new root, starting undated on the rim
await page.click("#addBtn");
await page.click('.cat-btn[data-cat="admin"]');
await page.fill("#sectionInput", "Home");
await page.press("#sectionInput", "Enter");
await page.keyboard.type("fix the tap");
await page.keyboard.press("Enter");
check("+ add creates a root with category/section", await until(async () => (await dbTask("fix the tap"))?.attrs.section === "Home"), true);
check("...on the rim, in the admin wedge", await until(async () => (await nodeOf("fix the tap"))?.band === "rim"), true);

// session changes survive a reload (sessionStorage), halo and all
await page.reload();
await page.waitForSelector("#viewport[data-ready]");
check("after reload, changed tasks still carry the halo", (await nodeOf("pay rent")).pending, true);
check("reset all is offered", await page.isVisible("#resetBtn"), true);
await shot("4-before-reset");

// reset all: two clicks, undoes everything from this session
await page.click("#resetBtn");
check("first click asks to confirm", await page.innerText("#resetBtn"), "confirm reset?");
await page.click("#resetBtn");
check("reset all restores pay rent", await until(async () => (await dbTask("pay rent")).attrs.date === "2026-07-14"), true);
check("...reopens metrics", (await dbTask("metrics")).state, "open");
check("...unschedules exam prep", (await dbTask("plan exam prep")).attrs.date_kind, "due");
check("...and discards the new root", (await dbTask("fix the tap")).state, "discarded");
check("...nothing left to undo", (await page.evaluate(() => window.__session())).staged.length, 0);
check("bubbles are back home", await until(async () => (await page.evaluate(() => window.__audit())).length === 0), true);
await shot("5-after-reset");

check("no page errors", pageErrors, []);
await browser.close();

const verify = execFileSync("uv", ["run", "misty", "db", "verify", "--db", DB], { cwd: REPO }).toString().trim();
check("misty db verify after all of it", verify, "ok: replaying the log reproduces the tasks table");

console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
process.exit(fails ? 1 : 0);
