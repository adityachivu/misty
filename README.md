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
| `apps/server` | `taskd`: REST API, MCP server (`/mcp` and `misty mcp`), and the `misty` CLI. SSE next. | 🚧 |
| `apps/web` | Browser UI: swappable views (Vite + TS). First view: the dartboard. | 🚧 |
| `apps/agent` | Agentic middle layer (Claude Agent SDK), an MCP client of `taskd`. | future |

See [docs/architecture.md](docs/architecture.md) and [docs/adr/](docs/adr/).

## Development

Common tasks are in the `justfile` (`just` lists them):

```sh
just setup      # uv sync + npm install
just env        # which environment this machine runs, and its settings
just fresh      # wipe data/misty.db and seed random test tasks (just fresh 40 for more)
just serve      # build the web app, serve it + the API on http://127.0.0.1:4322
just dev        # hot-reload UI on :5173; run `just api` alongside it
just check      # lint + ty + tsc + pytest + browser tests
just verify     # replay the edit log, compare with the tasks table
just tail       # recent edits
```

## Agents (MCP)

Agents edit tasks through MCP: one tool per edit type, `apply_edits` to make several as
one change, and three reads. There are two ways in, with the same tools and the same
database:

```sh
# a running `just serve` answers at /mcp (Streamable HTTP)
claude mcp add --transport http misty http://127.0.0.1:4322/mcp

# or let the agent launch it over stdio; this also works while the server is running
claude mcp add misty -- uv run --directory /path/to/misty misty mcp
```

An agent's edits are recorded as `agent:<client name>` with the reason it gave, and any
of them can be undone. `/mcp` has no auth and only answers to `localhost` / `127.0.0.1`.
See [apps/server/README.md](apps/server/README.md) for the tools.

## Dev and prod

| | dev | prod |
|---|---|---|
| where | the machine the code is written on | a different machine |
| settings | [`config/dev.toml`](config/dev.toml) | [`config/prod.toml`](config/prod.toml) |
| database | `data/misty.db`, throwaway: `just fresh` any time (stop `just serve` first) | `~/.local/share/misty/misty.db`, the real tasks |
| `db reset`, `db seed` | allowed | refused |
| updated by | editing the code | `just deploy` |

A machine is dev unless it says otherwise. To make one prod, give it a
`config/local.toml` (not committed; see
[`config/local.example.toml`](config/local.example.toml)), which can also override any
setting for that machine. `--env` / `MISTY_ENV`, `--db` / `MISTY_DB`, `--host` /
`MISTY_HOST`, and `--port` / `MISTY_PORT` override the files for one run.

Setting up the prod machine (needs `git`, `uv`, `just`, and Node):

```sh
git clone https://github.com/adityachivu/misty.git && cd misty
echo 'env = "prod"' > config/local.toml
just deploy     # builds, creates the database
just serve
```

Updating it:

```sh
just deploy     # pull main, back up the database, build, migrate, verify
```

`just deploy` copies the database to `backups/` beside it before the new code touches
it, and restarts the server if `restart` is set in `config/local.toml` (otherwise restart
`just serve` by hand). It doesn't delete old backups.

Everything on main is meant to deploy cleanly on top of anything older. A change that
can't is marked with a note in [docs/breaking/](docs/breaking/README.md), and
`just deploy` stops and shows the note instead of applying it.
