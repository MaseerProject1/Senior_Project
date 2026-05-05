from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.model_selection import TimeSeriesSplit
from torch import nn
from torch.utils.data import DataLoader

from src.config.settings import Settings
from src.evaluation.metrics import regression_metrics
from src.models.gru_model import GRUForecaster
from src.models.lstm_model import LSTMForecaster
from src.models.sequence_dataset import MultiHorizonDataset, FORECAST_INPUT_FEATURES, stack_windows
from src.models.temporal_cnn import TemporalCNNForecaster
from src.utils.io import ensure_dir, write_dataframe, write_json
from src.utils.randomness import set_global_seed


DEEP_MODEL_BUILDERS = {
    "LSTM 24H Forecaster": lambda cfg, input_size: LSTMForecaster(
        input_size=input_size,
        hidden_size=int(cfg["hidden_size"]),
        num_layers=int(cfg["num_layers"]),
        dropout=float(cfg["dropout"]),
        horizon=int(cfg["horizon"]),
    ),
    "GRU 24H Forecaster": lambda cfg, input_size: GRUForecaster(
        input_size=input_size,
        hidden_size=int(cfg["hidden_size"]),
        num_layers=int(cfg["num_layers"]),
        dropout=float(cfg["dropout"]),
        horizon=int(cfg["horizon"]),
    ),
    "Temporal CNN 24H Forecaster": lambda cfg, input_size: TemporalCNNForecaster(
        input_size=input_size,
        channels=int(cfg["tcn_channels"]),
        kernel_size=int(cfg["tcn_kernel_size"]),
        horizon=int(cfg["horizon"]),
        dropout=float(cfg["dropout"]),
    ),
}


@dataclass
class DeepForecastArtifacts:
    model_name: str
    model_type: str
    state_dict: dict
    history_window: int
    horizon: int
    input_size: int
    feature_names: list[str]
    hyperparameters: dict
    metrics: dict[str, float]
    next_hour_metrics: dict[str, float]
    cv_next_hour_metrics: dict[str, float]
    benchmark_metrics: dict[str, float]
    cutoff_timestamps: dict[str, str]


def _cv_sequence_splits(sequence_df: pd.DataFrame, n_splits: int) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    unique_times = pd.Series(sorted(pd.to_datetime(sequence_df["anchor_timestamp"]).unique()))
    splitter = TimeSeriesSplit(n_splits=n_splits)
    splits = []
    for train_idx, validation_idx in splitter.split(unique_times):
        train_times = set(unique_times.iloc[train_idx])
        validation_times = set(unique_times.iloc[validation_idx])
        splits.append(
            (
                sequence_df[sequence_df["anchor_timestamp"].isin(train_times)].copy(),
                sequence_df[sequence_df["anchor_timestamp"].isin(validation_times)].copy(),
            )
        )
    return splits


def _train_model_instance(model_name: str, cfg: dict, input_size: int):
    return DEEP_MODEL_BUILDERS[model_name](cfg, input_size)


def _fit_and_predict(model_name: str, train_x: np.ndarray, train_y: np.ndarray, validation_x: np.ndarray, cfg: dict, random_state: int) -> tuple[dict, np.ndarray]:
    set_global_seed(random_state)
    model = _train_model_instance(model_name, cfg, train_x.shape[-1])
    optimizer = torch.optim.Adam(model.parameters(), lr=float(cfg["learning_rate"]))
    loss_fn = nn.MSELoss()
    train_loader = DataLoader(MultiHorizonDataset(train_x, train_y), batch_size=int(cfg["batch_size"]), shuffle=True)
    validation_loader = DataLoader(MultiHorizonDataset(validation_x, np.zeros((len(validation_x), int(cfg["horizon"])), dtype=np.float32)), batch_size=int(cfg["batch_size"]), shuffle=False)
    best_state: dict | None = None
    best_train = float("inf")
    patience = int(cfg["patience"])
    wait = 0
    for _ in range(int(cfg["epochs"])):
        model.train()
        batch_losses = []
        for batch_x, batch_y in train_loader:
            optimizer.zero_grad()
            prediction = model(batch_x)
            loss = loss_fn(prediction, batch_y)
            loss.backward()
            optimizer.step()
            batch_losses.append(float(loss.item()))
        current_train = float(np.mean(batch_losses))
        if current_train < best_train:
            best_train = current_train
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            wait = 0
        else:
            wait += 1
            if wait >= patience:
                break
    if best_state is None:
        raise RuntimeError(f"{model_name} did not produce a checkpoint.")
    model.load_state_dict(best_state)
    model.eval()
    predictions = []
    with torch.no_grad():
        for batch_x, _ in validation_loader:
            predictions.append(model(batch_x).cpu().numpy())
    return best_state, np.maximum(np.concatenate(predictions), 0.0)


