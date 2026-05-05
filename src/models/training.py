from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from sklearn.base import clone
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from src.config.settings import Settings
from src.evaluation.metrics import regression_metrics
from src.evaluation.splits import time_based_split
from src.features.engineering import ALL_FEATURES, BASELINE_COMPARISON_FEATURES, NUMERIC_FEATURES, TARGET_COLUMN
from src.models.baselines import SeasonalNaiveRegressor
from src.models.lstm_model import LSTMForecaster
from src.models.gru_model import GRUForecaster
from src.models.tabular import build_preprocessor, build_tabular_model_registry
from src.models.temporal_cnn import TemporalCNNForecaster
from src.utils.io import ensure_dir, save_model, write_dataframe, write_json
from src.utils.logging_utils import get_logger
from src.utils.randomness import set_global_seed


LOGGER = get_logger(__name__)
CORE_MODEL_NAMES = [
    "Seasonal Naive",
    "Ridge Regression",
    "Random Forest",
    "Gradient Boosting",
    "XGBoost",
    "LSTM",
    "GRU",
    "Temporal CNN",
]
SEQUENCE_MODEL_BUILDERS = {
    "LSTM": lambda input_size, cfg: LSTMForecaster(
        input_size=input_size,
        hidden_size=int(cfg["hidden_size"]),
        num_layers=int(cfg["num_layers"]),
        dropout=float(cfg["dropout"]),
        horizon=1,
    ),
    "GRU": lambda input_size, cfg: GRUForecaster(
        input_size=input_size,
        hidden_size=int(cfg["hidden_size"]),
        num_layers=int(cfg["num_layers"]),
        dropout=float(cfg["dropout"]),
        horizon=1,
    ),
    "Temporal CNN": lambda input_size, cfg: TemporalCNNForecaster(
        input_size=input_size,
        channels=int(cfg.get("tcn_channels", cfg["hidden_size"])),
        kernel_size=int(cfg.get("tcn_kernel_size", 3)),
        horizon=1,
        dropout=float(cfg["dropout"]),
    ),
}


@dataclass
class DeepModelArtifact:
    model_name: str
    state_dict: dict
    input_size: int
    history_window: int
    feature_names: list[str]
    hyperparameters: dict


def _downsample_feature_frame(feature_df: pd.DataFrame, max_rows: int) -> pd.DataFrame:
    if max_rows <= 0 or len(feature_df) <= max_rows:
        return feature_df
    unique_times = pd.Series(sorted(pd.to_datetime(feature_df["timestamp"]).unique()))
    keep_count = max(2, int(max_rows / max(feature_df["zone_id"].nunique(), 1)))
    sampled_times = unique_times.iloc[np.linspace(0, len(unique_times) - 1, num=min(keep_count, len(unique_times)), dtype=int)]
    sampled = feature_df[feature_df["timestamp"].isin(set(sampled_times))].copy()
    return sampled.sort_values(["timestamp", "zone_id"]).reset_index(drop=True)


def _time_series_cv_splits(frame: pd.DataFrame, n_splits: int) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    unique_times = pd.Series(sorted(pd.to_datetime(frame["timestamp"]).unique()))
    splitter = TimeSeriesSplit(n_splits=n_splits)
    splits = []
    for train_idx, validation_idx in splitter.split(unique_times):
        train_times = set(unique_times.iloc[train_idx])
        validation_times = set(unique_times.iloc[validation_idx])
        splits.append(
            (
                frame[frame["timestamp"].isin(train_times)].copy(),
                frame[frame["timestamp"].isin(validation_times)].copy(),
            )
        )
    return splits


def _tabular_registry(random_state: int) -> dict[str, object]:
    registry = build_tabular_model_registry(random_state)
    return {name: model for name, model in registry.items() if name in CORE_MODEL_NAMES}


