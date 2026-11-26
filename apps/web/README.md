# misty-web

Vite + TypeScript. Each view is a module (`src/views/<id>/`) that declares its
*affordances*, the edit types it may dispatch. `main.ts` hands it a context whose
`dispatch` refuses anything else. All writes go through `POST /api/commands`, the
same path agent tools will use. Pick a view with `?view=<id>`.

## Views

- **dartboard** (`src/views/dartboard/`): ported from `~/code/dartboard`. Quadrant =
  `category`, ring = `date`/`date_kind`, ⚡ = `quick`. Gestures are recorded edits,
  attributed to `web:dartboard` and tagged with a per-tab session id. The yellow halo
  means "changed this session". ↺ and reset all record `undo_edit`s.
  An open bubble has its name and subtasks in the middle and its controls on the rim.
  Along the bottom: ⚡, ✓ and ✕ (plus ↺ once something under it has changed); everything
  else is a drag. ✕ discards the task and everything under it, deepest first, since the
  server won't discard a task that still has subtasks. The message that follows has an
  undo button, and ↺ on the bubble it was in restores it too. A task the open
  reorganisation touches can't be discarded until that is applied or discarded.
  At the top, opposite the others: ＋, which puts a new bubble with a text box after the
  subtasks. ↵ makes it a subtask and offers the next one, esc throws it away, and clicking
  or dragging anything else keeps what was typed. The `+` key does the same as the button.
  Titles are broken into lines in `board.ts` (`breakTitle`), not by CSS: each line is as
  wide as the circle is at its height, words are kept whole, and what doesn't fit ends in
  an ellipsis. The element still holds the whole title.
  Reorganising is a draft (ADR 0003, `reorg.ts`): drag a subtask onto another to merge
  them into a new group task, into an open bubble to move it there, or onto empty board to
  make it a root. Click an open subtask's empty space to pop it (its subtasks take its
  place), and use Collapse to bring pops back. Nothing is written until the board has been
  closed for 6s, then the server applies the draft as one batch (or press "apply now").
  Merges stay within one root task. Depth is unlimited.
  Drag a closed root bubble onto a ring to reschedule it (there are no date buttons):
  today, tomorrow and weekend are due dates, distance across the month ring picks the day,
  and the rim opens a date picker for a scheduled date (⏳). The overdue ring refuses. The
  bubble swims back to its own wedge.
  A root sits at its earliest open deadline: its own due date, or a subtask's (at any
  depth) if that is sooner. Done subtasks and scheduled dates don't count. The weekend
  ring runs to the end of Sunday.
  By default only what is due by the end of the coming weekend is drawn. "show later" (or
  `L`) brings back the month and later rings, undated tasks included; the choice lasts for
  the tab. A later task that is open, or was changed this session, stays on the board
  (faded) either way. Hidden bubbles keep their place, so the toggle moves nothing.
  Physics cools (d3-force style) so the board always comes to rest; a bubble that is
  swimming home keeps it warm until it arrives, for at most 8s.

```sh
npm run dev         # :5173, proxies /api to `uv run misty serve` on :4322
npm run build       # dist/, served by `misty serve`
npm run test:e2e    # needs a build; drives real clicks against a throwaway db
```
