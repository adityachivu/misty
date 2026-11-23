# misty-server (`taskd`)

```sh
uv run misty config                                    # this machine's environment and settings
uv run misty serve [--db FILE] [--host H] [--port N]    # REST API + built web app
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

Next: `/mcp` (Streamable HTTP, one tool per edit type), and `/api/stream` (SSE).
