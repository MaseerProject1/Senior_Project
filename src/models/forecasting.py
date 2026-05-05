from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import torch

from src.config.settings import Settings
from src.models.deep_training import load_deep_model, save_deep_forecasters, train_deep_forecasters
from src.models.sequence_dataset import (
    build_forecast_sequences,
    build_live_forecast_input,
    downsample_sequence_frame,
    naive_previous_horizon_forecast,
    split_forecast_sequences,
)


def resolve_forecast_model_path(path_value: str | Path, artifacts_dir: Path | None = None) -> Path:
    path = Path(path_value)
    if path.exists():
        return path

    if artifacts_dir is not None:
        candidate = artifacts_dir / path
        if candidate.exists():
            return candidate

        candidate = artifacts_dir / "models" / path.name
        if candidate.exists():
            return candidate

    return path


def train_and_save_24h_forecaster(panel_df: pd.DataFrame, settings: Settings) -> dict | None:
    if not bool(settings.forecasting_model_cfg["enabled"]):
        return None
    cfg = settings.forecasting_model_cfg
    sequence_df = build_forecast_sequences(panel_df, history_window=int(cfg["history_window"]), horizon=int(cfg["horizon"]))
    sequence_df = downsample_sequence_frame(sequence_df, int(cfg["max_sequences"]))
    if sequence_df.empty:
        raise ValueError("No valid deep forecast sequences were generated.")
    splits = split_forecast_sequences(
        sequence_df,
        train_fraction=float(settings.split_cfg["train_fraction"]),
        validation_fraction=float(settings.split_cfg["validation_fraction"]),
    )
    outputs = train_deep_forecasters(splits, settings)
    return save_deep_forecasters(outputs, settings)


def load_forecast_manifest(settings: Settings) -> dict:
    from src.utils.io import read_json

    return read_json(settings.path("artifacts_dir") / "metadata" / "forecast_manifest.json")


def load_named_forecaster(settings: Settings, model_name: str):
    manifest = load_forecast_manifest(settings)
    for item in manifest["models"]:
        if item["model_name"] == model_name:
            return load_deep_model(Path(item["path"]))
    raise FileNotFoundError(f"Forecast model '{model_name}' was not found in the manifest.")


def available_forecast_models(settings: Settings) -> list[str]:
    manifest = load_forecast_manifest(settings)
    return [item["model_name"] for item in manifest.get("models", [])]


def naive_previous_24_forecast(zone_history_df: pd.DataFrame, horizon: int) -> pd.DataFrame:
    return naive_previous_horizon_forecast(zone_history_df, horizon=horizon)


def predict_next_24_hours(model_payload_path, zone_history_df: pd.DataFrame) -> pd.DataFrame:
    model, payload = load_deep_model(Path(model_payload_path))
    history_window = int(payload["history_window"])
    model_input = build_live_forecast_input(zone_history_df, history_window=history_window)
    input_tensor = torch.tensor(model_input[None, :, :], dtype=torch.float32)
    with torch.no_grad():
        prediction = np.maximum(model(input_tensor).cpu().numpy().reshape(-1), 0.0)
    last_timestamp = pd.to_datetime(zone_history_df["timestamp"]).max()
    forecast_timestamps = [last_timestamp + pd.Timedelta(hours=step) for step in range(1, len(prediction) + 1)]
    return pd.DataFrame({"forecast_timestamp": forecast_timestamps, "predicted_pickup_count": prediction, "horizon_step": np.arange(1, len(prediction) + 1)})
