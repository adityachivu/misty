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
