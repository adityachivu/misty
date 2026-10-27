# misty

A personal task companion built around the **cognitive and somatic** barriers to getting
things done (starting friction, dread, energy, body state, time blindness), not around
project structure. One task database, an MCP server so agents can edit it, and many
swappable visualisations, each suited to a different way of relating to tasks.

## Layout

| path | what | status |
|---|---|---|
| `packages/misty-core` | Pure domain: `Task`, edit types, the reducer. No IO. | ✅ |
| `packages/misty-store` | SQLite: append-only edit log, rebuildable `tasks` projection, `TaskService`. | ✅ |
| `apps/server` | `taskd`: REST API + `misty` CLI (serve, db verify/rebuild/tail, import). MCP + SSE next. | 🚧 |
| `apps/web` | Browser UI: swappable views (Vite + TS). First view: the dartboard. | 🚧 |
| `apps/agent` | Agentic middle layer (Claude Agent SDK), an MCP client of `taskd`. | future |

See [docs/architecture.md](docs/architecture.md) and [docs/adr/](docs/adr/).

## Development

Common tasks are in the `justfile` (`just` lists them):

```sh
just setup      # uv sync + npm install
just fresh      # wipe data/misty.db and seed random test tasks (just fresh 40 for more)
just serve      # build the web app, serve it + the API on http://127.0.0.1:4322
just dev        # hot-reload UI on :5173; run `just api` alongside it
just check      # lint + ty + tsc + pytest + browser tests
just verify     # replay the edit log, compare with the tasks table
just tail       # recent edits
```

The database is disposable test data for now: `just fresh` any time (stop `just serve` first).
