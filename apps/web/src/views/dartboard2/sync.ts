// Talking to the server: commands, the session's undo list, and the reorganisation
// draft with its lease. Knows nothing about rendering: it holds the data, is told about
// state transitions (`setHeld`, `change`), and calls its listener when something the
// view shows has changed.

import type { Draft, DraftClient, Edit, Task } from "../../api";
import { cloneReorg, emptyReorg, isEmptyReorg, type Reorg } from "./model";
import { extrasOf, fromStructure, normalise, sameStructure, toStructure, VOCABULARY } from "./reorg";
import { loadExtras, saveExtras, type Session, type StorageLike } from "./session";

/** The edits the board may make. Everything else goes through a draft. */
export const AFFORDANCES = [
  "create_task", "set_attributes", "unset_attributes", "complete_task", "discard_task", "undo_edit",
] as const;
export type BoardTool = (typeof AFFORDANCES)[number];

/** A released draft is applied this long after its last change. */
export const SETTLE_MS = 6000;
/** How long a lease lasts, and how often it is renewed while something is open. */
export const HOLD_MS = 15000;
export const RENEW_MS = 5000;
export const POLL_MS = 1000;

export interface SyncHost {
  tasks(): Promise<{ head_seq: number; tasks: Task[] }>;
  dispatch(tool: BoardTool, args: Record<string, unknown>, opts?: { correlationId?: string }): Promise<Edit>;
  drafts: DraftClient;
}

export interface SyncListener {
  /** The tasks or the draft laid over them changed: draw again. */
  data(): void;
  /** Only the draft's status line changed. */
  status(): void;
  message(text: string): void;
}

export interface SyncEnv {
  /** A clock that only moves forward, in ms. */
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type DraftPhase = "none" | "holding" | "settling";

export interface Sync {
  tasks(): readonly Task[];
  headSeq(): number;
  /** The reorganisation in progress, laid over the tasks. */
  reorg(): Reorg;
  phase(): DraftPhase;
  /** Whole seconds until a released draft is applied. */
  secondsLeft(): number;
  /** First load: the tasks, and this client's open draft if it has one. */
  start(): Promise<void>;
  refresh(): Promise<void>;
  /** Run one command for this session. Rejects with the server's reason. */
  run(tool: BoardTool, args: Record<string, unknown>): Promise<Edit>;
  /** Undo edits in the order given. */
  undo(seqs: readonly number[], stopAtRejection: boolean): Promise<{ undone: number; error: string | null }>;
  /** Something is open or being dragged (true), or the board is at rest (false). */
  setHeld(held: boolean): void;
  /** The reorganisation changed: `next` replaces it and `op` says what the user did. */
  change(next: Reorg, op: unknown): void;
  applyNow(): void;
  discard(): void;
  /** Resolves when everything sent so far has been answered. */
  idle(): Promise<void>;
  stop(): void;
}

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSync(
  host: SyncHost, session: Session, store: StorageLike, listener: SyncListener, env: SyncEnv,
): Sync {
  let tasks: Task[] = [];
  let headSeq = 0;
  let reorg = emptyReorg();
  let draftId: string | null = null;
  let held = false;
  let appliesAt: number | null = null;
  // Bumped when the server settles the draft: requests queued for it are dropped.
  let epoch = 0;
  let queue: Promise<void> = Promise.resolve();
  let timer: unknown = null;
  let ticks = 0;
  let polling = false;
  let stopped = false;
  let refreshes = 0;

  /** Draft requests go out one at a time, in the order the user made the changes. */
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const mine = epoch;
    queue = queue.then(async () => {
      if (stopped || mine !== epoch) return;
      try {
        await job();
      } catch (e) {
        await recover(e);
      }
    });
    return queue;
  };

  /** A draft request failed. Usually the server settled the draft first: find out. */
  async function recover(error: unknown): Promise<void> {
    if (stopped) return;
    if (draftId) {
      try {
        const { draft, edits } = await host.drafts.get(draftId);
        if (draft.status !== "open") {
          await settled(draft, edits);
          return;
        }
      } catch {
        // Fall through and report the original failure.
      }
    }
    listener.message(`reorganisation not saved: ${text(error)}`);
  }

  function noteLease(d: Draft): void {
    if (held) {
      appliesAt = null;
    } else {
      // The server applies it at max(last change + settle, lease end). Its "now" is
      // the lease it just gave minus the lease length.
      const updated = Date.parse(d.updated_at);
      const lease = d.hold_until ? Date.parse(d.hold_until) : null;
      const serverNow = lease !== null ? lease - SETTLE_MS : updated;
      const due = Math.max(updated + d.settle_ms, lease ?? 0);
      appliesAt = env.now() + Math.max(0, due - serverNow);
    }
    listener.status();
  }

  /** The server applied, rejected or discarded the draft: it is over. */
  async function settled(draft: Draft, edits: Edit[]): Promise<void> {
    if (draft.status === "open") return;
    epoch++;
    draftId = null;
    appliesAt = null;
    reorg = emptyReorg();
    saveExtras(store, null);
    if (draft.status === "applied") {
      for (const e of edits) session.add(e);
      listener.message(
        `reorganisation applied · ${edits.length} edit${edits.length === 1 ? "" : "s"} · ↺ undoes`,
      );
    } else if (draft.status === "rejected") {
      listener.message(`reorganisation not applied: ${draft.error ?? "rejected"}`);
    }
    await refresh();
  }

