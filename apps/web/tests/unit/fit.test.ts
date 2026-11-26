import { test } from "node:test";
import assert from "node:assert/strict";
import { fill, fitLabel, fitTitle, lineWidths } from "../../src/views/dartboard2/fit.ts";
import { measure } from "./helpers.ts";

/** Every line fits the circle at its own height. */
function inside(lines: string[], radius: number, lineHeight: number): void {
  const widths = lineWidths(radius, lines.map(() => lineHeight));
  lines.forEach((line, i) => assert.ok(measure(line) <= widths[i] + 1e-9, `"${line}" is wider than ${widths[i]}`));
}

test("lines are narrower the further they are from the middle", () => {
  const w = lineWidths(50, [10, 10, 10]);
  assert.ok(w[0] < w[1] && w[2] < w[1]);
  assert.equal(w[0], w[2]);
  assert.ok(Math.abs(w[1] - 2 * Math.sqrt(50 * 50 - 5 * 5)) < 1e-9);
  assert.deepEqual(lineWidths(10, [30]), [0]);
});

test("a short title takes one line", () => {
  assert.deepEqual(fitTitle("Buy milk", 43, 15, measure), { lines: ["Buy milk"], truncated: false });
});

test("a title takes as few lines as hold it, breaking only between words", () => {
  const title = "Write the methods chapter draft";
  const fit = fitTitle(title, 43, 15, measure);
  assert.equal(fit.truncated, false);
  assert.equal(fit.lines.join(" "), title);
  assert.ok(fit.lines.every(Boolean), "an empty line would push the title off centre");
  inside(fit.lines, 43, 15);
  for (let n = 1; n < fit.lines.length; n++) {
    const widths = lineWidths(43, Array<number>(n).fill(15));
    assert.ok(fill(title.split(" "), widths, measure).used < title.split(" ").length, `${n} lines would have held it`);
  }
});

test("what doesn't fit ends in an ellipsis, with whole words before it", () => {
  const title = "Prepare the quarterly report for the steering committee and circulate it to everyone beforehand";
  const fit = fitTitle(title, 30, 15, measure);
  assert.equal(fit.truncated, true);
  inside(fit.lines, 30, 15);
  const text = fit.lines.filter(Boolean).join(" ");
  assert.ok(text.endsWith("…"));
  const words = text.slice(0, -1).split(" ");
  assert.deepEqual(words, title.split(" ").slice(0, words.length));
});

test("a word wider than the circle is cut, never drawn over the rim", () => {
  const fit = fitTitle("Supercalifragilisticexpialidocious", 20, 14, measure);
  assert.equal(fit.truncated, true);
  inside(fit.lines, 20, 14);
  assert.ok(fit.lines.some(l => l.endsWith("…")));
});

test("a tiny circle gets nothing rather than overflowing text", () => {
  const fit = fitTitle("Hello", 4, 14, measure);
  inside(fit.lines, 4, 14);
});

test("no title, no lines", () => {
  assert.deepEqual(fitTitle("   ", 40, 14, measure), { lines: [], truncated: false });
});

test("an open bubble's label: the name, then the meta line, both inside the circle", () => {
  const fit = fitLabel("Plan the offsite", "ops · 📅 07-16 · subtask due 07-15", 58, 18, 12, measure, measure);
  assert.equal(fit.title.truncated, false);
  assert.equal(fit.meta.truncated, false);
  assert.equal(fit.title.lines.join(" "), "Plan the offsite");
  assert.equal(fit.meta.lines.filter(Boolean).join(" · "), "ops · 📅 07-16 · subtask due 07-15");
  const heights = [...fit.title.lines.map(() => 18), ...fit.meta.lines.map(() => 12)];
  const widths = lineWidths(58, heights);
  [...fit.title.lines, ...fit.meta.lines].forEach((line, i) => assert.ok(measure(line) <= widths[i]));
});

test("a long name in an open bubble is cut short and keeps its meta line", () => {
  const long = "Reconcile every outstanding invoice from the last three financial years with the ledger";
  const fit = fitLabel(long, "no date", 44, 16, 11, measure, measure);
  assert.equal(fit.title.truncated, true);
  assert.deepEqual(fit.meta.lines, ["no date"]);
  const heights = [...fit.title.lines.map(() => 16), ...fit.meta.lines.map(() => 11)];
  const widths = lineWidths(44, heights);
  [...fit.title.lines, ...fit.meta.lines].forEach((line, i) => assert.ok(measure(line) <= widths[i]));
});

test("when the meta line is too long, the name still takes as few lines as hold it", () => {
  const fit = fitLabel("Review the work", "a-very-long-section-name · 📅 07-16 · subtask due 07-15", 60, 18, 12, measure, measure);
  assert.equal(fit.title.truncated, false);
  assert.deepEqual(fit.title.lines, ["Review the work"]);
  assert.equal(fit.meta.truncated, true);
  assert.equal(fit.meta.lines.length, 1);
  assert.ok(fit.meta.lines[0].endsWith("…"));
});