def _build_sequences(frame: pd.DataFrame, feature_columns: list[str], history_window: int) -> tuple[np.ndarray, np.ndarray, list[pd.Timestamp], list[int]]:
    sequences: list[np.ndarray] = []
    targets: list[float] = []
    timestamps: list[pd.Timestamp] = []
    zones: list[int] = []
    ordered = frame.sort_values(["zone_id", "timestamp"]).reset_index(drop=True)
    for zone_id, zone_df in ordered.groupby("zone_id"):
        values = zone_df[feature_columns].to_numpy(dtype=np.float32)
        target_values = zone_df[TARGET_COLUMN].to_numpy(dtype=np.float32)
        ts_values = pd.to_datetime(zone_df["timestamp"]).tolist()
        if len(zone_df) <= history_window:
            continue
        for start_idx in range(0, len(zone_df) - history_window):
            end_idx = start_idx + history_window
            sequences.append(values[start_idx:end_idx])
            targets.append(float(target_values[end_idx - 1]))
            timestamps.append(ts_values[end_idx - 1])
            zones.append(int(zone_id))
    if not sequences:
        return np.empty((0, history_window, len(feature_columns)), dtype=np.float32), np.empty((0,), dtype=np.float32), [], []
    return np.stack(sequences).astype(np.float32), np.asarray(targets, dtype=np.float32), timestamps, zones


def _fit_deep_model(model_name: str, train_x: np.ndarray, train_y: np.ndarray, validation_x: np.ndarray, validation_y: np.ndarray, cfg: dict, random_state: int) -> tuple[dict, np.ndarray]:
    set_global_seed(random_state)
    model = SEQUENCE_MODEL_BUILDERS[model_name](train_x.shape[-1], cfg)
    optimizer = torch.optim.Adam(model.parameters(), lr=float(cfg["learning_rate"]))
    loss_fn = nn.MSELoss()
    train_loader = DataLoader(TensorDataset(torch.tensor(train_x), torch.tensor(train_y[:, None])), batch_size=int(cfg["batch_size"]), shuffle=False)
    validation_loader = DataLoader(TensorDataset(torch.tensor(validation_x), torch.tensor(validation_y[:, None])), batch_size=int(cfg["batch_size"]), shuffle=False)
    best_state: dict | None = None
    best_validation = float("inf")
    patience = int(cfg["patience"])
    wait = 0

    for _ in range(int(cfg["epochs"])):
        model.train()
        for batch_x, batch_y in train_loader:
            optimizer.zero_grad()
            prediction = model(batch_x)
            loss = loss_fn(prediction, batch_y)
            loss.backward()
            optimizer.step()
        model.eval()
        validation_losses = []
        with torch.no_grad():
            for batch_x, batch_y in validation_loader:
                prediction = model(batch_x)
                validation_losses.append(float(loss_fn(prediction, batch_y).item()))
        current_validation = float(np.mean(validation_losses))
        if current_validation < best_validation:
            best_validation = current_validation
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
    validation_predictions: list[np.ndarray] = []
    with torch.no_grad():
        for batch_x, _ in validation_loader:
            validation_predictions.append(model(batch_x).cpu().numpy().reshape(-1))
    return best_state, np.maximum(np.concatenate(validation_predictions), 0.0)


