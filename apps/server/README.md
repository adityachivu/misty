# misty-server (`taskd`)

```sh
uv run misty config                                    # this machine's environment and settings
uv run misty serve [--db FILE] [--host H] [--port N]    # REST API + /mcp + built web app
uv run misty mcp [--db FILE]                           # the MCP tools over stdio
uv run misty db verify | rebuild | backup | tail -n 20
uv run misty db seed | reset                           # dev only
uv run misty deploy [--accept-breaking N]              # prod: apply the checked-out code
uv run misty import-dartboard <url-or-json> [--force]
```

Settings come from `config/<env>.toml` (`misty --env prod ...`, or `MISTY_ENV`); see the
top-level README.

- `GET /api/tasks[?state=open]`, `GET /api/tasks/{id}/history`, `GET /api/edits?after_seq=`
- `POST /api/commands` `{tool, args, actor_id, correlation_id?, reason?}`: 400 with
  `detail` if rejected

## MCP

`/mcp` (Streamable HTTP, inside `misty serve`) and `misty mcp` (stdio) serve the same 14
tools. They are defined in `src/misty_server/tools.py`; `mcp_server.py` only puts them
behind the protocol.

| tool | what it does |
|---|---|
| `create_task`, `retitle_task`, `set_attributes`, `unset_attributes`, `move_task`, `complete_task`, `release_task`, `reopen_task`, `discard_task`, `undo_edit` | One per edit type, generated from `misty_core.edits.EDIT_TYPES`. Returns `{seq, task}`. |
| `apply_edits` | Several of the above as one transaction: all recorded, or none. `"$n"` in a `task_id` or `parent_id` is the task created by item `n`. |
| `list_tasks` | Filter by `states` (default open), `parent_id`, `attrs`, `query`; `limit`. |
| `get_task` | One task, the tasks above it, and its direct subtasks. |
| `list_edits` | History, filtered by `task_id`, `correlation_id`, `after_seq`; `limit`. |

- Every write takes a required `reason` and an optional `correlation_id`.
- The actor is `agent:<client name>`, taken from the MCP handshake. It is not an argument.
- A rejected edit comes back as a tool error with the message, and writes nothing.
- The `attrs` schema is generated from the attribute registry, so registering an attribute
  is enough for agents to see it.
- Every returned task carries `open_children`, so closing a parent shows what is left
  under it.
- `/mcp` has no auth. It answers only when addressed as `localhost` or `127.0.0.1`,
  whatever `host` is set to.

Next: `/api/stream` (SSE).
