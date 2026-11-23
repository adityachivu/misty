"""Which environment this machine runs, and that environment's settings.

    config/<env>.toml   committed, one per environment (dev, prod)
    config/local.toml   not committed, this machine only: picks the env, overrides any key

The env is `--env` / MISTY_ENV, else `env` in config/local.toml, else dev. A setting is
its CLI flag / MISTY_* variable, else config/local.toml, else config/<env>.toml.

Prod reads these files with whatever code it last deployed, so keys are only ever added
(with a default). Unknown keys are ignored with a warning, not an error, so a local.toml
written for a newer or older version still loads. See docs/breaking/README.md.
"""

import sys
import tomllib
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

# apps/server/src/misty_server/config.py -> the repo root
REPO = Path(__file__).resolve().parents[4]
CONFIG_DIR = REPO / "config"
DEFAULT_ENV = "dev"


class ConfigError(Exception):
    pass


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    env: str
    db: Path
    host: str = "127.0.0.1"
    port: int = 4322
    # True means the data is throwaway and may be wiped or filled with test tasks.
    # False is the default, so an environment has to opt in to being destructible.
    disposable: bool = False
    # Shell command that restarts the server; `misty deploy` runs it when it is done.
    restart: str | None = None

    @property
    def data_dir(self) -> Path:
        """Where this environment keeps its database, backups, and deploy state."""
        return self.db.parent


def load(env: str | None = None, **overrides: Any) -> Settings:
    """Resolve settings for `env`. Overrides that are None are ignored."""
    local = _read(CONFIG_DIR / "local.toml")
    env = env or local.pop("env", None) or DEFAULT_ENV
    file = CONFIG_DIR / f"{env}.toml"
    if not file.is_file():
        known = ", ".join(
            sorted(f.stem for f in CONFIG_DIR.glob("*.toml") if "local" not in f.stem)
        )
        raise ConfigError(f"no config for env {env!r} (expected {file}); known envs: {known}")

    values: dict[str, Any] = {**_read(file), **local}
    for key in sorted(values.keys() - Settings.model_fields.keys()):
        print(f"misty: ignoring unknown config key {key!r}", file=sys.stderr)
        del values[key]
    if "db" not in values:
        raise ConfigError(f"{file} doesn't set `db`")
    # In config files a relative path is from the repo root; on the command line, from here.
    values["db"] = _resolve(values["db"], CONFIG_DIR.parent)
    values |= {k: v for k, v in overrides.items() if v is not None}
    values["db"] = _resolve(values["db"], Path.cwd())
    try:
        return Settings.model_validate({**values, "env": env})
    except ValidationError as e:
        problems = "; ".join(
            f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()
        )
        raise ConfigError(f"invalid config for env {env!r}: {problems}") from e


def _read(file: Path) -> dict[str, Any]:
    if not file.is_file():
        return {}
    try:
        return tomllib.loads(file.read_text())
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{file}: {e}") from e


def _resolve(path: str | Path, base: Path) -> Path:
    path = Path(path).expanduser()
    return path if path.is_absolute() else base / path