def _train_deep_models(
    train_df: pd.DataFrame,
    validation_df: pd.DataFrame,
    test_df: pd.DataFrame,
    cv_splits: list[tuple[pd.DataFrame, pd.DataFrame]],
    sequence_features: list[str],
    settings: Settings,
    scenario: str,
) -> tuple[list[dict], list[pd.DataFrame], dict[str, DeepModelArtifact]]:
    cfg = {**settings.sequence_model_cfg, **settings.forecasting_model_cfg}
    history_window = int(settings.feature_cfg.get("history_window", 24))
    metrics_rows: list[dict] = []
    prediction_frames: list[pd.DataFrame] = []
    artifacts: dict[str, DeepModelArtifact] = {}

    train_x, train_y, _, _ = _build_sequences(train_df, sequence_features, history_window)
    validation_x, validation_y, _, _ = _build_sequences(validation_df, sequence_features, history_window)
    test_x, test_y, test_timestamps, test_zones = _build_sequences(test_df, sequence_features, history_window)
    if min(len(train_y), len(validation_y), len(test_y)) == 0:
        raise ValueError("Not enough samples to train sequence models with the configured history window.")

    for model_name in SEQUENCE_MODEL_BUILDERS:
        LOGGER.info("Training %s (%s)", model_name, scenario)
        cv_metrics = []
        for fold_train_df, fold_validation_df in cv_splits:
            fold_train_x, fold_train_y, _, _ = _build_sequences(fold_train_df, sequence_features, history_window)
            fold_validation_x, fold_validation_y, _, _ = _build_sequences(fold_validation_df, sequence_features, history_window)
            if min(len(fold_train_y), len(fold_validation_y)) == 0:
                continue
            _, fold_pred = _fit_deep_model(model_name, fold_train_x, fold_train_y, fold_validation_x, fold_validation_y, cfg, settings.random_state)
            cv_metrics.append(regression_metrics(fold_validation_y, fold_pred))
        best_state, validation_pred = _fit_deep_model(model_name, train_x, train_y, validation_x, validation_y, cfg, settings.random_state)
        model = SEQUENCE_MODEL_BUILDERS[model_name](train_x.shape[-1], cfg)
        model.load_state_dict(best_state)
        model.eval()
        test_loader = DataLoader(TensorDataset(torch.tensor(test_x), torch.tensor(test_y[:, None])), batch_size=int(cfg["batch_size"]), shuffle=False)
        test_predictions: list[np.ndarray] = []
        with torch.no_grad():
            for batch_x, _ in test_loader:
                test_predictions.append(model(batch_x).cpu().numpy().reshape(-1))
        test_pred = np.maximum(np.concatenate(test_predictions), 0.0)
        validation_metrics = regression_metrics(validation_y, validation_pred)
        test_metrics = regression_metrics(test_y, test_pred)
        cv_mae = [item["mae"] for item in cv_metrics] if cv_metrics else [np.nan]
        cv_rmse = [item["rmse"] for item in cv_metrics] if cv_metrics else [np.nan]
        cv_r2 = [item["r2"] for item in cv_metrics] if cv_metrics else [np.nan]
        metrics_rows.append(
            {
                "model_name": model_name,
                "model_family": "deep_sequence",
                "scenario": scenario,
                "cv_mae_mean": float(np.nanmean(cv_mae)),
                "cv_mae_std": float(np.nanstd(cv_mae)),
                "cv_rmse_mean": float(np.nanmean(cv_rmse)),
                "cv_rmse_std": float(np.nanstd(cv_rmse)),
                "cv_r2_mean": float(np.nanmean(cv_r2)),
                "cv_r2_std": float(np.nanstd(cv_r2)),
                "validation_mae": validation_metrics["mae"],
                "validation_rmse": validation_metrics["rmse"],
                "validation_r2": validation_metrics["r2"],
                "validation_smape": validation_metrics["smape"],
                "test_mae": test_metrics["mae"],
                "test_rmse": test_metrics["rmse"],
                "test_r2": test_metrics["r2"],
                "test_smape": test_metrics["smape"],
            }
        )
        prediction_frames.append(
            pd.DataFrame(
                {
                    "timestamp": test_timestamps,
                    "zone_id": test_zones,
                    "model_name": model_name,
                    "scenario": scenario,
                    "y_true": test_y,
                    "y_pred": test_pred,
                }
            )
        )
        artifacts[model_name] = DeepModelArtifact(
            model_name=model_name,
            state_dict=best_state,
            input_size=train_x.shape[-1],
            history_window=history_window,
            feature_names=sequence_features,
            hyperparameters={
                "hidden_size": int(cfg["hidden_size"]),
                "num_layers": int(cfg["num_layers"]),
                "dropout": float(cfg["dropout"]),
                "learning_rate": float(cfg["learning_rate"]),
                "batch_size": int(cfg["batch_size"]),
                "epochs": int(cfg["epochs"]),
                "history_window": history_window,
                "tcn_channels": int(cfg.get("tcn_channels", cfg["hidden_size"])),
                "tcn_kernel_size": int(cfg.get("tcn_kernel_size", 3)),
            },
        )
    return metrics_rows, prediction_frames, artifacts