def _flatten_horizon_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, float]:
    return regression_metrics(y_true.reshape(-1), y_pred.reshape(-1))


def _per_horizon_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> pd.DataFrame:
    rows = []
    for horizon_step in range(y_true.shape[1]):
        metrics = regression_metrics(y_true[:, horizon_step], y_pred[:, horizon_step])
        rows.append({"horizon_step": horizon_step + 1, **metrics})
    return pd.DataFrame(rows)


def _train_single_model(model_name: str, sequence_splits: dict[str, pd.DataFrame], settings: Settings) -> tuple[DeepForecastArtifacts, pd.DataFrame, pd.DataFrame]:
    cfg = settings.forecasting_model_cfg
    random_state = settings.random_state
    set_global_seed(random_state)

    train_df = sequence_splits["train"]
    validation_df = sequence_splits["validation"]
    test_df = sequence_splits["test"]
    cv_frame = pd.concat([train_df, validation_df], ignore_index=True).sort_values("anchor_timestamp").reset_index(drop=True)
    cv_splits = _cv_sequence_splits(cv_frame, int(settings.cv_cfg["n_splits"]))

    train_x = stack_windows(train_df, "input_window")
    train_y = stack_windows(train_df, "target_window")
    validation_x = stack_windows(validation_df, "input_window")
    validation_y = stack_windows(validation_df, "target_window")
    test_x = stack_windows(test_df, "input_window")
    test_y = stack_windows(test_df, "target_window")
    benchmark_y = stack_windows(test_df, "benchmark_window")
    cv_rows = []
    for fold_train_df, fold_validation_df in cv_splits:
        fold_train_x = stack_windows(fold_train_df, "input_window")
        fold_train_y = stack_windows(fold_train_df, "target_window")
        fold_validation_x = stack_windows(fold_validation_df, "input_window")
        fold_validation_y = stack_windows(fold_validation_df, "target_window")
        _, fold_pred = _fit_and_predict(model_name, fold_train_x, fold_train_y, fold_validation_x, cfg, random_state)
        cv_rows.append(regression_metrics(fold_validation_y[:, 0], fold_pred[:, 0]))

    best_state, _ = _fit_and_predict(model_name, train_x, train_y, validation_x, cfg, random_state)
    model = _train_model_instance(model_name, cfg, train_x.shape[-1])
    model.load_state_dict(best_state)
    model.eval()
    test_loader = DataLoader(MultiHorizonDataset(test_x, test_y), batch_size=int(cfg["batch_size"]), shuffle=False)
    forecast_batches = []
    with torch.no_grad():
        for batch_x, _ in test_loader:
            forecast_batches.append(model(batch_x).cpu().numpy())
    y_pred = np.maximum(np.concatenate(forecast_batches), 0.0)

    overall_metrics = _flatten_horizon_metrics(test_y, y_pred)
    next_hour_metrics = regression_metrics(test_y[:, 0], y_pred[:, 0])
    benchmark_metrics = _flatten_horizon_metrics(test_y, benchmark_y)
    cv_next_hour_metrics = {
        "cv_mae_mean": float(np.mean([item["mae"] for item in cv_rows])),
        "cv_mae_std": float(np.std([item["mae"] for item in cv_rows])),
        "cv_rmse_mean": float(np.mean([item["rmse"] for item in cv_rows])),
        "cv_rmse_std": float(np.std([item["rmse"] for item in cv_rows])),
        "cv_r2_mean": float(np.mean([item["r2"] for item in cv_rows])),
        "cv_r2_std": float(np.std([item["r2"] for item in cv_rows])),
    }
    per_horizon_df = _per_horizon_metrics(test_y, y_pred)
    benchmark_per_horizon_df = _per_horizon_metrics(test_y, benchmark_y).rename(
        columns={"mae": "benchmark_mae", "rmse": "benchmark_rmse", "r2": "benchmark_r2", "smape": "benchmark_smape"}
    )
    per_horizon_df["model_name"] = model_name
    per_horizon_df = per_horizon_df.merge(benchmark_per_horizon_df, on="horizon_step", how="left")

    prediction_rows = []
    for row_idx, (_, row) in enumerate(test_df.reset_index(drop=True).iterrows()):
        for horizon_step in range(y_pred.shape[1]):
            prediction_rows.append(
                {
                    "model_name": model_name,
                    "zone_id": int(row["zone_id"]),
                    "anchor_timestamp": row["anchor_timestamp"],
                    "target_timestamp": pd.Timestamp(row["target_start_timestamp"]) + pd.Timedelta(hours=horizon_step),
                    "horizon_step": horizon_step + 1,
                    "y_true": float(test_y[row_idx, horizon_step]),
                    "y_pred": float(y_pred[row_idx, horizon_step]),
                    "y_pred_benchmark": float(benchmark_y[row_idx, horizon_step]),
                }
            )
    predictions_df = pd.DataFrame(prediction_rows)

    hyperparameters = {
        "history_window": int(cfg["history_window"]),
        "horizon": int(cfg["horizon"]),
        "epochs": int(cfg["epochs"]),
        "batch_size": int(cfg["batch_size"]),
        "learning_rate": float(cfg["learning_rate"]),
        "hidden_size": int(cfg["hidden_size"]),
        "num_layers": int(cfg["num_layers"]),
        "dropout": float(cfg["dropout"]),
        "tcn_channels": int(cfg["tcn_channels"]),
        "tcn_kernel_size": int(cfg["tcn_kernel_size"]),
    }
    model_type = "temporal_cnn" if "Temporal CNN" in model_name else ("gru" if "GRU" in model_name else "lstm")
    artifacts = DeepForecastArtifacts(
        model_name=model_name,
        model_type=model_type,
        state_dict=best_state,
        history_window=int(cfg["history_window"]),
        horizon=int(cfg["horizon"]),
        input_size=train_x.shape[-1],
        feature_names=FORECAST_INPUT_FEATURES,
        hyperparameters=hyperparameters,
        metrics=overall_metrics,
        next_hour_metrics=next_hour_metrics,
        cv_next_hour_metrics=cv_next_hour_metrics,
        benchmark_metrics=benchmark_metrics,
        cutoff_timestamps={
            "train_end": str(max(pd.to_datetime(train_df["anchor_timestamp"]))),
            "validation_end": str(max(pd.to_datetime(validation_df["anchor_timestamp"]))),
            "test_end": str(max(pd.to_datetime(test_df["anchor_timestamp"]))),
        },
    )
    return artifacts, predictions_df, per_horizon_df


