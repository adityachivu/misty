"""Reorganisation drafts (ADR 0003): stored, settled, translated and applied atomically."""

import json
import logging
import sqlite3
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from misty_core import Actor, CommandRejected, Edit, Task
from misty_core.structure import Step, Structure, check, plan
from misty_store.db import transaction
from misty_store.service import TaskService

log = logging.getLogger(__name__)

STANDIN = "standin:structure"
DEFAULT_SETTLE_MS = 6000


class DraftStatus(StrEnum):
    OPEN = "open"
    APPLIED = "applied"
    REJECTED = "rejected"
    DISCARDED = "discarded"


class Draft(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    client: str
    vocabulary: str
    note: str | None = None
    base_seq: int
    ops: list[JsonValue] = Field(default_factory=list)
    after: Structure = Field(default_factory=Structure)
    status: DraftStatus = DraftStatus.OPEN
    settle_ms: int = DEFAULT_SETTLE_MS
    hold_until: datetime | None = None
    translator: str | None = None
    seqs: list[int] | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime

    def due_at(self) -> datetime:
        settle = self.updated_at + timedelta(milliseconds=self.settle_ms)
        return max(settle, self.hold_until) if self.hold_until else settle


# Turns a draft into commands, given every task. The agent will be one of these.
Translator = Callable[[Draft, dict[str, Task]], Sequence[Step]]


def standin_translator(draft: Draft, tasks: dict[str, Task]) -> Sequence[Step]:
    """Deterministic: derive the commands from the intended structure alone."""
    return plan(draft.after, tasks)


class DraftService:
    def __init__(
        self,
        tasks: TaskService,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self.tasks = tasks
        self.conn = tasks.conn
        self.clock = clock

    # ── writes ───────────────────────────────────────────────────────────────

    def create(
        self,
        *,
        client: str,
        vocabulary: str,
        note: str | None = None,
        settle_ms: int = DEFAULT_SETTLE_MS,
    ) -> Draft:
        now = self.clock()
        draft = Draft(
            id=str(uuid.uuid7()),
            client=client,
            vocabulary=vocabulary,
            note=note,
            base_seq=self.tasks.head_seq(),
            settle_ms=settle_ms,
            created_at=now,
            updated_at=now,
        )
        with self.tasks.lock, transaction(self.conn):
            self.conn.execute(
                "INSERT INTO drafts (id, client, vocabulary, note, base_seq, ops, after, status, "
                "settle_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    draft.id,
                    draft.client,
                    draft.vocabulary,
                    draft.note,
                    draft.base_seq,
                    "[]",
                    draft.after.model_dump_json(),
                    draft.status,
                    draft.settle_ms,
                    draft.created_at.isoformat(),
                    draft.updated_at.isoformat(),
                ),
            )
        return draft

    def update(
        self,
        draft_id: str,
        *,
        append_ops: Sequence[JsonValue] = (),
        after: Structure | None = None,
        note: str | None = None,
        hold_ms: int | None = None,
    ) -> Draft:
        """Add ops and/or replace the intended structure. Any change restarts settling;
        `hold_ms` (re)sets the client's lease, and 0 releases it."""
        now = self.clock()
        with self.tasks.lock, transaction(self.conn):
            draft = self._open(draft_id)
            changed = bool(append_ops) or after is not None or note is not None
            updates: dict[str, Any] = {}
            if changed:
                updates["updated_at"] = now
                updates["ops"] = [*draft.ops, *append_ops]
            if after is not None:
                updates["after"] = after
            if note is not None:
                updates["note"] = note
            if hold_ms is not None:
                updates["hold_until"] = now + timedelta(milliseconds=hold_ms) if hold_ms else None
            draft = draft.model_copy(update=updates)
            self._save(draft)
        return draft

    def discard(self, draft_id: str) -> Draft:
        with self.tasks.lock, transaction(self.conn):
            draft = self._open(draft_id).model_copy(
                update={"status": DraftStatus.DISCARDED, "updated_at": self.clock()}
            )
            self._save(draft)
        return draft

    def apply(
        self,
        draft_id: str,
        *,
        steps: Sequence[Step] | None = None,
        translator: str = STANDIN,
        actor: Actor | None = None,
    ) -> Draft:
        """Translate and apply a draft. Given `steps`, a translator (the agent) has
        already composed the commands; otherwise the stand-in derives them.

        The edits and the draft's new status commit together. If the commands are
        rejected, or the result doesn't match `after`, nothing is written and the
        draft is marked rejected with the reason.
        """
        with self.tasks.lock:
            draft = self.get(draft_id)
            if draft is None:
                raise CommandRejected(f"No draft {draft_id!r}")
            if draft.status is not DraftStatus.OPEN:
                return draft
            who = actor or Actor(kind="user", id=draft.client)
            # Shown to the user in each task's history. The draft's id is already the
            # edits' correlation_id, so the reason says what happened, in words.
            reason = f"Reorganised in {draft.client}" + (f": {draft.note}" if draft.note else "")
            if translator != STANDIN:
                reason += f" (edits composed by {translator})"
            try:
                planned = (
                    list(steps)
                    if steps is not None
                    else list(standin_translator(draft, self.tasks.all_tasks()))
                )

                def done(edits: list[Edit]) -> None:
                    self._save(
                        draft.model_copy(
                            update={
                                "status": DraftStatus.APPLIED,
                                "translator": translator,
                                "seqs": [e.seq for e in edits if e.seq is not None],
                                "updated_at": self.clock(),
                            }
                        )
                    )

                self.tasks.execute_batch(
                    planned,
                    actor=who,
                    reason=reason,
                    correlation_id=draft.id,
                    check=lambda tasks, created: check(draft.after, tasks, created),
                    then=done,
                )
            except CommandRejected as e:
                with transaction(self.conn):
                    self._save(
                        draft.model_copy(
                            update={
                                "status": DraftStatus.REJECTED,
                                "translator": translator,
                                "error": str(e),
                                "updated_at": self.clock(),
                            }
                        )
                    )
            result = self.get(draft_id)
            assert result is not None
            return result

    def settle_due(self) -> list[Draft]:
        """Apply, with the stand-in, every open draft that has settled. Returns them."""
        now = self.clock()
        due = [d for d in self.list_drafts(DraftStatus.OPEN) if d.due_at() <= now]
        settled: list[Draft] = []
        for draft in due:
            try:
                settled.append(self.apply(draft.id))
            except Exception:
                # Not a rejection (that marks the draft): something broke. Leave it open
                # to try again, and don't let it hold up the drafts behind it.
                log.exception("draft %s could not be applied; it stays open", draft.id)
        return settled

    # ── reads ────────────────────────────────────────────────────────────────

    def get(self, draft_id: str) -> Draft | None:
        with self.tasks.lock:
            row = self.conn.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()
        return _to_draft(row) if row else None

    def list_drafts(self, status: DraftStatus | None = None) -> list[Draft]:
        with self.tasks.lock:
            rows = self.conn.execute(
                "SELECT * FROM drafts WHERE ? IS NULL OR status = ? ORDER BY created_at",
                (status, status),
            ).fetchall()
        return [_to_draft(r) for r in rows]

    # ── internals ────────────────────────────────────────────────────────────

    def _open(self, draft_id: str) -> Draft:
        draft = self.get(draft_id)
        if draft is None:
            raise CommandRejected(f"No draft {draft_id!r}")
        if draft.status is not DraftStatus.OPEN:
            raise CommandRejected(f"Draft {draft_id!r} is {draft.status}, not open")
        return draft

    def _save(self, d: Draft) -> None:
        self.conn.execute(
            "UPDATE drafts SET note=?, ops=?, after=?, status=?, hold_until=?, translator=?, "
            "seqs=?, error=?, updated_at=? WHERE id=?",
            (
                d.note,
                json.dumps(d.ops),
                d.after.model_dump_json(),
                d.status,
                d.hold_until.isoformat() if d.hold_until else None,
                d.translator,
                json.dumps(d.seqs) if d.seqs is not None else None,
                d.error,
                d.updated_at.isoformat(),
                d.id,
            ),
        )


def _to_draft(row: sqlite3.Row) -> Draft:
    data = dict(row)
    data["ops"] = json.loads(data["ops"])
    data["after"] = json.loads(data["after"])
    data["seqs"] = json.loads(data["seqs"]) if data["seqs"] else None
    return Draft.model_validate(data)
