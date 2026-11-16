# Progress and ideas

A living log: what's done, what's next, known problems, and ideas not yet scheduled.
Design decisions themselves go in `docs/adr/`. This file is for everything around them.

_Last updated: 2026-11-16 · branch `bubble-drafts`_

## Done

### Reorganisation drafts (ADR 0003)
- **Two ways to write.** Simple edits (date, ⚡, ✓, add a subtask) go straight to
  `POST /api/commands`. Reorganisations (merge, pop, pull out) become a **draft**.
- **What a draft holds.** The client describes the change in its own vocabulary (`ops`),
  plus the structure it intends (`after`), so a UI never needs to know the task commands.
- **Applying a draft:**
  - `TaskService.execute_batch` runs the commands in one transaction, then checks the
    result against `after`. Any mismatch rolls everything back.
  - The edits share `correlation_id = draft id`.
- **Settling.** The server applies a draft after `settle_ms` of quiet. While the user is
  mid-gesture, the client holds a lease (`hold_ms`) so it won't settle.
- **Translation.** A deterministic stand-in (`misty_core.structure.plan`) turns drafts into
  commands until the agent exists. The agent will post its own commands to
  `POST /api/drafts/{id}/apply` instead.

### Dartboard: bubble merge and pop (`apps/web/src/views/dartboard/reorg.ts`)
- **Drag a subtask:**
  - onto another subtask: they merge into a new group task ("target + dragged");
  - into an open bubble: it becomes a subtask there;
  - onto empty board: it becomes a root, keeping its old root's category and section.
- **Merges stay within one root task.**
- **Pop.** Clicking an open subtask's empty space pops that level. **Collapse** brings back
  any pops whose parts haven't been moved since.
- **When it applies.** Nothing is written while a bubble is open. The draft applies 6s after
  the board is closed, or immediately with "apply now", and "discard" drops it.
- **Depth.** The 3-level cap is gone. It had been silently hiding deeper tasks.

### Dartboard: physics and drag-to-reschedule
- **Jitter fixed.** The physics now cools (as in d3-force), so the board always comes to
  rest. On real data: 14 of 20 roots used to jitter forever after being opened; now all
  rest within about 2.3s.
  - The open bubble holds still, and speed is capped.
  - A bubble swimming home (dropped, or its band changed) keeps the board warm until it
    arrives, for at most 8s. Neighbours it bumps, and those pushed aside by an open
    bubble, swim home too.
- **Drag to reschedule.** Drag a closed root onto a ring:
  - today, tomorrow and weekend set the same dates as the buttons;
  - the month ring maps distance from the centre to a day;
  - the rim opens ⏳'s date picker;
  - the overdue ring refuses.
- **After the drop,** the bubble swims back to its own wedge, and a label shows the date
  while dragging.

## Next

### Task B: merge root bubbles within a quadrant
- **Gesture:** drop a root onto another root in the same category to merge them. A drop
  anywhere else reschedules.
- **Result:** a new root task in that category, with both roots as subtasks. Popping it
  makes them roots again, and they keep their own dates.
- **Placing a group:** by the **earliest date of any open task inside it**, worked out by the
  view and never stored. Otherwise a deadline hidden inside a group disappears from the
  board. The same rule would also apply to existing roots with dated subtasks.

### Overdue ring can't hold its bubbles
The ring is 70px across and each bubble is 96px wide, so more than one or two overdue
bubbles sit outside their place. They no longer jitter, but they cluster.
- **Proposal:** let the overdue ring grow with how many bubbles it holds (preferred, since
  overdue is what most needs seeing).
- **Alternative:** shrink overdue bubbles.

## Known problems and rough edges
- **Small targets.** At the default zoom, subtasks are 14–29px on screen, so dragging them
  is fiddly. Ideas: zoom in on an open bubble automatically, and give subtasks a grab
  cursor and a slight lift on hover.
- **Pop discards the popped task** even if the user wrote it (its subtasks move up first;
  ↺ undoes it). An option is to allow popping only merge-created groups.
- **Placeholder titles.** Merged groups are titled "A + B" until the agent can name them.
- **No sibling order.** Tasks have no order field, so children come back in creation order.
- **Simpler motion than the spec.** Bubbles animate between snapshots taken before and
  after each change, rather than keeping one element per node. During a drag, the target
  only highlights; the merged result isn't previewed.
- **Polling.** The board checks its draft once a second. Moving to `/api/stream` (SSE,
  planned) would make that instant.
- **Conflict checks run at apply time.** A draft is checked against the tasks as they are
  when it's applied, not `base_seq`. A conflicting simple edit made in the meantime
  rejects the draft with a reason, rather than being merged into it.
- **Unexplained once.** Early on, one e2e run showed a draft "applied" with no edits. A
  timing fix followed, and it hasn't been reproduced since. Watch for it.
- **Browsers.** Only Chromium has been tested; Safari hasn't.

## Ideas (unscheduled)
- **The agent as translator:** MCP tools to list and read open drafts, rewrite them, and
  apply them with composed commands. It would name groups properly, decide pop semantics,
  and reconcile drafts from several clients.
- **Drag across wedges to change category.** Today the bubble swims back. This was
  deliberately deferred.
- **Draft history view:** what each draft asked for vs. what was applied, linked by
  `correlation_id`.
- **Generate TS types from FastAPI's OpenAPI.** `api.ts` mirrors the Python models by hand.
- **Time travel on the board** via `?as_of_seq=N`.
- **Settle feedback:** a subtle countdown ring on the board instead of HUD text.
