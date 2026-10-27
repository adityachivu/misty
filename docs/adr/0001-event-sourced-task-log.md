# 1. Event-sourced task log with a disposable projection

**Status:** accepted · 2026-10-26

## Context
Every change to tasks should be a predefined operation (which doubles as an MCP tool),
history should be kept, and replaying it must always recreate the task table. The
cognitive/somatic task attributes are still being researched and will change often.

## Decision
- An append-only `task_edits` table is the source of truth. `tasks` is a projection
  computed by one pure reducer, written in the same transaction as the edit.
- Commands are validated into fully resolved edits. Only valid edits are recorded.
- The projection is never migrated. It is rebuilt when its DDL or `REDUCER_VERSION`
  changes. Payload changes are handled with upcasters on read.
- Task dimensions live in a JSON `attrs` column, validated by a code-level attribute
  registry. `x_` keys allow unvalidated experiments. Hot attributes can be promoted to
  generated, indexed columns.
- Undo is recorded as compensating edits. Nothing is hard-deleted.

## Consequences
- The schema is cheap to change: most changes are code-only with an automatic rebuild.
- Correctness depends on `apply` being pure and deterministic, which is enforced by a
  property-based test.
- Old edit types and payload shapes must remain readable forever, via upcasters.
