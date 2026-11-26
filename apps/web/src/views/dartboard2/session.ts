// What this tab has done: a session id sent with every command, and the list of the
// session's edits. Kept in sessionStorage so the halo, the per-bubble undo and
// "reset all" survive a reload. No DOM, no network.

import type { ReorgExtras } from "./reorg";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const KEYS = {
  session: "misty.dartboard2.session",
  showLater: "misty.dartboard2.showLater",
  oneSize: "misty.dartboard2.oneSize",
  reorg: "misty.dartboard2.reorg",
} as const;

export interface SessionEdit {
  seq: number;
  type: string;
  targets: string[];
}

export interface Session {
  /** Sent as every command's correlation id. */
  readonly id: string;
  /** This session's edits that haven't been undone, oldest first. */
  edits(): readonly SessionEdit[];
  add(edit: SessionEdit): void;
  remove(seq: number): void;
  /** Every task one of the session's edits touched. */
  changed(): Set<string>;
  /** The session's edits that touch any of `scope`, newest first. */
  under(scope: ReadonlySet<string>): SessionEdit[];
}

function read<T>(store: StorageLike, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(store: StorageLike, key: string, value: unknown): void {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked: the session still works, it just won't survive a reload.
  }
}

export function openSession(store: StorageLike, newId: () => string): Session {
  const saved = read<{ id?: unknown; edits?: unknown }>(store, KEYS.session);
  const id = typeof saved?.id === "string" && saved.id ? saved.id : newId();
  let edits: SessionEdit[] = Array.isArray(saved?.edits)
    ? (saved.edits as SessionEdit[]).filter(
        e => e && typeof e.seq === "number" && typeof e.type === "string" && Array.isArray(e.targets),
      )
    : [];
  const save = (): void => write(store, KEYS.session, { id, edits });
  save();
  return {
    id,
    edits: () => edits,
    add(edit) {
      if (edits.some(e => e.seq === edit.seq)) return;
      edits = [...edits, { seq: edit.seq, type: edit.type, targets: [...edit.targets] }]
        .sort((a, b) => a.seq - b.seq);
      save();
    },
    remove(seq) {
      edits = edits.filter(e => e.seq !== seq);
      save();
    },
    changed() {
      const out = new Set<string>();
      for (const e of edits) for (const t of e.targets) out.add(t);
      return out;
    },
    under(scope) {
      return edits.filter(e => e.targets.some(t => scope.has(t))).sort((a, b) => b.seq - a.seq);
    },
  };
}

export function readFlag(store: StorageLike, key: string): boolean {
  return read<boolean>(store, key) === true;
}

export function writeFlag(store: StorageLike, key: string, on: boolean): void {
  write(store, key, on ? true : null);
}

/** The presentation a tab keeps for its open draft: sibling order and pop memory. */
export function saveExtras(store: StorageLike, draftId: string | null, extras?: ReorgExtras): void {
  write(store, KEYS.reorg, draftId && extras ? { draftId, extras } : null);
}

export function loadExtras(store: StorageLike, draftId: string): ReorgExtras | null {
  const saved = read<{ draftId?: string; extras?: ReorgExtras }>(store, KEYS.reorg);
  if (!saved || saved.draftId !== draftId || !saved.extras) return null;
  const { anchor, pops, counter } = saved.extras;
  if (!Array.isArray(anchor) || !Array.isArray(pops) || typeof counter !== "number") return null;
  return saved.extras;
}
