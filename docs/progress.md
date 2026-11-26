# Progress and ideas

A living log: what's done, what's next, known problems, and ideas not yet scheduled.
Design decisions themselves go in `docs/adr/`. This file is for everything around them.

_Last updated: 2026-11-26 · branch `main`_

## Done

### Dartboard: discard, controls on the rim, titles that fit, and size by subtasks
- **✕ discards a task** from its open bubble, along with everything under it (deepest
  first: the server refuses to discard a task that still has subtasks). The list comes
  from the database, so released subtasks, which aren't drawn, go too.
  - The message that follows has an **undo** button for 8s. After that, ↺ on the bubble
    it was in restores it (a parent now carries the halo for what was discarded under
    it), or "reset all". A discarded root has no parent bubble, so for it it's the
    message or "reset all".
  - It is several edits, not one batch: the web API has no batch endpoint. If one is
    refused part-way, the ones before it stand, and are undoable.
  - Refused for a task the open reorganisation touches, until that is applied or discarded.
- **Controls sit on the rim of an open bubble:** ⚡ ✓ ✕ (and ↺) along the bottom arc, and
  the ＋ at the top, opposite them. The name and the subtasks have the middle. The ＋ no
  longer sits among the subtasks; pressing it still puts the bubble to be named there.
- **Titles are broken to fit the circle** (`breakTitle` in `board.ts`). CSS wrapped to a
  box, so long titles crossed the rim and words were split to fill it. Now each line is as
  wide as the circle is at its height, words stay whole, the fewest lines that hold the
  title are used (up to 4 closed, 3 open), and the rest ends in an ellipsis.
- **Prototype: a closed bubble grows with its open subtasks,** at any depth. Area grows
  with the count, a quarter of the base area per subtask, capped at 1.7× the base
  diameter (96 → 163px for a root, reached at 8). Done subtasks don't count. `S` switches
  it off and on for the tab. To decide: keep it, the curve and the cap, and whether to
  count open subtasks (what is left) or all of them.
- View only: no new edit types, API or migration. The board now uses `discard_task`.

### Dartboard: the short view, and deadlines from subtasks
- **Short view by default.** Only roots due by the end of the coming weekend are drawn.
  The month and later rings (so undated and scheduled tasks too) are hidden until "show
  later" or `L`. The button says how many there are. The choice is kept per tab.
  - A later task that is open, changed this session, or moved by the draft stays on the
    board, faded: ↺ has to be able to reach it, and a new root starts undated.
  - Hidden bubbles stay in the simulation, so the toggle never moves anything.
  - The rings themselves are still drawn, so a task can be dragged out to them.
- **A root sits at its earliest open deadline:** its own due date, or a subtask's at any
  depth if that is sooner. Before, only the root's own date counted. Done subtasks and
  scheduled dates don't count. An open root's meta says "subtask due MM-DD" when that is
  what places it, and dropping it on a later ring sets its date but says why it stays.
- **The weekend ring runs to the end of Sunday** (it stopped at Saturday, so a Sunday
  task sat in the month ring). Dropping on it still means Saturday; the month ring now
  starts on the Monday.
- View only: no new edits, API or migration.

### Dartboard: fewer controls, and ＋ makes the bubble you name
- **Why.** Once roots could be dragged to a ring, the four date buttons (☀️ ➡️ 📅 ⏳) said
  nothing a drag doesn't. The "break it down…" text box sat in every open bubble whether or
  not anything was being added.
- **Controls.** An open bubble now has ⚡ and ✓, plus ↺ once something under it has changed.
  They are small circles, and ⚡ is grey until it is on.
- **Dates** are set only by dragging a root to a ring. The rim still opens the inline date
  picker (a scheduled date).
- **Adding a subtask.** A dashed ＋ sits after an open bubble's subtasks, at every open
  level. Pressing it (or the `+` key) turns it into a bubble with a text box where the
  title will be:
  - ↵ creates the subtask, which shrinks into place from the bubble it was typed in, and
    an empty bubble is ready for the next one;
  - esc throws it away (a second esc backs out of the parent, as before);
  - clicking or dragging anything else keeps what was typed. A click on the parent's own
    space only does that: it doesn't also close or pop the parent.
- **Smaller open bubbles,** since they hold less: 300 / 210 / 156 at rest, was 340 / 230 / 165.
- **Nothing else changed.** Same edits (`create_task`, `set_attributes`, …), same API, no
  migration. The top-right "+ add" panel for new root tasks is as it was: a root needs a
  category, and there is no gesture for that yet (see "Drag across wedges" below).

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
  - today, tomorrow and weekend set a due date;
  - the month ring maps distance from the centre to a day;
  - the rim opens the date picker (a scheduled date);
  - the overdue ring refuses.
- **After the drop,** the bubble swims back to its own wedge, and a label shows the date
  while dragging.

### Brought up to date with main (MCP server, dev/prod split)
- **One batch path.** Applying a draft and the MCP tool `apply_edits` both run
  `TaskService.execute_batch`. A step refers to a task created earlier by position
  (`"$n"`) or by name (`new:<label>`).
- **Pop and the discard rule.** `discard_task` now refuses a task that still has subtasks
  that aren't discarded. Popping a level therefore moves its released subtasks up too
  (they aren't drawn, but they are still its subtasks).
- **Sturdier settling.** The settle loop survives a failed pass, and one draft failing
  doesn't hold up the others.
- **Quieter and safer dragging.** The lease is renewed every 5s, not every second. A drag
  that ends without a pointer-up (touch scroll, button let go outside the window, window
  loses focus) is cancelled instead of freezing the board.
- **Readable history.** A draft's edits are recorded with the reason "Reorganised in
  web:dartboard", not the draft's id (that is already their `correlation_id`).
- **Compat.** `002_drafts.sql` is registered as shipped, and fixture `0002-drafts` holds a
  draft in every status, so later changes are checked against stored drafts.

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
- **Bigger bubbles overhang narrow rings.** With size by subtasks, a 163px bubble in the
  85px tomorrow ring reaches well into its neighbours. Its centre is still in its ring.
- **A dropped bubble occasionally doesn't make it home.** In the e2e test, a root dragged
  to the far side of the today ring failed to reach its own wedge within the 8s it is
  given, twice in about 30 runs (never in 8 runs before this change). Usually it takes
  0.3–3.5s, so it is getting stuck behind something, not running slow. Not understood.
- **Two e2e failures that were not reproduced.** While the ＋ was still among the
  subtasks, two runs failed in the reorganising steps: once Collapse had nothing to
  restore after a merge, once a draft was still open 15s after the board closed. Neither
  has appeared in 8 runs since the controls moved to the rim, but the cause was never
  found, so they may come back.
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
- **Two tabs share a draft.** A board adopts its client's most recent open draft at boot,
  so two tabs (or two devices) reorganising at once overwrite each other's structure.
- **Agents can't see drafts.** An agent editing over MCP doesn't know a reorganisation is
  settling. Its edit is respected, and if it makes the draft impossible the draft is
  rejected with the reason, but nothing warns the agent first.
- **Agent-composed steps are recorded as the user.** `POST /api/drafts/{id}/apply` with
  `steps` records the edits as `user:<draft client>`. An MCP tool for this should pass
  the agent as the actor (`DraftService.apply(actor=...)` already takes one).
- **The e2e suite needs the machine awake.** It waits on real time (a 6s settle), so a
  run during a sleep cycle fails the settle checks.

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