def _train_single_scenario(feature_df: pd.DataFrame, settings: Settings, scenario: str, feature_columns: list[str]) -> dict:
    set_global_seed(settings.random_state)
    feature_df = _downsample_feature_frame(feature_df, int(settings.data_cfg.get("max_training_rows", 0)))
    split_cfg = settings.split_cfg
    splits = time_based_split(
        df=feature_df,
        timestamp_col="timestamp",
        train_fraction=float(split_cfg["train_fraction"]),
        validation_fraction=float(split_cfg["validation_fraction"]),
    )
    train_df = splits["train"]
    validation_df = splits["validation"]
    test_df = splits["test"]
    cv_splits = _time_series_cv_splits(pd.concat([train_df, validation_df]).sort_values("timestamp"), int(settings.cv_cfg["n_splits"]))

    metrics_rows: list[dict] = []
    prediction_frames: list[pd.DataFrame] = []
    fitted_models: dict[str, object] = {}

    for model_name, estimator in _tabular_registry(settings.random_state).items():
        LOGGER.info("Training %s (%s)", model_name, scenario)
        numeric_cols = [column for column in feature_columns if column in NUMERIC_FEATURES]
        categorical_cols = [column for column in feature_columns if column not in numeric_cols]
        x_train = train_df[feature_columns].copy()
        y_train = train_df[TARGET_COLUMN].copy()
        x_validation = validation_df[feature_columns].copy()
        y_validation = validation_df[TARGET_COLUMN].copy()
        x_test = test_df[feature_columns].copy()
        y_test = test_df[TARGET_COLUMN].copy()

        cv_metrics = []
        for fold_train_df, fold_validation_df in cv_splits:
            fold_x_train = fold_train_df[feature_columns].copy()
            fold_y_train = fold_train_df[TARGET_COLUMN].copy()
            fold_x_validation = fold_validation_df[feature_columns].copy()
            fold_y_validation = fold_validation_df[TARGET_COLUMN].copy()
            if isinstance(estimator, SeasonalNaiveRegressor):
                fold_model = clone(estimator)
            else:
                preprocessor = build_preprocessor(numeric_cols=numeric_cols, categorical_cols=categorical_cols)
                fold_model = Pipeline(steps=[("preprocessor", preprocessor), ("model", clone(estimator))])
            fold_model.fit(fold_x_train, fold_y_train)
            fold_pred = np.maximum(fold_model.predict(fold_x_validation), 0.0)
            cv_metrics.append(regression_metrics(fold_y_validation, fold_pred))

        if isinstance(estimator, SeasonalNaiveRegressor):
            fitted = clone(estimator)
        else:
            preprocessor = build_preprocessor(numeric_cols=numeric_cols, categorical_cols=categorical_cols)
            fitted = Pipeline(steps=[("preprocessor", preprocessor), ("model", clone(estimator))])
        fitted.fit(x_train, y_train)
        validation_pred = np.maximum(fitted.predict(x_validation), 0.0)
        test_pred = np.maximum(fitted.predict(x_test), 0.0)
        validation_metrics = regression_metrics(y_validation, validation_pred)
        test_metrics = regression_metrics(y_test, test_pred)

        metrics_rows.append(
            {
                "model_name": model_name,
                "model_family": "tabular",
                "scenario": scenario,
                "cv_mae_mean": float(np.mean([item["mae"] for item in cv_metrics])),
                "cv_mae_std": float(np.std([item["mae"] for item in cv_metrics])),
                "cv_rmse_mean": float(np.mean([item["rmse"] for item in cv_metrics])),
                "cv_rmse_std": float(np.std([item["rmse"] for item in cv_metrics])),
                "cv_r2_mean": float(np.mean([item["r2"] for item in cv_metrics])),
                "cv_r2_std": float(np.std([item["r2"] for item in cv_metrics])),
                "validation_mae": validation_metrics["mae"],
                "validation_rmse": validation_metrics["rmse"],
                "validation_r2": validation_metrics["r2"],
                "validation_smape": validation_metrics["smape"],
                "test_mae": test_metrics["mae"],
                "test_rmse": test_metrics["rmse"],
                "test_r2": test_metrics["r2"],
                "test_smape": test_metrics["smape"],
            }
        )
        prediction_frames.append(
            pd.DataFrame(
                {
                    "timestamp": test_df["timestamp"].to_numpy(),
                    "zone_id": test_df["zone_id"].to_numpy(),
                    "model_name": model_name,
                    "scenario": scenario,
                    "y_true": y_test.to_numpy(),
                    "y_pred": test_pred,
                }
            )
        )
        fitted_models[model_name] = fitted

    sequence_feature_columns = [column for column in feature_columns if column in NUMERIC_FEATURES]
    deep_metrics_rows, deep_prediction_frames, deep_artifacts = _train_deep_models(
        train_df=train_df,
        validation_df=validation_df,
        test_df=test_df,
        cv_splits=cv_splits,
        sequence_features=sequence_feature_columns,
        settings=settings,
        scenario=scenario,
    )
    metrics_df = pd.DataFrame(metrics_rows + deep_metrics_rows).sort_values(["cv_rmse_mean", "test_rmse", "test_mae"]).reset_index(drop=True)
    predictions_df = pd.concat(prediction_frames + deep_prediction_frames, ignore_index=True)
    return {
        "metrics_df": metrics_df,
        "predictions_df": predictions_df,
        "fitted_models": fitted_models,
        "deep_artifacts": deep_artifacts,
        "splits": splits,
        "feature_columns": feature_columns,
    }


