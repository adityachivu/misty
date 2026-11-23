# Misty tasks. `just` lists them.
#
# Settings come from config/<env>.toml. The env is MISTY_ENV, else `env` in
# config/local.toml, else dev; `just env` shows what this machine resolves to.

default:
    @just --list

# Install Python and web dependencies
setup:
    uv sync
    cd apps/web && npm install

# Show which environment this machine runs, and its settings
env:
    uv run misty config

# Build the web app and serve it with the API
serve: build
    uv run misty serve

# Keep the deploy recipe exactly these two lines. `just` reads it before the pull, so a
# step added here would not run on the deploy that brings it in. New steps go in
# `misty deploy`, which runs from the code that was just pulled.

# On the prod machine: pull main and apply it (backup, build, migrate, verify)
deploy *args:
    git pull --ff-only
    uv run --frozen misty deploy {{args}}

# Copy the database into the backups folder next to it
backup:
    uv run misty db backup

# Web dev server on :5173 with hot reload (run `just api` alongside it)
dev:
    cd apps/web && npm run dev

# API only, for use with `just dev`
api:
    uv run misty serve --web /nonexistent

build:
    cd apps/web && npm run build

# Wipe the database and fill it with random test tasks (dev only)
fresh n="20":
    uv run misty db seed --reset -n {{n}}

# Add random test tasks to the existing database (dev only)
seed n="20":
    uv run misty db seed -n {{n}}

# Delete the database (dev only)
reset:
    uv run misty db reset

# Check that replaying the edit log reproduces the tasks table
verify:
    uv run misty db verify

# Most recent edits
tail n="20":
    uv run misty db tail -n {{n}}

# Lint, type-check, and run every test (Python + browser)
check: lint test e2e

lint:
    uv run ruff check .
    uv run ruff format --check .
    uv run ty check
    cd apps/web && npx tsc --noEmit

test:
    uv run pytest -q

e2e: build
    cd apps/web && npm run test:e2e

fmt:
    uv run ruff format .
    uv run ruff check --fix .
