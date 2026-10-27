# misty-server (`taskd`)

```sh
uv run misty serve [--db data/misty.db] [--port 4322]   # REST API + built web app
uv run misty db verify | rebuild | tail -n 20
uv run misty import-dartboard <url-or-json> [--force]
```

- `GET /api/tasks[?state=open]`, `GET /api/tasks/{id}/history`, `GET /api/edits?after_seq=`
- `POST /api/commands` `{tool, args, actor_id, correlation_id?, reason?}`: 400 with
  `detail` if rejected

Next: `/mcp` (Streamable HTTP, one tool per edit type), and `/api/stream` (SSE).
