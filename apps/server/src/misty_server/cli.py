import json
import shutil
import subprocess
import urllib.request
from pathlib import Path
from typing import Annotated, NoReturn

import typer

from misty_server import config
from misty_server import deploy as deploys
from misty_server.config import REPO, Settings
from misty_server.importers import import_dartboard
from misty_server.seed import seed as seed_tasks
from misty_store import TaskService

app = typer.Typer(no_args_is_help=True, help="Misty: serve and maintain the task database.")
db_app = typer.Typer(no_args_is_help=True, help="Inspect and maintain the database.")
app.add_typer(db_app, name="db")

WEB = REPO / "apps" / "web"
WEB_DIST = WEB / "dist"

DbOption = Annotated[
    Path | None,
    typer.Option("--db", envvar="MISTY_DB", help="SQLite database file. Default: from config."),
]

_env: str | None = None  # set by the --env option, which comes before the command


@app.callback()
def main(
    env: Annotated[
        str | None,
        typer.Option(
            envvar="MISTY_ENV",
            help="Environment (dev, prod). Default: `env` in config/local.toml, else dev.",
        ),
    ] = None,
) -> None:
    global _env
    _env = env


def fail(message: str) -> NoReturn:
    typer.echo(message, err=True)
    raise typer.Exit(1)


def settings(db: Path | None = None, host: str | None = None, port: int | None = None) -> Settings:
    try:
        return config.load(_env, db=db, host=host, port=port)
    except config.ConfigError as e:
        fail(f"misty: {e}")


def open_service(db: Path) -> TaskService:
    db.parent.mkdir(parents=True, exist_ok=True)
    return TaskService.open(db)


def require_disposable(s: Settings, action: str) -> None:
    if not s.disposable:
        fail(
            f"refusing to {action}: env {s.env!r} holds real data ({s.db}).\n"
            "This command is for disposable environments (dev)."
        )


def require_acknowledged(s: Settings) -> None:
    """Don't run new code against real data past a breaking change nobody has read."""
    if s.disposable:
        return
    if pending := deploys.unacknowledged(s):
        notes = "\n".join(f"  {note.path.relative_to(REPO)}" for note in pending)
        fail(
            f"this checkout has breaking changes not yet applied to env {s.env!r}:\n{notes}\n"
            "Run `just deploy` to apply them."
        )


@app.command("config")
def show_config() -> None:
    """Show the environment this machine runs and its settings."""
    s = settings()
    for key, value in s.model_dump().items():
        typer.echo(f"{key:<11}{'' if value is None else value}")


@app.command()
def serve(
    db: DbOption = None,
    host: Annotated[str | None, typer.Option(envvar="MISTY_HOST")] = None,
    port: Annotated[int | None, typer.Option(envvar="MISTY_PORT")] = None,
    web: Annotated[Path, typer.Option(help="Built web app to serve at /.")] = WEB_DIST,
) -> None:
    """Serve the REST API, MCP at /mcp, and the built web app if there is one."""
    import uvicorn

    from misty_server.api import create_app

    s = settings(db, host, port)
    require_acknowledged(s)
    service = open_service(s.db)
    if not web.is_dir():
        typer.echo(f"no web build at {web}; serving the API only (npm run build in apps/web)")
    typer.echo(f"misty [{s.env}] → http://{s.host}:{s.port}  (db: {s.db})")
    uvicorn.run(create_app(service, static_dir=web), host=s.host, port=s.port, log_level="warning")


@app.command("mcp")
def mcp_stdio(db: DbOption = None) -> None:
    """Serve the MCP tools over stdio, for an agent that launches Misty itself.

    Works alongside a running `misty serve`: both write through the same database file.
    """
    import anyio

    from misty_server.mcp_server import serve_stdio

    s = settings(db)
    require_acknowledged(s)
    # Nothing may be printed to stdout here: it carries the protocol.
    anyio.run(serve_stdio, open_service(s.db))


