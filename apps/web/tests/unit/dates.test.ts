import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, asDate, comingSaturday, diffDays, dropFor, dropLabel, isoOf, mondayAfterWeekend, monthDate,
  ringFor, weekday,
} from "../../src/views/dartboard2/dates.ts";
import { TODAY } from "./helpers.ts";

test("isoOf gives the local calendar date", () => {
  assert.equal(isoOf(new Date(2026, 6, 15, 9, 0, 0)), "2026-07-15");
  assert.equal(isoOf(new Date(2026, 0, 1, 0, 0, 1)), "2026-01-01");
  assert.equal(isoOf(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31");
});

test("asDate accepts real dates only", () => {
  assert.equal(asDate("2026-07-15"), "2026-07-15");
  assert.equal(asDate("2026-02-30"), null);
  assert.equal(asDate("15/07/2026"), null);
  assert.equal(asDate(undefined), null);
  assert.equal(asDate(20260715), null);
});

test("day arithmetic crosses months and years", () => {
  assert.equal(addDays("2026-07-31", 1), "2026-08-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(diffDays("2026-08-15", TODAY), 31);
  assert.equal(weekday(TODAY), 3);
});

test("the coming Saturday is today on a Saturday", () => {
  assert.equal(comingSaturday(TODAY), "2026-07-18");
  assert.equal(comingSaturday("2026-07-18"), "2026-07-18");
  assert.equal(comingSaturday("2026-07-19"), "2026-07-25"); // a Sunday looks to next week
  assert.equal(mondayAfterWeekend(TODAY), "2026-07-20");
});

test("rings: first match wins, from overdue to later", () => {
  const ring = (d: string | null) => ringFor(d, TODAY);
  assert.equal(ring("2026-07-14"), "overdue");
  assert.equal(ring("2020-01-01"), "overdue");
  assert.equal(ring("2026-07-15"), "today");
  assert.equal(ring("2026-07-16"), "tomorrow");
  assert.equal(ring("2026-07-17"), "weekend");
  assert.equal(ring("2026-07-19"), "weekend"); // the weekend's Sunday
  assert.equal(ring("2026-07-20"), "month");
  assert.equal(ring("2026-08-15"), "month"); // 31 days out
  assert.equal(ring("2026-08-16"), "later");
  assert.equal(ring(null), "later");
});

test("on a Saturday, Sunday is tomorrow and the weekend ring holds nothing else", () => {
  const sat = "2026-07-18";
  assert.equal(ringFor("2026-07-18", sat), "today");
  assert.equal(ringFor("2026-07-19", sat), "tomorrow");
  assert.equal(ringFor("2026-07-20", sat), "month");
});

test("on a Friday the weekend's Saturday is tomorrow", () => {
  assert.equal(ringFor("2026-07-18", "2026-07-17"), "tomorrow");
  assert.equal(ringFor("2026-07-19", "2026-07-17"), "weekend");
});

test("the month ring maps its width onto Monday … 31 days out", () => {
  assert.equal(monthDate(0, TODAY), "2026-07-20");
  assert.equal(monthDate(1, TODAY), "2026-08-15");
  assert.equal(monthDate(0.5, TODAY), "2026-08-02");
  assert.equal(monthDate(-3, TODAY), "2026-07-20");
  assert.equal(monthDate(7, TODAY), "2026-08-15");
  let last = "";
  for (let t = 0; t <= 1; t += 0.01) {
    const d = monthDate(t, TODAY);
    assert.ok(d >= last);
    assert.equal(ringFor(d, TODAY), "month");
    last = d;
  }
});

test("drops: what each ring does, and what the pointer label says", () => {
  assert.deepEqual(dropFor("today", 0, TODAY), { kind: "set", ring: "today", date: "2026-07-15" });
  assert.deepEqual(dropFor("tomorrow", 0, TODAY), { kind: "set", ring: "tomorrow", date: "2026-07-16" });
  assert.deepEqual(dropFor("weekend", 0, TODAY), { kind: "set", ring: "weekend", date: "2026-07-18" });
  assert.deepEqual(dropFor("month", 1, TODAY), { kind: "set", ring: "month", date: "2026-08-15" });
  assert.deepEqual(dropFor("later", 0, TODAY), { kind: "pick", ring: "later", suggested: "2026-08-15" });
  assert.equal(dropLabel(dropFor("tomorrow", 0, TODAY)), "tomorrow · 📅 07-16");
  assert.equal(dropLabel(dropFor("later", 0, TODAY)), "later · pick a date");
  assert.equal(dropLabel(dropFor("overdue", 0, TODAY)), "overdue · can't schedule in the past");
  assert.equal(dropLabel(dropFor(null, 0, TODAY)), "off the board · cancel");
});
