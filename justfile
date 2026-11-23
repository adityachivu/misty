# Misty tasks. `just` lists them.
#
# Settings come from config/<env>.toml. The env is MISTY_ENV, else `env` in
# config/local.toml, else dev; `just env` shows what this machine resolves to.

default:
    @just --list

# Install Python and web dependencies
[group('dev')]
setup:
    uv sync
    cd apps/web && npm install

# Show which environment this machine runs, and its settings
[group('dev')]
env:
    uv run misty config

# Build the web app and serve it with the API
[group('dev')]
serve: build
    uv run misty serve

# Keep the deploy recipe exactly these two lines. `just` reads it before the pull, so a
# step added here would not run on the deploy that brings it in. New steps go in
# `misty deploy`, which runs from the code that was just pulled.

# On the prod machine: pull main and apply it (backup, build, migrate, verify)
[group('prod')]
deploy *args:
    git pull --ff-only
    uv run --frozen misty deploy {{args}}

# Copy the database into the backups folder next to it
[group('prod')]
backup:
    uv run misty db backup

# Web dev server on :5173 with hot reload (run `just api` alongside it)
[group('dev')]
dev:
    cd apps/web && npm run dev

# API only, for use with `just dev`
[group('dev')]
api:
    uv run misty serve --web /nonexistent

[group('dev')]
build:
    cd apps/web && npm run build

# Wipe the database and fill it with random test tasks (dev only)
[group('db')]
fresh n="20":
    uv run misty db seed --reset -n {{n}}

# Add random test tasks to the existing database (dev only)
[group('db')]
seed n="20":
    uv run misty db seed -n {{n}}

# Delete the database (dev only)
[group('db')]
reset:
    uv run misty db reset

# Check that replaying the edit log reproduces the tasks table
[group('db')]
verify:
    uv run misty db verify

# Most recent edits
[group('db')]
tail n="20":
    uv run misty db tail -n {{n}}

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
