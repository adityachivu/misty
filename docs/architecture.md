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

The server applies settled drafts itself (a loop in `create_app`), so a closed tab never
strands one.

## Processes (planned)

- **`taskd`** (`apps/server`): the only process that serves the DB. `/mcp` (Streamable
  HTTP), `/api/*` REST reads, `POST /api/commands` (the UI write path), `/api/stream` (SSE),
  and `?as_of_seq=N` time travel. A stdio MCP entry point shares the same DB file
  (WAL + `BEGIN IMMEDIATE`).
- **web** (`apps/web`): each visualisation declares which edit types it may dispatch.
  Types are generated from FastAPI's OpenAPI.
- **agent** (`apps/agent`): an MCP client of `taskd`, never touches SQLite. Suggested
  edits awaiting approval live in `drafts`, not the log: the agent reads open drafts as
  context, can rewrite them, and applies them with its own composed commands.