def train_model_comparison(feature_df: pd.DataFrame, settings: Settings) -> dict:
    base_output = _train_single_scenario(feature_df, settings, scenario="base", feature_columns=BASELINE_COMPARISON_FEATURES)
    contextual_output = _train_single_scenario(feature_df, settings, scenario="contextual", feature_columns=ALL_FEATURES)
    comparison_df = (
        base_output["metrics_df"][["model_name", "test_mae", "test_rmse", "test_r2"]]
        .rename(columns={"test_mae": "base_test_mae", "test_rmse": "base_test_rmse", "test_r2": "base_test_r2"})
        .merge(
            contextual_output["metrics_df"][["model_name", "test_mae", "test_rmse", "test_r2"]],
            on="model_name",
            how="inner",
        )
        .rename(columns={"test_mae": "context_test_mae", "test_rmse": "context_test_rmse", "test_r2": "context_test_r2"})
    )
    comparison_df["rmse_delta"] = comparison_df["context_test_rmse"] - comparison_df["base_test_rmse"]
    comparison_df["mae_delta"] = comparison_df["context_test_mae"] - comparison_df["base_test_mae"]
    comparison_df["r2_delta"] = comparison_df["context_test_r2"] - comparison_df["base_test_r2"]
    comparison_df["improved_with_context"] = comparison_df["rmse_delta"] < 0
    return {"base": base_output, "contextual": contextual_output, "comparison_df": comparison_df}


