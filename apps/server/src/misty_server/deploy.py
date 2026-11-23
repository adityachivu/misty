"""Applying new code to a machine that holds real data: breaking-change notes, backups.

Changes on main are meant to be backwards compatible, so `just deploy` needs no thought.
A change that can't be is announced by a numbered note in docs/breaking/. Each machine
records the highest note it has acknowledged, next to its database; anything newer stops
the deploy (and the server) until someone has read it. See docs/breaking/README.md.
"""

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from misty_server.config import REPO, Settings

NOTES_DIR = REPO / "docs" / "breaking"
_NOTE = re.compile(r"(\d+)-.+\.md")


@dataclass(frozen=True)
class Note:
    number: int
    path: Path


def breaking_notes() -> list[Note]:
    """Every breaking-change note in this checkout, oldest first."""
    found = [(m, f) for f in NOTES_DIR.glob("*.md") if (m := _NOTE.fullmatch(f.name))]
    return sorted((Note(int(m[1]), f) for m, f in found), key=lambda n: n.number)


def latest_note() -> int:
    return max((n.number for n in breaking_notes()), default=0)


def read_state(settings: Settings) -> dict[str, Any] | None:
    """What was last deployed to this data directory, or None if nothing ever was."""
    file = _state_file(settings)
    return json.loads(file.read_text()) if file.is_file() else None


def write_state(settings: Settings, *, sha: str) -> None:
    state = {"breaking": latest_note(), "sha": sha, "at": datetime.now(UTC).isoformat()}
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    _state_file(settings).write_text(json.dumps(state, indent=2) + "\n")


def unacknowledged(settings: Settings, *, accept: int = 0) -> list[Note]:
    """Breaking notes newer than this machine has acknowledged.

    `accept` acknowledges every note up to that number for this call.
    """
    state = read_state(settings)
    if state is None and not settings.db.exists():
        return []  # nothing here yet for a change to break
    acknowledged = max(state["breaking"] if state else 0, accept)
    return [n for n in breaking_notes() if n.number > acknowledged]


def backup(settings: Settings, *, label: str) -> Path | None:
    """Copy the database into <data dir>/backups. Safe while the server is running."""
    if not settings.db.exists():
        return None
    dest = settings.data_dir / "backups" / f"misty-{datetime.now(UTC):%Y%m%d-%H%M%S}-{label}.db"
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Plain connections: connect() from misty_store would migrate the file being saved.
    source, target = sqlite3.connect(settings.db), sqlite3.connect(dest)
    try:
        source.backup(target)
    finally:
        source.close()
        target.close()
    return dest


def _state_file(settings: Settings) -> Path:
    return settings.data_dir / "deploy.json"
