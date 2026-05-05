from __future__ import annotations

import json
from pathlib import Path

import joblib
import pandas as pd


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(payload: dict, path: Path) -> None:
    ensure_dir(path.parent)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False, default=str)


def read_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def write_dataframe(df: pd.DataFrame, path: Path) -> None:
    ensure_dir(path.parent)
    if path.suffix == ".csv":
        df.to_csv(path, index=False)
        return
    df.to_parquet(path, index=False)


def read_dataframe(path: Path, **kwargs) -> pd.DataFrame:
    if path.suffix == ".csv":
        return pd.read_csv(path, **kwargs)
    return pd.read_parquet(path, **kwargs)


def save_model(model: object, path: Path) -> None:
    ensure_dir(path.parent)
    joblib.dump(model, path)


def load_model(path: Path) -> object:
    return joblib.load(path)
