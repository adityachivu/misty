"""SQLite storage for Misty: the append-only edit log and the rebuildable tasks projection."""

from misty_store.db import connect
from misty_store.service import TaskService

__all__ = ["TaskService", "connect"]
