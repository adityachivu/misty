from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class TaskState(StrEnum):
    OPEN = "open"
    DONE = "done"
    RELEASED = "released"  # let go on purpose; a legitimate outcome, not a failure
    DISCARDED = "discarded"  # captured by mistake or duplicated; hidden from views


class Task(BaseModel):
    """One row of the live tasks projection.

    Deliberately minimal: every cognitive/somatic dimension lives in `attrs`
    (see `misty_core.attributes`) so the shape can change without migrations.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    parent_id: str | None = None
    title: str
    state: TaskState = TaskState.OPEN
    attrs: dict[str, JsonValue] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    version: int = 1  # number of edits applied to this task