def train_tabular_models(feature_df: pd.DataFrame, settings: Settings) -> dict:
    set_global_seed(settings.random_state)
    feature_df = _downsample_feature_frame(feature_df, int(settings.data_cfg.get("max_training_rows", 0)))
    split_cfg = settings.split_cfg
    splits = time_based_split(
        df=feature_df,
        timestamp_col="timestamp",
        train_fraction=float(split_cfg["train_fraction"]),
        validation_fraction=float(split_cfg["validation_fraction"]),
    )
    train_df = splits["train"]
    validation_df = splits["validation"]
    test_df = splits["test"]
    cv_splits = _time_series_cv_splits(pd.concat([train_df, validation_df]).sort_values("timestamp"), int(settings.cv_cfg["n_splits"]))

    metrics_rows: list[dict] = []
    prediction_frames: list[pd.DataFrame] = []
    fitted_models: dict[str, object] = {}
    feature_columns = ALL_FEATURES
    numeric_cols = [column for column in feature_columns if column in NUMERIC_FEATURES]
    categorical_cols = [column for column in feature_columns if column not in numeric_cols]

    for model_name, estimator in _tabular_registry(settings.random_state).items():
        x_train = train_df[feature_columns].copy()
        y_train = train_df[TARGET_COLUMN].copy()
        x_validation = validation_df[feature_columns].copy()
        y_validation = validation_df[TARGET_COLUMN].copy()
        x_test = test_df[feature_columns].copy()
        y_test = test_df[TARGET_COLUMN].copy()
        cv_metrics = []
        for fold_train_df, fold_validation_df in cv_splits:
            fold_x_train = fold_train_df[feature_columns].copy()
            fold_y_train = fold_train_df[TARGET_COLUMN].copy()
            fold_x_validation = fold_validation_df[feature_columns].copy()
            fold_y_validation = fold_validation_df[TARGET_COLUMN].copy()
            if isinstance(estimator, SeasonalNaiveRegressor):
                fold_model = clone(estimator)
            else:
                preprocessor = build_preprocessor(numeric_cols=numeric_cols, categorical_cols=categorical_cols)
                fold_model = Pipeline(steps=[("preprocessor", preprocessor), ("model", clone(estimator))])
            fold_model.fit(fold_x_train, fold_y_train)
            fold_pred = np.maximum(fold_model.predict(fold_x_validation), 0.0)
            cv_metrics.append(regression_metrics(fold_y_validation, fold_pred))
        if isinstance(estimator, SeasonalNaiveRegressor):
            fitted = clone(estimator)
        else:
            preprocessor = build_preprocessor(numeric_cols=numeric_cols, categorical_cols=categorical_cols)
            fitted = Pipeline(steps=[("preprocessor", preprocessor), ("model", clone(estimator))])
        fitted.fit(x_train, y_train)
        validation_pred = np.maximum(fitted.predict(x_validation), 0.0)
        test_pred = np.maximum(fitted.predict(x_test), 0.0)
        validation_metrics = regression_metrics(y_validation, validation_pred)
        test_metrics = regression_metrics(y_test, test_pred)
        metrics_rows.append(
            {
                "model_name": model_name,
                "model_family": "tabular",
                "cv_mae_mean": float(np.mean([item["mae"] for item in cv_metrics])),
                "cv_mae_std": float(np.std([item["mae"] for item in cv_metrics])),
                "cv_rmse_mean": float(np.mean([item["rmse"] for item in cv_metrics])),
                "cv_rmse_std": float(np.std([item["rmse"] for item in cv_metrics])),
                "cv_r2_mean": float(np.mean([item["r2"] for item in cv_metrics])),
                "cv_r2_std": float(np.std([item["r2"] for item in cv_metrics])),
                "validation_mae": validation_metrics["mae"],
                "validation_rmse": validation_metrics["rmse"],
                "validation_r2": validation_metrics["r2"],
                "validation_smape": validation_metrics["smape"],
                "test_mae": test_metrics["mae"],
                "test_rmse": test_metrics["rmse"],
                "test_r2": test_metrics["r2"],
                "test_smape": test_metrics["smape"],
            }
        )
        prediction_frames.append(
            pd.DataFrame(
                {
                    "timestamp": test_df["timestamp"].to_numpy(),
                    "zone_id": test_df["zone_id"].to_numpy(),
                    "model_name": model_name,
                    "y_true": y_test.to_numpy(),
                    "y_pred": test_pred,
                }
            )
        )
        fitted_models[model_name] = fitted
    metrics_df = pd.DataFrame(metrics_rows).sort_values(["cv_rmse_mean", "test_rmse"]).reset_index(drop=True)
    predictions_df = pd.concat(prediction_frames, ignore_index=True)
    return {"metrics_df": metrics_df, "predictions_df": predictions_df, "fitted_models": fitted_models, "splits": splits}


