# Misty dev tasks. `just` lists them.

db := env("MISTY_DB", "data/misty.db")
port := "4322"

default:
    @just --list

# Install Python and web dependencies
setup:
    uv sync
    cd apps/web && npm install

# Build the web app and serve it with the API on :4322
serve: build
    uv run misty serve --db {{db}} --port {{port}}

# Web dev server on :5173 with hot reload (run `just api` alongside it)
dev:
    cd apps/web && npm run dev

# API only, for use with `just dev`
api:
    uv run misty serve --db {{db}} --port {{port}} --web /nonexistent

build:
    cd apps/web && npm run build

# Wipe the database and fill it with random test tasks
fresh n="20":
    uv run misty db seed --db {{db}} --reset -n {{n}}

# Add random test tasks to the existing database
seed n="20":
    uv run misty db seed --db {{db}} -n {{n}}

# Delete the database
reset:
    uv run misty db reset --db {{db}}

# Check that replaying the edit log reproduces the tasks table
verify:
    uv run misty db verify --db {{db}}

# Most recent edits
tail n="20":
    uv run misty db tail --db {{db}} -n {{n}}

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