def train_deep_forecasters(sequence_splits: dict[str, pd.DataFrame], settings: Settings) -> dict:
    artifacts_list = []
    prediction_frames = []
    horizon_frames = []
    for model_name in DEEP_MODEL_BUILDERS:
        artifacts, predictions_df, per_horizon_df = _train_single_model(model_name, sequence_splits, settings)
        artifacts_list.append(artifacts)
        prediction_frames.append(predictions_df)
        horizon_frames.append(per_horizon_df)

    metrics_df = pd.DataFrame(
        [
            {"model_name": item.model_name, "benchmark_name": "Previous 24 Hours Naive", **item.metrics}
            for item in artifacts_list
        ]
        + [
            {
                "model_name": "Previous 24 Hours Naive",
                "benchmark_name": "Previous 24 Hours Naive",
                **artifacts_list[0].benchmark_metrics,
            }
        ]
    )
    next_hour_df = pd.DataFrame(
        [
            {
                "model_name": item.model_name,
                "model_family": "deep_sequence",
                **item.cv_next_hour_metrics,
                "validation_mae": np.nan,
                "validation_rmse": np.nan,
                "validation_r2": np.nan,
                "validation_smape": np.nan,
                "test_mae": item.next_hour_metrics["mae"],
                "test_rmse": item.next_hour_metrics["rmse"],
                "test_r2": item.next_hour_metrics["r2"],
                "test_smape": item.next_hour_metrics["smape"],
            }
            for item in artifacts_list
        ]
    )
    return {
        "artifacts": artifacts_list,
        "metrics_df": metrics_df,
        "next_hour_df": next_hour_df,
        "predictions_df": pd.concat(prediction_frames, ignore_index=True),
        "per_horizon_df": pd.concat(horizon_frames, ignore_index=True),
    }


