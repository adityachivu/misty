# 2. Python backend, TypeScript frontend, local SQLite

**Status:** accepted · 2026-10-26

## Decision
- Backend in Python 3.14 as a uv workspace: Pydantic v2 models, stdlib `sqlite3` (no ORM),
  the official `mcp` SDK, FastAPI. Agent layer later in Python with the Claude Agent SDK.
- Frontend in TypeScript (Vite + React), with types generated from FastAPI's OpenAPI, so
  Python stays the single source of truth for edit and task shapes.
- Local-only on one Mac: one SQLite file (WAL), one long-running server process.

## Consequences
- The reducer exists only in Python. Time-travel views use a server endpoint
  (`as_of_seq`) instead of replaying in the browser.
- Moving to multiple devices later means Litestream/libSQL or a hosted server. The schema
  is unaffected.
