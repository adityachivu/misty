// Client for the misty server. Shapes mirror the Pydantic models in misty_core;
// TODO: generate these from the server's OpenAPI once there are more of them.

export type TaskState = "open" | "done" | "released" | "discarded";

export interface Task {
  id: string;
  parent_id: string | null;
  title: string;
  state: TaskState;
  attrs: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface Edit {
  seq: number;
  edit_id: string;
  type: string;
  task_id: string | null;
  targets: string[];
  payload: Record<string, unknown>;
  actor: { kind: "user" | "agent" | "system"; id: string };
  occurred_at: string;
  reason: string | null;
  correlation_id: string | null;
  reverts_seq: number | null;
}

/** Every edit the server knows (misty_core.edits.EDIT_TYPES). */
export type Tool =
  | "create_task"
  | "retitle_task"
  | "set_attributes"
  | "unset_attributes"
  | "move_task"
  | "complete_task"
  | "release_task"
  | "reopen_task"
  | "discard_task"
  | "undo_edit";

/** The server refused a command. The message says why, and nothing was written. */
export class CommandRejected extends Error {}

export async function getTasks(): Promise<{ head_seq: number; tasks: Task[] }> {
  const r = await fetch("/api/tasks", { cache: "no-store" });
  if (!r.ok) throw new Error(`GET /api/tasks: ${r.status}`);
  return r.json();
}

export interface CommandOptions {
  actorId: string;
  correlationId?: string;
  reason?: string;
}

export async function runCommand(
  tool: Tool,
  args: Record<string, unknown>,
  opts: CommandOptions,
): Promise<Edit> {
  const r = await fetch("/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tool,
      args,
      actor_id: opts.actorId,
      correlation_id: opts.correlationId ?? null,
      reason: opts.reason ?? null,
    }),
  });
  const body = await r.json();
  if (!r.ok) {
    const detail = body?.detail;
    throw new CommandRejected(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body.edit;
}

// ─── drafts (ADR 0003) ───────────────────────────────────────────────────────
// A reorganisation is not sent as task commands. The client describes it in its own
// vocabulary, plus the structure it intends, and a translator applies it when it
// settles. Mirrors misty_core.structure and misty_store.drafts.

export interface StructureNode {
  /** An existing task id, or `new:<label>` for a task to create. */
  id: string;
  parent: string | null;
  title?: string;
  attrs?: Record<string, unknown>;
}

export interface Structure {
  nodes: StructureNode[];
  /** Existing tasks to discard; they must end up with no subtasks. */
  removed: string[];
}

export type DraftStatus = "open" | "applied" | "rejected" | "discarded";

export interface Draft {
  id: string;
  client: string;
  vocabulary: string;
  note: string | null;
  base_seq: number;
  ops: unknown[];
  after: Structure;
  status: DraftStatus;
  settle_ms: number;
  hold_until: string | null;
  translator: string | null;
  seqs: number[] | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftUpdate {
  append_ops?: unknown[];
  after?: Structure;
  note?: string;
  /** Don't settle for this long; renew it while the user is mid-gesture. */
  hold_ms?: number;
}

async function json<T>(r: Response, what: string): Promise<T> {
  const body = await r.json();
  if (!r.ok) {
    const detail = body?.detail;
    throw new CommandRejected(`${what}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return body;
}

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export interface DraftClient {
  create(vocabulary: string, opts?: { note?: string; settleMs?: number }): Promise<Draft>;
  update(id: string, update: DraftUpdate): Promise<Draft>;
  get(id: string): Promise<{ draft: Draft; edits: Edit[] }>;
  /** This client's open drafts. */
  open(): Promise<Draft[]>;
  apply(id: string): Promise<{ draft: Draft; edits: Edit[] }>;
  discard(id: string): Promise<Draft>;
}

export function draftClient(client: string): DraftClient {
  return {
    async create(vocabulary, opts = {}) {
      const r = await send("POST", "/api/drafts", {
        client, vocabulary, note: opts.note ?? null, settle_ms: opts.settleMs,
      });
      return (await json<{ draft: Draft }>(r, "create draft")).draft;
    },
    async update(id, update) {
      return (await json<{ draft: Draft }>(await send("PATCH", `/api/drafts/${id}`, update), "update draft")).draft;
    },
    async get(id) {
      return json(await send("GET", `/api/drafts/${id}`), "read draft");
    },
    async open() {
      const all = await json<Draft[]>(await send("GET", "/api/drafts?status=open"), "list drafts");
      return all.filter(d => d.client === client);
    },
    async apply(id) {
      return json(await send("POST", `/api/drafts/${id}/apply`, {}), "apply draft");
    },
    async discard(id) {
      return (await json<{ draft: Draft }>(await send("POST", `/api/drafts/${id}/discard`), "discard draft")).draft;
    },
  };
}