def save_training_outputs(training_output: dict, settings: Settings) -> dict:
    artifacts_dir = settings.path("artifacts_dir")
    reports_dir = settings.path("reports_dir")
    ensure_dir(artifacts_dir / "models")
    ensure_dir(artifacts_dir / "metrics")
    ensure_dir(artifacts_dir / "predictions")
    ensure_dir(reports_dir / "tables")

    base_metrics = training_output["base"]["metrics_df"].copy()
    contextual_metrics = training_output["contextual"]["metrics_df"].copy()
    comparison_df = training_output["comparison_df"].copy()
    contextual_predictions = training_output["contextual"]["predictions_df"].copy()
    base_predictions = training_output["base"]["predictions_df"].copy()
    best_model_name = contextual_metrics.sort_values(["cv_rmse_mean", "test_rmse"]).iloc[0]["model_name"]
    best_tabular_model = contextual_metrics[contextual_metrics["model_family"] == "tabular"].sort_values(["cv_rmse_mean", "test_rmse"]).iloc[0]["model_name"]

    write_dataframe(contextual_metrics, artifacts_dir / "metrics" / "model_metrics.csv")
    write_dataframe(contextual_metrics, artifacts_dir / "metrics" / "model_metrics_contextual.csv")
    write_dataframe(base_metrics, artifacts_dir / "metrics" / "model_metrics_base.csv")
    write_dataframe(comparison_df, artifacts_dir / "metrics" / "contextual_comparison.csv")
    write_dataframe(contextual_metrics, reports_dir / "tables" / "model_comparison.csv")
    write_dataframe(base_metrics, reports_dir / "tables" / "model_comparison_base.csv")
    write_dataframe(comparison_df, reports_dir / "tables" / "contextual_comparison.csv")
    write_dataframe(contextual_predictions, artifacts_dir / "predictions" / "test_predictions.parquet")
    write_dataframe(contextual_predictions, artifacts_dir / "predictions" / "test_predictions_contextual.parquet")
    write_dataframe(base_predictions, artifacts_dir / "predictions" / "test_predictions_base.parquet")

    for model_name, model in training_output["contextual"]["fitted_models"].items():
        safe_name = model_name.lower().replace(" ", "_")
        save_model(model, artifacts_dir / "models" / f"{safe_name}.joblib")
    for model_name, artifact in training_output["contextual"]["deep_artifacts"].items():
        safe_name = model_name.lower().replace(" ", "_")
        torch.save(
            {
                "model_name": artifact.model_name,
                "state_dict": artifact.state_dict,
                "input_size": artifact.input_size,
                "history_window": artifact.history_window,
                "feature_names": artifact.feature_names,
                "hyperparameters": artifact.hyperparameters,
            },
            artifacts_dir / "models" / f"{safe_name}.pt",
        )

    split_info = {}
    for split_name, split_df in training_output["contextual"]["splits"].items():
        timestamps = pd.to_datetime(split_df["timestamp"])
        split_info[split_name] = {"start": str(timestamps.min()), "end": str(timestamps.max()), "rows": int(len(split_df))}
    manifest = {
        "dataset_path": str(settings.path("processed_data_dir") / "zone_hour_features.parquet"),
        "target_column": TARGET_COLUMN,
        "target_definition": "Next-hour yellow taxi pickup count by NYC TLC taxi zone, used as a waiting-pressure proxy.",
        "same_underlying_dataset": True,
        "base_feature_columns": BASELINE_COMPARISON_FEATURES,
        "contextual_feature_columns": ALL_FEATURES,
        "sequence_feature_columns": [column for column in ALL_FEATURES if column in NUMERIC_FEATURES],
        "core_models": CORE_MODEL_NAMES,
        "best_contextual_model": best_model_name,
        "best_tabular_model": best_tabular_model,
        "time_split_policy": "Chronological train/validation/test split plus TimeSeriesSplit cross-validation on the combined train+validation window.",
        "splits": split_info,
    }
    write_json(manifest, artifacts_dir / "metadata" / "training_manifest.json")
    return {"best_model_name": best_model_name, "best_tabular_model": best_tabular_model}
