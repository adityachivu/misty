import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, JsonValue


class Actor(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["user", "agent", "system"]
    id: str  # e.g. "web:garden", "agent:claude-code", "cli"


class Edit(BaseModel):
    """A validated, fully resolved fact: one row of the edit log.

    Once recorded, an edit always applies. Everything non-deterministic (ids,
    timestamps, absolute times) is already resolved inside `payload`.
    """

    model_config = ConfigDict(frozen=True)

    edit_id: str
    type: str
    type_version: int
    task_id: str | None
    targets: tuple[str, ...]
    payload: dict[str, JsonValue]
    actor: Actor
    occurred_at: datetime
    reason: str | None = None
    correlation_id: str | None = None
    reverts_seq: int | None = None
    seq: int | None = None  # assigned by the store on append


@dataclass(frozen=True)
class EditContext:
    """Everything non-deterministic about an edit, resolved once at command time."""

    occurred_at: datetime
    new_id: Callable[[], str]

    @classmethod
    def now(cls) -> EditContext:
        return cls(occurred_at=datetime.now(UTC), new_id=lambda: str(uuid.uuid7()))
