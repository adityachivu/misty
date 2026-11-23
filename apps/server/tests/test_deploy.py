import json
import sqlite3

import pytest
from typer.testing import CliRunner

from misty_core import Actor
from misty_server import cli, config, deploy
from misty_store import TaskService


@pytest.fixture
def prod(tmp_path, monkeypatch):
    """A machine set up as prod: its own config, data folder, and breaking-notes folder."""
    folder = tmp_path / "config"
    folder.mkdir()
    (folder / "dev.toml").write_text(f'db = "{tmp_path}/dev/misty.db"\ndisposable = true\n')
    (folder / "prod.toml").write_text(f'db = "{tmp_path}/prod/misty.db"\n')
    (folder / "local.toml").write_text('env = "prod"\n')
    notes = tmp_path / "breaking"
    notes.mkdir()
    (notes / "README.md").write_text("not a note")
    monkeypatch.setattr(config, "CONFIG_DIR", folder)
    monkeypatch.setattr(deploy, "NOTES_DIR", notes)
    monkeypatch.setattr(cli, "REPO", tmp_path)
    monkeypatch.setattr(cli, "_build_web", lambda: None)
    monkeypatch.delenv("MISTY_ENV", raising=False)
    monkeypatch.delenv("MISTY_DB", raising=False)
    return tmp_path


def misty(*args):
    return CliRunner().invoke(cli.app, list(args))


def acknowledged(settings):
    state = deploy.read_state(settings)
    assert state is not None
    return state["breaking"]


def add_task(settings, title="real task"):
    service = cli.open_service(settings.db)
    service.execute("create_task", {"title": title}, actor=Actor(kind="user", id="test"))
    service.close()


def test_first_deploy_then_a_compatible_update(prod):
    (prod / "breaking" / "0001-before-this-machine-existed.md").write_text("old news")

    first = misty("deploy")
    assert first.exit_code == 0, first.output
    settings = config.load()
    assert settings.db.exists()
    assert acknowledged(settings) == 1  # nothing here for it to break
    assert not (settings.data_dir / "backups").exists()

    add_task(settings)
    again = misty("deploy")
    assert again.exit_code == 0, again.output
    [saved] = (settings.data_dir / "backups").glob("*.db")
    assert sqlite3.connect(saved).execute("SELECT count(*) FROM task_edits").fetchone() == (1,)


def test_a_breaking_change_stops_the_deploy_until_acknowledged(prod):
    assert misty("deploy").exit_code == 0
    settings = config.load()
    add_task(settings)
    before = json.loads((settings.data_dir / "deploy.json").read_text())
    (prod / "breaking" / "0001-new-port.md").write_text("Move the bookmark to port 5000.")
    (prod / "breaking" / "0002-reimport.md").write_text("Re-run the import afterwards.")

    stopped = misty("deploy")
    assert stopped.exit_code == 1
    assert "Move the bookmark to port 5000." in stopped.output
    assert "Re-run the import afterwards." in stopped.output
    assert "just deploy --accept-breaking 2" in stopped.output
    # nothing was touched
    assert json.loads((settings.data_dir / "deploy.json").read_text()) == before
    assert not (settings.data_dir / "backups").exists()

    # acknowledging only the first note is not enough
    assert misty("deploy", "--accept-breaking", "1").exit_code == 1
    # the server refuses to start on unacknowledged breaking code
    refused = misty("serve")
    assert refused.exit_code == 1 and "just deploy" in refused.output

    accepted = misty("deploy", "--accept-breaking", "2")
    assert accepted.exit_code == 0, accepted.output
    assert acknowledged(settings) == 2
    assert deploy.unacknowledged(settings) == []


def test_existing_data_with_no_deploy_record_is_not_assumed_safe(prod):
    settings = config.load()
    add_task(settings)  # e.g. a database copied over from another machine
    (prod / "breaking" / "0001-anything.md").write_text("x")
    assert [n.number for n in deploy.unacknowledged(settings)] == [1]


def test_a_failed_deploy_says_so_and_records_nothing(prod, monkeypatch):
    assert misty("deploy").exit_code == 0
    settings = config.load()
    before = deploy.read_state(settings)

    def broken_build():
        raise RuntimeError("tsc: 3 errors")

    monkeypatch.setattr(cli, "_build_web", broken_build)
    failed = misty("deploy")
    assert failed.exit_code == 1
    assert "tsc: 3 errors" in failed.output and "FAILED" in failed.output
    assert deploy.read_state(settings) == before


def test_restart_command_runs_after_a_successful_deploy(prod):
    marker = prod / "restarted"
    (prod / "config" / "local.toml").write_text(f'env = "prod"\nrestart = "touch {marker}"\n')
    assert misty("deploy").exit_code == 0
    assert marker.exists()


def test_dev_has_nothing_to_deploy(prod):
    result = misty("--env", "dev", "deploy")
    assert result.exit_code == 1 and "disposable" in result.output


def test_prod_refuses_to_wipe_or_seed_but_dev_does_not(prod):
    settings = config.load()
    add_task(settings)
    for args in (["db", "reset"], ["db", "seed"], ["db", "seed", "--reset"]):
        result = misty(*args)
        assert result.exit_code == 1 and "real data" in result.output
    assert TaskService.open(settings.db).head_seq() == 1

    assert misty("--env", "dev", "db", "seed", "-n", "2").exit_code == 0
    assert misty("--env", "dev", "db", "reset").exit_code == 0
    assert not config.load("dev").db.exists()
