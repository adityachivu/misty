# MCP server: spec and implementation plan

**Status:** agreed and implemented 2026-11-23 · branch `mcp-server`

Agents edit the task database through MCP. The write side is the ten existing edit types
(`misty_core/edits/`); this plan adds a batch wrapper, three read tools, one core rule, and
the two transports.

## Tool surface: 14 tools

### Writes (10, one per existing edit type)

| tool | arguments | rejected when |
|---|---|---|
| `create_task` | `title`, `parent_id?`, `attrs?` | parent missing or discarded; bad attribute |
| `retitle_task` | `task_id`, `title` | title unchanged |
| `set_attributes` | `task_id`, `attrs` | unknown key, bad value, null value, nothing would change |
| `unset_attributes` | `task_id`, `keys` | task has none of those keys |
| `move_task` | `task_id`, `parent_id` (null = top level) | same parent; under itself or a descendant; parent discarded |
| `complete_task` | `task_id` | already done |
| `release_task` | `task_id` | already released |
| `reopen_task` | `task_id` | already open |
| `discard_task` | `task_id` | already discarded; has non-discarded subtasks |
| `undo_edit` | `seq` | no such edit; the task changed since, so a clean undo is impossible |

Every write also takes `reason` (required), `correlation_id?`, and on task tools
`expected_version?`. Every write returns `{seq, task}`.

### Batch (1)

`apply_edits(edits: [{tool, args}], reason, correlation_id?)`

- Runs any of the ten writes in one transaction, all or nothing (at most 100 items).
- In a `task_id` or `parent_id` field, `"$n"` means the task created by item `n` (an
  earlier `create_task`).
- The log records ordinary edits sharing one `correlation_id`. No new edit type.
- A rejection names the failing item and nothing is written.
- Group undo is `list_edits(correlation_id)` followed by one `apply_edits` of `undo_edit`s
  in reverse order.

### Reads (3)

| tool | arguments | returns |
|---|---|---|
| `list_tasks` | `states?` (default `["open"]`), `parent_id?`, `attrs?` (equality), `query?` (substring of title or notes), `limit?` | `head_seq`, `total`, `truncated`, tasks |
| `get_task` | `task_id` | the task, its ancestor path, its direct children |
| `list_edits` | `task_id?`, `correlation_id?`, `after_seq?`, `limit?` | edits with their before/after payloads |

## Rules

- **Actor.** Derived from the MCP client's handshake as `agent:<client name>`. Never a tool
  argument, so an agent can't record edits as the user.
- **Rejections.** `CommandRejected` is returned as a tool error with the message. Nothing
  is written.
- **Attribute discovery.** The `attrs` input schema is generated from the attribute
  registry, so there is no `list_attributes` tool.
- **Parents with open subtasks.**
  - Complete and release are allowed. Every returned task carries `open_children`, so the
    agent sees what it left behind ("tell").
  - Discard is refused while the task has non-discarded subtasks ("refuse"). This is a
    core rule, so it applies to the web UI too, and to undoing a `create_task` once that
    task has gained subtasks.
- **Lineage.** When a task is split, merged, or spawns a follow-up, the link goes in
  `reason`.

## Decisions

| question | decision |
|---|---|
| Lifecycle as four tools or one `set_state` | Four. They match the log, and the descriptions carry release versus discard. |
| `reason` on agent edits | Required over MCP. REST and the UI keep it optional. |
| Proposals (suggest, then approve) | Not in v1. Agents write directly; every write is undoable. |
| Time travel (`state_at`) | Not exposed. |
| Transport | `/mcp` (Streamable HTTP) inside `misty serve`, and `misty mcp` over stdio. |
| Admin operations | CLI only. |
| Sibling ordering | Not needed. |
| Structured lineage links | Not in v1; use `reason`. |
| Composite tools (bulk, merge, split) | None. They are `apply_edits` sequences. |

## Restructuring patterns

| morph | edits |
|---|---|
| Break a task down | `create_task(parent_id=T)` × N |
| Group existing tasks under a new umbrella | `create_task`, then `move_task` × N with `parent_id="$0"` |
| Split one task into two | `retitle_task` + `create_task` as a sibling |
| Merge duplicates | `move_task` the children across, `discard_task` the duplicate |
| Dissolve a parent | `move_task` the children up, then `release_task` or `discard_task` the parent |
| Swap parent and child | `move_task` the child out, then `move_task` the old parent under it |
| Remaining work changed midway | `retitle_task`, add children, `release_task` the ones that no longer apply |

## Implementation

### Step 1: core and store

- `misty_core/view.py`: add `children(task_id)` to `StateView`, `MemoryView`,
  `OverlayView`; `misty_store/projection.py`: the same on `SqliteView`.
- `misty_core/edits/lifecycle.py`: `discard_task` rejects while there are non-discarded
  children. Decide-time only, so replay and `REDUCER_VERSION` are unchanged.
- `misty_store/service.py`: `execute_many` (one transaction, `$n` references, generated
  `correlation_id`; since unified with the drafts' `execute_batch`, which is what remains); `list_tasks` filters; `children`, `ancestors`, `open_child_counts`,
  `find_edits`.
- `misty_store/event_store.py`: `find` (by task, correlation id, `after_seq`, limit).
- `open_children` is counted at read time. It is not stored on `Task`, so the projection
  does not change.

### Step 2: the MCP layer (`apps/server`)

- `misty_server/tools.py` (transport-free): the 14 tool definitions and their dispatch.
  Write schemas come from each edit type's command model plus the envelope; the `attrs`
  schema comes from the attribute registry; descriptions come from the edit docstrings.
- `misty_server/mcp_server.py`: the low-level `mcp` `Server`, server instructions, actor
  derivation, error results, the stdio runner.
- `misty_server/api.py`: mount `/mcp` ahead of the static files, with DNS-rebinding
  protection on.
- `misty_server/cli.py`: `misty mcp` (stdio), with the same breaking-note guard as
  `misty serve`.
- Dependency: `mcp` (2.x) in `apps/server/pyproject.toml` and `uv.lock`.

### Step 3: tests and docs

- Core: the discard rule, including undo of a create that gained subtasks.
- Store: batch atomicity, `$n` references, group undo, read filters, a batch rule in the
  Hypothesis replay machine.
- Server: schema generation, an envelope-versus-command-field collision guard, end-to-end
  calls through the in-process MCP client, REST unaffected by the `/mcp` mount.
- Docs: `README.md`, `apps/server/README.md`, `docs/architecture.md`.
- `just check` passes with `test_compat.py` and its fixtures untouched.

## Compatibility

Additive throughout: no migration, no new edit type, no payload change, no config key, one
new command, one new endpoint, one new dependency that deploy installs. No breaking note.

The one behaviour change is the discard rule (see Rules).

## Not in this round

- `/mcp` answers on loopback host names only. Reaching it from another device needs a
  config key for allowed hosts.
- Proposals, time travel, group undo as a single tool, structured lineage, ordering.
- Reopening a discarded subtask whose parent is still discarded is not rejected, so a
  live task can still end up under a discarded one that way.