def save_deep_forecasters(outputs: dict, settings: Settings) -> dict:
    artifacts_dir = settings.path("artifacts_dir")
    ensure_dir(artifacts_dir / "models")
    metrics_path = artifacts_dir / "metrics" / "forecast_metrics.csv"
    horizon_metrics_path = artifacts_dir / "metrics" / "forecast_horizon_metrics.csv"
    predictions_path = artifacts_dir / "predictions" / "forecast_test_predictions.parquet"
    manifest_path = artifacts_dir / "metadata" / "forecast_manifest.json"

    write_dataframe(outputs["metrics_df"], metrics_path)
    write_dataframe(outputs["per_horizon_df"], horizon_metrics_path)
    write_dataframe(outputs["predictions_df"], predictions_path)

    manifest = {
        "models": [],
        "best_forecast_model": outputs["metrics_df"].sort_values("rmse").iloc[0]["model_name"],
    }
    for artifact in outputs["artifacts"]:
        safe_name = artifact.model_name.lower().replace(" ", "_").replace("-", "_")
        model_path = artifacts_dir / "models" / f"{safe_name}.pt"
        torch.save(
            {
                "model_name": artifact.model_name,
                "model_type": artifact.model_type,
                "state_dict": artifact.state_dict,
                "history_window": artifact.history_window,
                "horizon": artifact.horizon,
                "input_size": artifact.input_size,
                "feature_names": artifact.feature_names,
                "hyperparameters": artifact.hyperparameters,
            },
            model_path,
        )
        manifest["models"].append(
            {
                "model_name": artifact.model_name,
                "model_type": artifact.model_type,
                "path": str(model_path.relative_to(artifacts_dir)),
            }
        )

    write_json(manifest, manifest_path)
    return {
        "metrics_path": metrics_path,
        "horizon_metrics_path": horizon_metrics_path,
        "predictions_path": predictions_path,
        "manifest_path": manifest_path,
        "best_forecast_model": manifest["best_forecast_model"],
        "next_hour_df": outputs["next_hour_df"],
    }


def build_deep_model(payload: dict):
    model_type = payload["model_type"]
    hyper = payload["hyperparameters"]
    input_size = int(payload["input_size"])
    horizon = int(payload["horizon"])
    if model_type == "lstm":
        return LSTMForecaster(input_size=input_size, hidden_size=int(hyper["hidden_size"]), num_layers=int(hyper["num_layers"]), dropout=float(hyper["dropout"]), horizon=horizon)
    if model_type == "gru":
        return GRUForecaster(input_size=input_size, hidden_size=int(hyper["hidden_size"]), num_layers=int(hyper["num_layers"]), dropout=float(hyper["dropout"]), horizon=horizon)
    return TemporalCNNForecaster(input_size=input_size, channels=int(hyper["tcn_channels"]), kernel_size=int(hyper["tcn_kernel_size"]), horizon=horizon, dropout=float(hyper["dropout"]))


def load_deep_model(model_path: Path):
    payload = torch.load(model_path, map_location="cpu")
    model = build_deep_model(payload)
    model.load_state_dict(payload["state_dict"])
    model.eval()
    return model, payload
