# Misty dev tasks. `just` lists them.

db := env("MISTY_DB", "data/misty.db")
port := "4322"

default:
    @just --list

# Install Python and web dependencies
[group('dev')]
setup:
    uv sync
    cd apps/web && npm install

# Build the web app and serve it with the API on :4322
[group('dev')]
serve: build
    uv run misty serve --db {{db}} --port {{port}}

# Web dev server on :5173 with hot reload (run `just api` alongside it)
[group('dev')]
dev:
    cd apps/web && npm run dev

# API only, for use with `just dev`
[group('dev')]
api:
    uv run misty serve --db {{db}} --port {{port}} --web /nonexistent

[group('dev')]
build:
    cd apps/web && npm run build

# Wipe the database and fill it with random test tasks
[group('db')]
fresh n="20":
    uv run misty db seed --db {{db}} --reset -n {{n}}

# Add random test tasks to the existing database
[group('db')]
seed n="20":
    uv run misty db seed --db {{db}} -n {{n}}

# Delete the database
[group('db')]
reset:
    uv run misty db reset --db {{db}}

# Check that replaying the edit log reproduces the tasks table
[group('db')]
verify:
    uv run misty db verify --db {{db}}

# Most recent edits
[group('db')]
tail n="20":
    uv run misty db tail --db {{db}} -n {{n}}

# Lint, type-check, and run every test (Python + browser)
[group('quality')]
check: lint test e2e

[group('quality')]
lint:
    uv run ruff check .
    uv run ruff format --check .
    uv run ty check
    cd apps/web && npx tsc --noEmit

[group('quality')]
test:
    uv run pytest -q

[group('quality')]
e2e: build
    cd apps/web && npm run test:e2e

[group('quality')]
fmt:
    uv run ruff format .
    uv run ruff check --fix .

# Start a branch off an up-to-date main (carries uncommitted changes along)
[group('repo')]
branch name:
    git switch main
    git pull --ff-only
    git switch -c {{name}}

# Rebase the current branch onto the latest origin/main
[group('repo')]
sync:
    git fetch origin
    git rebase origin/main

# Push the current branch and track it on origin
[group('repo')]
push:
    git push -u origin HEAD

# Run every check, then push
[group('repo')]
ship: check push

# Open a pull request for the current branch on GitHub
[group('repo')]
pr:
    open "$(git remote get-url origin | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')/compare/main...$(git branch --show-current)?expand=1"

# After a merge: back to an up-to-date main and delete the finished branch
[group('repo')]
done:
    #!/usr/bin/env sh
    set -eu
    branch=$(git branch --show-current)
    if [ "$branch" = main ]; then echo "already on main"; exit 1; fi
    git switch main
    git pull --ff-only
    git branch -d "$branch"

# Delete local branches already merged into main
[group('repo')]
tidy:
    git branch --merged main | grep -vE '^\*|^\s*main$' | xargs -r git branch -d

# Recent history as a graph
[group('repo')]
log n="20":
    git log --oneline --graph --decorate -{{n}}