  async function refresh(): Promise<void> {
    const mine = ++refreshes;
    const data = await host.tasks();
    if (stopped || mine !== refreshes) return;
    tasks = data.tasks;
    headSeq = data.head_seq;
    if (!isEmptyReorg(reorg)) {
      // A task the draft refers to may have gone since: keep the draft appliable.
      const pruned = normalise(tasks, cloneReorg(reorg));
      if (!sameStructure(pruned, reorg)) change(pruned, { op: "prune", why: "tasks changed underneath" });
    }
    listener.data();
  }

  function change(next: Reorg, op: unknown): void {
    reorg = next;
    const empty = isEmptyReorg(next);
    const after = toStructure(next);
    const extras = extrasOf(next);
    void enqueue(async () => {
      if (empty) {
        // The changes cancelled out: there is nothing left to apply.
        const id = draftId;
        draftId = null;
        appliesAt = null;
        saveExtras(store, null);
        if (id) {
          try {
            await host.drafts.discard(id);
          } catch {
            await refresh(); // it was settled before we could discard it
          }
        }
        return;
      }
      if (!draftId) draftId = (await host.drafts.create(VOCABULARY, { settleMs: SETTLE_MS })).id;
      saveExtras(store, draftId, extras);
      noteLease(await host.drafts.update(draftId, {
        append_ops: [op], after, hold_ms: held ? HOLD_MS : SETTLE_MS,
      }));
    });
    listener.status();
  }

  function setHeld(next: boolean): void {
    if (next === held) return;
    held = next;
    appliesAt = null;
    void enqueue(async () => {
      if (!draftId) return;
      noteLease(await host.drafts.update(draftId, { hold_ms: held ? HOLD_MS : SETTLE_MS }));
    });
    listener.status();
  }

  function tick(): void {
    if (stopped || !draftId) return;
    ticks++;
    if (held && ticks % Math.round(RENEW_MS / POLL_MS) === 0) {
      void enqueue(async () => {
        if (draftId && held) noteLease(await host.drafts.update(draftId, { hold_ms: HOLD_MS }));
      });
    }
    if (!polling) {
      polling = true;
      void enqueue(async () => {
        if (!draftId) return;
        const { draft, edits } = await host.drafts.get(draftId);
        await settled(draft, edits);
      }).finally(() => { polling = false; });
    }
    if (!held) listener.status();
  }

  return {
    tasks: () => tasks,
    headSeq: () => headSeq,
    reorg: () => reorg,
    // The overlay, not the server's draft id, says whether a reorganisation is in
    // progress: the id arrives (and goes) a request later.
    phase: () => (isEmptyReorg(reorg) ? "none" : held ? "holding" : "settling"),
    secondsLeft: () =>
      appliesAt === null ? SETTLE_MS / 1000 : Math.max(0, Math.ceil((appliesAt - env.now()) / 1000)),

    async start() {
      const [data, open] = await Promise.all([
        host.tasks(),
        host.drafts.open().catch(() => [] as Draft[]),
      ]);
      if (stopped) return;
      tasks = data.tasks;
      headSeq = data.head_seq;
      const mine = open[open.length - 1];
      if (mine) {
        const laid = fromStructure(mine.after, tasks, loadExtras(store, mine.id));
        draftId = mine.id;
        if (isEmptyReorg(laid)) {
          change(laid, { op: "prune", why: "nothing left to do" });
        } else {
          reorg = laid;
          void enqueue(async () => {
            if (draftId) noteLease(await host.drafts.update(draftId, { hold_ms: held ? HOLD_MS : SETTLE_MS }));
          });
        }
      }
      timer = env.setInterval(tick, POLL_MS);
      listener.data();
    },

    refresh,

    async run(tool, args) {
      const edit = await host.dispatch(tool, args, { correlationId: session.id });
      session.add(edit);
      return edit;
    },

    async undo(seqs, stopAtRejection) {
      let undone = 0;
      let error: string | null = null;
      for (const seq of seqs) {
        try {
          await host.dispatch("undo_edit", { seq }, { correlationId: session.id });
          session.remove(seq);
          undone++;
        } catch (e) {
          error ??= text(e);
          if (stopAtRejection) break;
        }
      }
      return { undone, error };
    },

    setHeld,
    change,

    applyNow() {
      void enqueue(async () => {
        if (!draftId) return;
        const { draft, edits } = await host.drafts.apply(draftId);
        await settled(draft, edits);
      });
    },

    discard() {
      reorg = emptyReorg();
      void enqueue(async () => {
        const id = draftId;
        draftId = null;
        appliesAt = null;
        saveExtras(store, null);
        try {
          if (id) await host.drafts.discard(id);
        } catch {
          // Already settled: the refresh below shows what it did.
        }
        await refresh();
      });
      listener.data();
    },

    idle: () => queue,

    stop() {
      stopped = true;
      if (timer !== null) env.clearInterval(timer);
    },
  };
}
