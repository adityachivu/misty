import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from importlib import resources
from pathlib import Path


def connect(path: str | Path) -> sqlite3.Connection:
    """Open a Misty database and bring the edit log schema up to date."""
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection, *, write: bool = True) -> Generator[None]:
    """A transaction. Write transactions take the lock up front (BEGIN IMMEDIATE)."""
    conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def migrate(conn: sqlite3.Connection) -> None:
    """Apply numbered migrations (`NNN_name.sql`) newer than PRAGMA user_version."""
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    migrations = sorted(
        (int(f.name.split("_", 1)[0]), f)
        for f in resources.files("misty_store.migrations").iterdir()
        if f.name.endswith(".sql")
    )
    for number, file in migrations:
        if number > current:
            # executescript can't run inside an open transaction, so the script carries its own.
            conn.executescript(
                f"BEGIN IMMEDIATE;\n{file.read_text()}\nPRAGMA user_version = {number};\nCOMMIT;"
            )
