from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "src" / "config" / "project.toml"


@dataclass(frozen=True)
class Settings:
    project_root: Path
    config_path: Path
    values: dict

    @property
    def random_state(self) -> int:
        return int(self.values["project"]["random_state"])

    @property
    def timezone(self) -> str:
        return str(self.values["project"]["timezone"])

    def path(self, key: str) -> Path:
        return self.project_root / self.values["paths"][key]

    @property
    def data_cfg(self) -> dict:
        return self.values["data"]

    @property
    def feature_cfg(self) -> dict:
        return self.values["features"]

    @property
    def split_cfg(self) -> dict:
        return self.values["splits"]

    @property
    def cv_cfg(self) -> dict:
        return self.values["cross_validation"]

    @property
    def tabular_model_cfg(self) -> dict:
        return self.values["models"]["tabular"]

    @property
    def sequence_model_cfg(self) -> dict:
        return self.values["models"]["sequence"]

    @property
    def forecasting_model_cfg(self) -> dict:
        return self.values["models"]["forecasting"]

    @property
    def context_cfg(self) -> dict:
        return self.values.get("context", {})


def load_settings(config_path: str | Path | None = None) -> Settings:
    env_path = os.environ.get("PROJECT_CONFIG")
    final_path = Path(config_path or env_path or DEFAULT_CONFIG_PATH)
    with open(final_path, "rb") as handle:
        values = tomllib.load(handle)
    return Settings(project_root=PROJECT_ROOT, config_path=final_path, values=values)
