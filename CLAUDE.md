# Misty: notes for Claude

## There are two environments

- **dev**: throwaway test data in `data/misty.db`. The default on any machine.
- **prod**: a different machine holding the real tasks. It is marked by
  `env = "prod"` in its `config/local.toml` (not committed).

Run `just env` if you are not sure which one this machine is. Settings live in
`config/dev.toml` and `config/prod.toml`; see the README.

On prod: don't develop, don't edit the database by hand, and don't try to get around the
refusals from `misty db reset` / `misty db seed`. Code reaches prod only through main.

## Changing code (dev)

Everything merged to main is deployed to prod with `just deploy`, with nobody reading the
diff. Keep every change backwards compatible. The rules are in
[docs/breaking/README.md](docs/breaking/README.md); the ones that come up most:

- Never edit a migration that is on main. Add the next numbered one, and only add to
  the log schema.
- To change an edit's payload, bump its `version` and register an upcaster.
- New config keys get a default. Don't rename or remove keys, `MISTY_*` variables, or the
  `just` recipes and `misty` commands prod runs.
- Put new deploy steps in `misty deploy`, never in the `deploy` recipe in the justfile.

Run `just check` before committing. If `test_compat.py` fails, the change would break
prod's data: fix the change, not the test or its fixtures.

If a change can't be made compatible, say so to the user, and add a note in
`docs/breaking/` in the same commit so that deploy stops and shows it.

## "Pull the latest changes and apply them" (prod)

1. `just env` must say `prod`. If it says `dev`, stop and ask.
2. `just deploy`. It pulls main, backs up the database, builds, migrates, and verifies.
3. If it stops with **BREAKING** notes, nothing was changed. Show the notes to the user
   and wait for their go-ahead before doing the steps and running
   `just deploy --accept-breaking N`. Never pass that flag just to get unstuck.
4. If it says **FAILED**, report the output. Don't restart the server, and don't restore
   a backup without asking.
5. If it finishes without a restart command configured, restart the server the way the
   user runs it on that machine.
