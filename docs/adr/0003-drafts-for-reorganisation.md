# 3. Reorganisations are drafts, translated into edits when they settle

**Status:** accepted · 2026-11-05

## Context
Some changes are *simple*: one gesture is one command (set a date, mark done, add a
subtask). Others are *reorganisations*: merging bubbles, popping a level, pulling a
subtask out. They often take several tries before the user settles on a structure,
through a UI or, later, by chatting with the agent.

Misty will have many experimental UIs with unusual dynamic elements. Each one should not
need to know how its gestures map onto `create_task`/`move_task`/`discard_task`. The
agent is meant to be the layer that understands intent and composes database edits.

## Decision
- **Simple edits stay direct.** A client sends the command to `POST /api/commands`, and it
  is recorded straight away.
- **Reorganisations go into a draft,** stored on the server in a `drafts` table. Drafts are
  not part of the edit log: they are mutable, and they are discarded or applied.
- **A draft describes the change in the client's own vocabulary,** not as task commands:
  - `vocabulary`: one paragraph saying what the client's operations mean.
  - `ops`: the operations in order, referring to tasks by id.
  - `after`: the structure the client intends (each affected task's parent, new nodes
    as `new:<label>`, and the tasks it removes). It is structured data, never prose.
  - `note`: optional free text.
- **A translator turns a settled draft into commands.** This is the agent's job. Until the
  agent exists, a deterministic stand-in (`misty_core.structure.plan`) derives the
  commands from `after` alone. The agent can also post its own commands
  (`POST /api/drafts/{id}/apply`) and take over completely.
- **Applying is atomic and checked.** All of a draft's commands run in one transaction
  (`TaskService.execute_batch`). The resulting tree is then checked against `after`, and
  any mismatch rolls everything back. That check is what makes it safe for a
  non-deterministic translator to write. The edits share `correlation_id = draft id`, so
  they can be found, and undone, together.
- **Drafts settle on the server.** A draft is applied once it has had no changes for
  `settle_ms`. A client holds it (`hold_ms`, a lease it renews) while the user is mid-gesture.
  If the tab closes, the lease runs out and the draft still settles.
- **The UI owns only presentation:** which groups are open, the pop memory, and animation.

## Consequences
- A new UI writes a vocabulary paragraph and an `after` structure. It never learns the
  task commands.
- Only the net change is recorded. Merging, popping and re-merging produces one move, not five.
- The agent can read every open draft as context and rewrite or apply it. Clients
  don't change when it arrives.
- A draft is checked against the state at apply time, not `base_seq`. A simple edit made
  in the meantime is respected. If it makes the intended structure impossible, the draft
  is marked `rejected` with the reason, and nothing is written.
- Task depth is no longer capped by any layer. Views draw whatever depth exists.
