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

```sh
npm run dev         # :5173, proxies /api to `uv run misty serve` on :4322
npm run build       # dist/, served by `misty serve`
npm run test:e2e    # needs a build; drives real clicks against a throwaway db
```
