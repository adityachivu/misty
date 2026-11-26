// Local calendar dates as `YYYY-MM-DD` strings, and the rule that turns a deadline
// into a ring. Pure: "today" is always passed in.

export type Ring = "overdue" | "today" | "tomorrow" | "weekend" | "month" | "later";

/** Centre outwards. */
export const RINGS: readonly Ring[] = ["overdue", "today", "tomorrow", "weekend", "month", "later"];

/** Rings drawn in the short view. */
export const NEAR_RINGS: readonly Ring[] = ["overdue", "today", "tomorrow", "weekend"];

export const MONTH_DAYS = 31;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local date of a `Date`. */
export function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A valid `YYYY-MM-DD` string, or null for anything else. */
export function asDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = ISO.exec(value);
  if (!m) return null;
  return fromDayNumber(dayNumber(value)) === value ? value : null;
}

/** Days since 1970-01-01, ignoring time zones (dates are calendar days). */
export function dayNumber(iso: string): number {
  const m = ISO.exec(iso);
  if (!m) throw new Error(`not a date: ${iso}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

export function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return fromDayNumber(dayNumber(iso) + n);
}

export function diffDays(a: string, b: string): number {
  return dayNumber(a) - dayNumber(b);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  return (((dayNumber(iso) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

/** The coming Saturday; today, if today is one. */
export function comingSaturday(today: string): string {
  return addDays(today, (6 - weekday(today) + 7) % 7);
}

/** The Sunday that ends the coming weekend. */
export function weekendEnd(today: string): string {
  return addDays(comingSaturday(today), 1);
}

export function mondayAfterWeekend(today: string): string {
  return addDays(comingSaturday(today), 2);
}

/** Which ring a deadline belongs to. No deadline is "later". First match wins. */
export function ringFor(date: string | null, today: string): Ring {
  if (date === null) return "later";
  const d = diffDays(date, today);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (date <= weekendEnd(today)) return "weekend";
  if (d <= MONTH_DAYS) return "month";
  return "later";
}

/**
 * The due date for a drop `t` of the way across the month ring (0 = inner edge,
 * 1 = outer): the Monday after the weekend … 31 days from today, linear between.
 */
export function monthDate(t: number, today: string): string {
  const from = dayNumber(mondayAfterWeekend(today));
  const to = Math.max(from, dayNumber(today) + MONTH_DAYS);
  const clamped = Math.min(1, Math.max(0, t));
  return fromDayNumber(from + Math.round(clamped * (to - from)));
}

export type Drop =
  | { kind: "set"; ring: Ring; date: string }
  | { kind: "pick"; ring: "later"; suggested: string }
  | { kind: "refuse"; ring: "overdue" }
  | { kind: "cancel" };

/** What letting go of a root over `ring` (null = off the board) would do. */
export function dropFor(ring: Ring | null, across: number, today: string): Drop {
  switch (ring) {
    case null: return { kind: "cancel" };
    case "overdue": return { kind: "refuse", ring };
    case "today": return { kind: "set", ring, date: today };
    case "tomorrow": return { kind: "set", ring, date: addDays(today, 1) };
    case "weekend": return { kind: "set", ring, date: comingSaturday(today) };
    case "month": return { kind: "set", ring, date: monthDate(across, today) };
    case "later": return { kind: "pick", ring, suggested: addDays(today, MONTH_DAYS) };
  }
}

/** The label shown by the pointer while dragging a root. */
export function dropLabel(drop: Drop): string {
  switch (drop.kind) {
    case "cancel": return "off the board · cancel";
    case "refuse": return "overdue · can't schedule in the past";
    case "pick": return "later · pick a date";
    case "set": return `${drop.ring} · 📅 ${mmdd(drop.date)}`;
  }
}

export function mmdd(iso: string): string {
  return iso.slice(5);
}
