import type { Task, TaskState } from "../../src/api.ts";
import type { StorageLike } from "../../src/views/dartboard2/session.ts";

let clock = 0;

/** A task with a creation time that follows the order tasks are made in. */
export function task(
  id: string,
  opts: { parent?: string | null; title?: string; state?: TaskState; attrs?: Record<string, unknown> } = {},
): Task {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
  return {
    id,
    parent_id: opts.parent ?? null,
    title: opts.title ?? id,
    state: opts.state ?? "open",
    attrs: opts.attrs ?? {},
    created_at: at,
    updated_at: at,
    version: 1,
  };
}

export const TODAY = "2026-07-15"; // a Wednesday

/** Every character is 6 wide. */
export const measure = (text: string): number => [...text].length * 6;

/** sessionStorage, in memory. */
export function memoryStore(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: k => void data.delete(k),
  };
}
