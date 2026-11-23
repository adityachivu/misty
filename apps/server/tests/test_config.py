from pathlib import Path

import pytest

from misty_server import config


@pytest.fixture
def config_dir(tmp_path, monkeypatch):
    """A config folder of our own, so the machine's real config/local.toml isn't read."""
    folder = tmp_path / "config"
    folder.mkdir()
    (folder / "dev.toml").write_text('db = "data/misty.db"\ndisposable = true\n')
    (folder / "prod.toml").write_text('db = "~/misty/misty.db"\nport = 5000\n')
    monkeypatch.setattr(config, "CONFIG_DIR", folder)
    return folder


def test_committed_prod_is_protected_and_outside_the_checkout(tmp_path, monkeypatch):
    committed = tmp_path / "config"
    committed.mkdir()
    for name in ("dev.toml", "prod.toml"):
        (committed / name).write_text((config.REPO / "config" / name).read_text())
    monkeypatch.setattr(config, "CONFIG_DIR", committed)

    dev, prod = config.load("dev"), config.load("prod")
    assert dev.disposable and dev.db == tmp_path / "data" / "misty.db"
    assert not prod.disposable
    assert not prod.db.is_relative_to(tmp_path)
    assert (dev.host, prod.host) == ("127.0.0.1", "127.0.0.1")


def test_dev_is_the_default_and_local_toml_picks_the_env(config_dir):
    assert config.load().env == "dev"
    (config_dir / "local.toml").write_text('env = "prod"\nhost = "0.0.0.0"\n')
    settings = config.load()
    assert (settings.env, settings.host, settings.port) == ("prod", "0.0.0.0", 5000)
    assert settings.db == Path.home() / "misty" / "misty.db"
    assert not settings.disposable  # protected unless a config says otherwise


def test_flags_beat_local_toml_beats_the_env_file(config_dir, tmp_path, monkeypatch):
    (config_dir / "local.toml").write_text('env = "prod"\nport = 6000\n')
    assert config.load("dev").env == "dev"
    assert config.load().port == 6000
    assert config.load(port=7000, host=None).port == 7000
    monkeypatch.chdir(tmp_path)
    assert config.load(db=Path("x.db")).db == tmp_path / "x.db"  # flags are relative to here


def test_unknown_keys_are_ignored_not_fatal(config_dir, capsys):
    """A key from a newer or older version of the code must not stop prod from starting."""
    (config_dir / "local.toml").write_text('retired_setting = 1\nrestart = "true"\n')
    assert config.load().restart == "true"
    assert "retired_setting" in capsys.readouterr().err


def test_bad_config_is_a_clear_error(config_dir):
    with pytest.raises(config.ConfigError, match="known envs: dev, prod"):
        config.load("staging")
    (config_dir / "local.toml").write_text('port = "eighty"\n')
    with pytest.raises(config.ConfigError, match="port"):
        config.load()
