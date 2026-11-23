# Architecture

## The log is the truth; the table is disposable

```
command (MCP tool call / UI gesture)
   │  decide(cmd, state)        ← validation; may raise CommandRejected
   ▼
edit (resolved fact)            ← ids, timestamps, before/after values all fixed here
   │  BEGIN IMMEDIATE
   │    INSERT task_edits       ← append-only, triggers forbid UPDATE/DELETE
   │    UPSERT tasks            ← apply(edit, state): the same reducer replay uses
   │  COMMIT
```

- **Command vs edit.** Commands can be rejected; only accepted edits are recorded, and
  a recorded edit always applies. So replaying `task_edits` always rebuilds `tasks`.
- **The projection is never migrated.** `misty_store.projection.DDL` plus
  `REDUCER_VERSION` form a fingerprint. When either changes, the next startup drops
  `tasks` and replays the log.
- **The log changes slowly.** To change an edit's payload, bump its `version` and add an
  upcaster (`misty_core/upcasters.py`). Stored rows are never rewritten.

### Rules that keep replay correct
1. `apply()` is pure: no clock, no randomness, no IO.
2. Non-determinism is resolved at decide time and stored in the payload (`EditContext`).
3. The live path and replay share one `apply()`.
4. Appending the edit and updating the projection happen in one transaction.
5. `expected_version` on task commands gives optimistic concurrency between agent and UI.
6. Changes record `before`/`after`, so undo and history views need nothing else.
7. Undo (`undo_edit`) records compensating edits, resolved through the normal decide
   path. It is rejected on conflict, and an undo can itself be undone.
8. `TaskService.verify()` replays in memory and diffs against the projection. A
   Hypothesis state machine checks this after every step of random command sequences.
9. A batch (`TaskService.execute_batch`) is several ordinary edits appended in one
   transaction. The log has no notion of a batch beyond their shared `correlation_id`.
   Applying a draft and the MCP tool `apply_edits` are both batches.

## Schema

**`task_edits`** (stable contract): `seq`, `edit_id` (UUIDv7), `type`, `type_version`,
`task_id`, `payload` (JSON), `actor_kind`/`actor_id`, `correlation_id`, `reason`,
`reverts_seq`, `occurred_at`. **`task_edit_targets`** indexes every task an edit touches.

**`tasks`** (projection): `id`, `parent_id`, `title`, `state`, `attrs` (JSON), `created_at`,
`updated_at`, `version`, `last_seq`. Lifecycle values are validated in Pydantic, not by
SQL CHECKs.

## Changing the schema

| change | what to do |
|---|---|
| New cognitive/somatic dimension | `register(AttributeSpec(...))` in `attributes.py`, or use an `x_` key to experiment |
| Query an attribute fast | Add a generated column + index to `projection.DDL` (rebuild is automatic) |
| New kind of edit | `EditType` subclass in `misty_core/edits/`, add it to `EDIT_TYPES` |
| Change an edit's payload | Bump `version`, register an upcaster |
| Change what `apply` computes | Bump `REDUCER_VERSION` |

## Edit types (= MCP tools)

`create_task`, `retitle_task`, `set_attributes`, `unset_attributes`, `move_task`,
`complete_task`, `release_task`, `reopen_task`, `discard_task`, `undo_edit`.

Lifecycle is not a workflow: any state can move to any other. `released` means "let go
on purpose" and is a legitimate outcome. `discarded` means "captured by mistake" and is
hidden from views. Nothing is ever hard-deleted.

Two rules tie lifecycle to the tree, so that live tasks don't end up hidden under a
discarded one: creating or moving a task under a discarded parent is rejected, and so is
discarding a task that still has subtasks that aren't discarded. (Reopening a discarded
subtask of a discarded parent is not rejected yet.) Completing or releasing a parent is
always allowed and leaves its subtasks alone.

## MCP tools

Agents get the ten edits above, plus (`apps/server/src/misty_server/tools.py`):

- `apply_edits`: a batch of edits, all or nothing. Restructuring (break down, group,
  split, merge, dissolve a parent) is a batch, not a set of edit types of its own. `"$n"`
  refers to the task created by item `n`. Undoing a batch is another batch: its
  `undo_edit`s, newest first.
- `list_tasks`, `get_task`, `list_edits`: reads. Tasks are returned with `open_children`,
  which is counted on read and is not part of the projection.

Writes over MCP must give a `reason`. The actor is `agent:<client name>` from the
handshake, never an argument. Where a task came from (split from, merged into, follow-up
of) is recorded in `reason`; there is no structured link.

## Reorganisations are drafts (ADR 0003)

Simple edits go straight to `POST /api/commands`. Reorganisations (merge, pop, pull out)
go into a **draft** in the `drafts` table, which is mutable working state and not part of
the log. A client describes the draft in its own vocabulary (`vocabulary`, `ops`) and
gives the structure it intends (`after`: each affected task's parent, new tasks as
`new:<label>`, and the tasks it removes).

```
client ──PATCH /api/drafts/{id}──▶ drafts (open, settling)
                                     │ quiet for settle_ms and no hold lease
                                     ▼
             translator: agent (POST …/apply with steps) or stand-in (structure.plan)
                                     │ TaskService.execute_batch: one transaction
                                     ▼ checked against `after`, else rolled back
                    ordinary edits, correlation_id = draft id
```

In a batch, a step refers to a task an earlier step created either by position (`"$n"`,
what `apply_edits` documents) or by the name the step gave it (`new:<label>`, what a
draft's `after` uses, so the result can be checked against it).

The server applies settled drafts itself (a loop in `create_app`), so a closed tab never
strands one.

## Processes

- **`taskd`** (`apps/server`): the only process that serves the DB. `/api/*` REST reads,
  `POST /api/commands` (the UI write path), `/api/drafts` (reorganisations, settled by a
  loop in this process), and `/mcp` (Streamable HTTP). `misty mcp`
  serves the same tools over stdio from its own process, sharing the DB file (WAL +
  `BEGIN IMMEDIATE`). Planned: `/api/stream` (SSE) and `?as_of_seq=N` time travel.
- **web** (`apps/web`): each visualisation declares which edit types it may dispatch.
  Types are generated from FastAPI's OpenAPI.
- **agent** (`apps/agent`): an MCP client of `taskd`, never touches SQLite. Suggested
  edits awaiting approval live in `drafts`, not the log: the agent reads open drafts as
  context, can rewrite them, and applies them with its own composed commands.