@app.command()
def deploy(
    accept_breaking: Annotated[
        int | None,
        typer.Option(help="Acknowledge the breaking-change notes up to this number."),
    ] = None,
) -> None:
    """Apply the checked-out code to this machine: back up, build, migrate, verify.

    Stops before touching anything if the code carries a breaking change (docs/breaking/)
    that this machine hasn't acknowledged.
    """
    s = settings()
    if s.disposable:
        fail(
            f"env {s.env!r} is disposable test data, so there is nothing to deploy to.\n"
            'On the machine with the real data, put `env = "prod"` in config/local.toml.'
        )
    if pending := deploys.unacknowledged(s, accept=accept_breaking or 0):
        for note in pending:
            typer.echo(f"━━ BREAKING: {note.path.relative_to(REPO)} ━━\n{note.path.read_text()}")
        fail(
            f"Stopped: {len(pending)} breaking change(s) since the last deploy. Nothing was "
            "changed.\nRead the notes above and do what they ask, then run:\n"
            f"  just deploy --accept-breaking {pending[-1].number}"
        )

    sha = _git("rev-parse", "--short", "HEAD") or "unknown"
    saved = deploys.backup(s, label=f"before-{sha}")
    if saved:
        typer.echo(f"backed up the database to {saved}")
    try:
        _build_web()
        service = open_service(s.db)  # migrates the log, rebuilds the projection if needed
        diffs = service.verify()
        service.close()
    except Exception as e:
        diffs = [f"{type(e).__name__}: {e}"]
    if diffs:
        was = (deploys.read_state(s) or {}).get("sha", "the previous commit")
        fail(
            "\n".join(diffs) + f"\nDeploy FAILED at {sha}. The server was not restarted.\n"
            f"Last good deploy: {was}. Database backup: {saved or 'none (no database yet)'}"
        )

    deploys.write_state(s, sha=sha)
    typer.echo(f"deployed {sha} to {s.env} (db: {s.db})")
    if s.restart:
        typer.echo(f"restarting: {s.restart}")
        if subprocess.run(s.restart, shell=True, cwd=REPO).returncode:
            fail("the restart command failed; restart the server by hand")
    else:
        typer.echo("Restart the server to run the new code (`just serve`).")


def _build_web() -> None:
    if not shutil.which("npm"):
        raise RuntimeError("npm is not installed, so the web app can't be built")
    subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=WEB, check=True)
    subprocess.run(["npm", "run", "build"], cwd=WEB, check=True)


def _git(*args: str) -> str | None:
    try:
        done = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True)
    except OSError, subprocess.CalledProcessError:
        return None
    return done.stdout.strip()


def delete_db(db: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        Path(f"{db}{suffix}").unlink(missing_ok=True)


@db_app.command()
def reset(db: DbOption = None) -> None:
    """Delete the database (log and all). Stop `misty serve` first."""
    s = settings(db)
    require_disposable(s, "delete the database")
    delete_db(s.db)
    typer.echo(f"deleted {s.db}")


@db_app.command()
def seed(
    db: DbOption = None,
    n: Annotated[int, typer.Option("-n", help="How many root tasks.")] = 20,
    rng_seed: Annotated[int | None, typer.Option("--seed", help="Repeatable output.")] = None,
    fresh: Annotated[bool, typer.Option("--reset", help="Start from an empty database.")] = False,
) -> None:
    """Fill the database with random test tasks. Stop `misty serve` before --reset."""
    s = settings(db)
    # Even without --reset: the log is append-only, so test tasks could never be removed.
    require_disposable(s, "add test tasks")
    if fresh:
        delete_db(s.db)
    count = seed_tasks(open_service(s.db), n=n, rng_seed=rng_seed)
    typer.echo(f"seeded {count} tasks into {s.db}")


@db_app.command()
def backup(db: DbOption = None) -> None:
    """Copy the database into the backups folder next to it. Safe while serving."""
    s = settings(db)
    saved = deploys.backup(s, label="manual")
    typer.echo(f"backed up to {saved}" if saved else f"no database at {s.db}")


@db_app.command()
def verify(db: DbOption = None) -> None:
    """Replay the edit log and compare it with the live tasks table."""
    diffs = open_service(settings(db).db).verify()
    for diff in diffs:
        typer.echo(diff)
    if diffs:
        raise typer.Exit(1)
    typer.echo("ok: replaying the log reproduces the tasks table")


@db_app.command()
def rebuild(db: DbOption = None) -> None:
    """Drop the tasks table and rebuild it from the edit log."""
    open_service(settings(db).db).rebuild()
    typer.echo("rebuilt")


@db_app.command()
def tail(
    db: DbOption = None,
    n: Annotated[int, typer.Option("-n", help="How many edits.")] = 20,
) -> None:
    """Show the most recent edits."""
    service = open_service(settings(db).db)
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
    db: DbOption = None,
    force: Annotated[bool, typer.Option(help="Import even if the database has edits.")] = False,
) -> None:
    """Import tasks from the Obsidian dartboard. Reads only; never writes to the vault."""
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source) as response:
            data = json.load(response)
    else:
        data = json.loads(Path(source).read_text())
    s = settings(db)
    service = open_service(s.db)
    if service.head_seq() and not force:
        typer.echo("the database already has edits; pass --force to import anyway", err=True)
        raise typer.Exit(1)
    typer.echo(f"imported {import_dartboard(service, data)} tasks into {s.db}")
