# Breaking changes

Prod is a different machine from the one the code is written on. It is updated by
pulling main and running `just deploy`, usually by an agent, with nobody reading the diff.
So main has one rule:

> **Any commit on main can be deployed on top of any earlier commit on main, with no
> manual steps.** A commit that can't promise this adds a numbered note to this folder,
> and `just deploy` stops and shows it before changing anything.

There are no notes yet, which means every commit so far is safe to deploy.

## What counts as compatible

| area | compatible | breaking |
|---|---|---|
| **Edit log** (the real data) | A new numbered migration that only adds (table, index, column with a default). A new edit type. A payload change with a bumped `version` and an upcaster. | Editing a migration that is on main. Dropping or renaming a log table or column. Removing or renaming an edit type without an upcaster. Rewriting stored edits. |
| **Projection** (`tasks`) | Anything: change `projection.DDL` or bump `REDUCER_VERSION` and it is rebuilt from the log on the next start. | — |
| **Config** | A new key with a default in `Settings`. | Renaming or removing a key or a `MISTY_*` variable. Changing what an existing prod value means (the `db` path, the port). |
| **Commands prod runs** | New recipes, commands, and optional flags. | Renaming or removing `just deploy / serve / env / backup` or `misty serve / deploy / config / db verify / db backup`, or adding a required flag to one. |
| **Machine requirements** | Dependencies in `uv.lock` and `package-lock.json`: deploy installs them. | Anything deploy can't install itself: a new system tool, a newer Node, a service to run, a secret to set. |
| **HTTP API** | New endpoints and new response fields. | Removing or renaming an endpoint or field, once something other than the bundled web app calls it. (The web app is built and deployed with the server, so those two always match.) |

Additive migrations matter twice: the old server keeps working while the new code is
being applied, and rolling back the code doesn't need the database rolled back.

The edit log and config rows are enforced by tests, which `just check` runs:

- `packages/misty-store/tests/test_compat.py` opens databases written by earlier commits
  (`tests/compat/*.sql`) with the current code, and pins the hash of every shipped
  migration. If it fails, the change is what's wrong, not the test or the fixture.
- `apps/server/tests/test_config.py` checks that unknown config keys are ignored rather
  than fatal.

The other rows are on whoever makes the change.

## Marking a breaking change

In the same commit, add `docs/breaking/NNNN-short-title.md`, using the next number:

```markdown
# 0001: Short title

**What breaks:** what stops working on a machine that deploys this without doing anything.

**Before deploying:** exact commands, or "nothing".

**After deploying:** exact commands, or "nothing".

**Rolling back:** how to get back to the previous commit, and whether the database
backup has to be restored.
```

Start the commit subject with `BREAKING:` so it stands out in `git log` too.

## What prod sees

Each machine records the highest note it has acknowledged in `deploy.json`, next to its
database. When the checkout contains a newer note:

- `just deploy` prints every unacknowledged note, changes nothing, and exits 1.
- `misty serve` refuses to start, in case someone pulled without deploying.

After reading the notes and doing what they ask, `just deploy --accept-breaking N`
acknowledges notes up to `N` and carries on. A machine being set up for the first time
has nothing to break, so it starts with every existing note acknowledged.
