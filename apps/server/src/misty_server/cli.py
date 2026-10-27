import json
import urllib.request
from pathlib import Path
from typing import Annotated

import typer

from misty_server.importers import import_dartboard
from misty_server.seed import seed as seed_tasks
from misty_store import TaskService

app = typer.Typer(no_args_is_help=True, help="Misty: serve and maintain the task database.")
db_app = typer.Typer(no_args_is_help=True, help="Inspect and maintain the database.")
app.add_typer(db_app, name="db")

# apps/server/src/misty_server/cli.py -> apps/web/dist
WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"

DbOption = Annotated[Path, typer.Option("--db", envvar="MISTY_DB", help="SQLite database file.")]
DEFAULT_DB = Path("data/misty.db")


def open_service(db: Path) -> TaskService:
    db.parent.mkdir(parents=True, exist_ok=True)
    return TaskService.open(db)


@app.command()
def serve(
    db: DbOption = DEFAULT_DB,
    host: str = "127.0.0.1",
    port: int = 4322,
    web: Annotated[Path, typer.Option(help="Built web app to serve at /.")] = WEB_DIST,
) -> None:
    """Serve the REST API, and the built web app if there is one."""
    import uvicorn

    from misty_server.api import create_app

    service = open_service(db)
    if not web.is_dir():
        typer.echo(f"no web build at {web}; serving the API only (npm run build in apps/web)")
    typer.echo(f"misty → http://{host}:{port}  (db: {db})")
    uvicorn.run(create_app(service, static_dir=web), host=host, port=port, log_level="warning")


def delete_db(db: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        Path(f"{db}{suffix}").unlink(missing_ok=True)


@db_app.command()
def reset(db: DbOption = DEFAULT_DB) -> None:
    """Delete the database (log and all). Stop `misty serve` first."""
    delete_db(db)
    typer.echo(f"deleted {db}")


@db_app.command()
def seed(
    db: DbOption = DEFAULT_DB,
    n: Annotated[int, typer.Option("-n", help="How many root tasks.")] = 20,
    rng_seed: Annotated[int | None, typer.Option("--seed", help="Repeatable output.")] = None,
    fresh: Annotated[bool, typer.Option("--reset", help="Start from an empty database.")] = False,
) -> None:
    """Fill the database with random test tasks. Stop `misty serve` before --reset."""
    if fresh:
        delete_db(db)
    count = seed_tasks(open_service(db), n=n, rng_seed=rng_seed)
    typer.echo(f"seeded {count} tasks into {db}")


@db_app.command()
def verify(db: DbOption = DEFAULT_DB) -> None:
    """Replay the edit log and compare it with the live tasks table."""
    diffs = open_service(db).verify()
    for diff in diffs:
        typer.echo(diff)
    if diffs:
        raise typer.Exit(1)
    typer.echo("ok: replaying the log reproduces the tasks table")


@db_app.command()
def rebuild(db: DbOption = DEFAULT_DB) -> None:
    """Drop the tasks table and rebuild it from the edit log."""
    open_service(db).rebuild()
    typer.echo("rebuilt")


@db_app.command()
def tail(
    db: DbOption = DEFAULT_DB,
    n: Annotated[int, typer.Option("-n", help="How many edits.")] = 20,
) -> None:
    """Show the most recent edits."""
    service = open_service(db)
    for edit in service.edits(after_seq=max(0, service.head_seq() - n)):
        reason = f"  — {edit.reason}" if edit.reason else ""
        typer.echo(
            f"{edit.seq:>5}  {edit.occurred_at:%Y-%m-%d %H:%M}  {edit.actor.id:<18} "
            f"{edit.type:<18} {edit.task_id or ''}{reason}"
        )


@app.command("import-dartboard")
def import_dartboard_cmd(
    source: Annotated[
        str, typer.Argument(help="URL of the dartboard's /api/tasks, or a JSON file.")
    ],
    db: DbOption = DEFAULT_DB,
    force: Annotated[bool, typer.Option(help="Import even if the database has edits.")] = False,
) -> None:
    """Import tasks from the Obsidian dartboard. Reads only; never writes to the vault."""
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source) as response:
            data = json.load(response)
    else:
        data = json.loads(Path(source).read_text())
    service = open_service(db)
    if service.head_seq() and not force:
        typer.echo("the database already has edits; pass --force to import anyway", err=True)
        raise typer.Exit(1)
    typer.echo(f"imported {import_dartboard(service, data)} tasks into {db}")
