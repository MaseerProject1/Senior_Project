from __future__ import annotations

import os
from pathlib import Path

import joblib

os.environ.setdefault("MPLCONFIGDIR", str(Path.cwd() / ".mplconfig"))

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

from src.utils.io import ensure_dir


sns.set_theme(style="whitegrid")


def plot_model_comparison(metrics_df: pd.DataFrame, output_dir: Path) -> Path:
    ensure_dir(output_dir)
    fig, ax = plt.subplots(figsize=(10, 5))
    ordered = metrics_df.sort_values("test_rmse")
    sns.barplot(data=ordered, x="test_rmse", y="model_name", hue="model_name", dodge=False, legend=False, ax=ax, palette="crest")
    ax.set_title("Eight-Model Comparison on Chronological Test Split")
    ax.set_xlabel("RMSE")
    ax.set_ylabel("")
    fig.tight_layout()
    path = output_dir / "model_comparison_rmse.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_contextual_comparison(comparison_df: pd.DataFrame, output_dir: Path) -> Path:
    ensure_dir(output_dir)
    fig, ax = plt.subplots(figsize=(10, 5))
    ordered = comparison_df.sort_values("rmse_delta")
    palette = ["#2a9d8f" if value < 0 else "#e76f51" for value in ordered["rmse_delta"]]
    ax.barh(ordered["model_name"], ordered["rmse_delta"], color=palette)
    ax.axvline(0.0, color="black", linestyle="--", linewidth=1)
    ax.set_title("Contextual Data Impact on Test RMSE")
    ax.set_xlabel("Contextual RMSE - Base RMSE")
    ax.set_ylabel("")
    fig.tight_layout()
    path = output_dir / "contextual_comparison_rmse_delta.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_hourly_demand(feature_df: pd.DataFrame, output_dir: Path) -> Path:
    ensure_dir(output_dir)
    hourly = feature_df.groupby("hour", as_index=False)["pickup_count"].mean()
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.lineplot(data=hourly, x="hour", y="pickup_count", marker="o", ax=ax)
    ax.set_title("Average Hourly Pickup Demand")
    ax.set_xlabel("Hour of day")
    ax.set_ylabel("Average pickup count")
    fig.tight_layout()
    path = output_dir / "average_hourly_pickups.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_demand_vs_weather(feature_df: pd.DataFrame, output_dir: Path) -> Path:
    ensure_dir(output_dir)
    subset = feature_df.copy()
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.scatterplot(data=subset, x="temperature", y="pickup_count", hue="rain_indicator", alpha=0.35, ax=ax)
    ax.set_title("Demand vs Weather")
    ax.set_xlabel("Temperature")
    ax.set_ylabel("Pickup count")
    fig.tight_layout()
    path = output_dir / "demand_vs_weather.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_demand_vs_events(feature_df: pd.DataFrame, output_dir: Path) -> Path:
    ensure_dir(output_dir)
    timeline = (
        feature_df.groupby("timestamp", as_index=False)
        .agg(pickup_count=("pickup_count", "sum"), event_intensity_score=("event_intensity_score", "mean"), disruption_score=("disruption_score", "mean"))
        .sort_values("timestamp")
    )
    fig, ax = plt.subplots(figsize=(12, 5))
    sns.lineplot(data=timeline, x="timestamp", y="pickup_count", ax=ax, label="Demand")
    sns.lineplot(data=timeline, x="timestamp", y="event_intensity_score", ax=ax, label="Event intensity")
    sns.lineplot(data=timeline, x="timestamp", y="disruption_score", ax=ax, label="Disruption score")
    ax.set_title("Demand vs Event Timeline")
    ax.set_xlabel("Timestamp")
    ax.set_ylabel("Scaled signal")
    ax.tick_params(axis="x", rotation=30)
    fig.tight_layout()
    path = output_dir / "demand_vs_event_timeline.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_zone_heatmap(feature_df: pd.DataFrame, output_dir: Path, top_n: int = 15) -> Path:
    ensure_dir(output_dir)
    top_zones = feature_df.groupby("zone_name", as_index=False)["pickup_count"].sum().nlargest(top_n, "pickup_count")["zone_name"]
    subset = feature_df[feature_df["zone_name"].isin(top_zones)]
    heatmap_data = subset.pivot_table(index="zone_name", columns="hour", values="pickup_count", aggfunc="mean").fillna(0)
    fig, ax = plt.subplots(figsize=(12, 8))
    sns.heatmap(heatmap_data, cmap="mako", ax=ax)
    ax.set_title("Zone-Hour Demand Heatmap for Top Pickup Zones")
    fig.tight_layout()
    path = output_dir / "zone_hour_heatmap.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_prediction_scatter(predictions_df: pd.DataFrame, output_dir: Path, model_name: str) -> Path:
    ensure_dir(output_dir)
    subset = predictions_df[predictions_df["model_name"] == model_name].copy()
    fig, ax = plt.subplots(figsize=(7, 7))
    sns.scatterplot(data=subset, x="y_true", y="y_pred", alpha=0.35, ax=ax)
    line_min = min(subset["y_true"].min(), subset["y_pred"].min())
    line_max = max(subset["y_true"].max(), subset["y_pred"].max())
    ax.plot([line_min, line_max], [line_min, line_max], linestyle="--", color="black")
    ax.set_title(f"Actual vs Predicted Next-Hour Pickup Count: {model_name}")
    ax.set_xlabel("Actual")
    ax.set_ylabel("Predicted")
    fig.tight_layout()
    path = output_dir / "actual_vs_predicted.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def _aggregate_importances(feature_names: list[str], importances: list[float], raw_features: list[str]) -> pd.DataFrame:
    rows = []
    for raw_feature in raw_features:
        score = 0.0
        for encoded_name, importance in zip(feature_names, importances):
            normalized_name = encoded_name.split("__", maxsplit=1)[-1]
            if normalized_name == raw_feature or normalized_name.startswith(f"{raw_feature}_"):
                score += float(importance)
        rows.append({"feature": raw_feature, "importance": score})
    return pd.DataFrame(rows).sort_values("importance", ascending=False)


def _plot_importance_frame(importance_df: pd.DataFrame, title: str, path: Path, top_n: int = 20) -> Path:
    filtered = importance_df.head(top_n).sort_values("importance")
    fig, ax = plt.subplots(figsize=(10, 7))
    ax.barh(filtered["feature"], filtered["importance"], color="#287271")
    ax.set_title(title)
    ax.set_xlabel("Importance")
    ax.set_ylabel("")
    fig.tight_layout()
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_feature_importance_from_pipeline(model_path: Path, output_dir: Path, top_n: int = 20) -> Path | None:
    pipeline = joblib.load(model_path)
    model = pipeline.named_steps["model"]
    preprocessor = pipeline.named_steps["preprocessor"]
    if not hasattr(model, "feature_importances_"):
        return None
    importance_df = (
        pd.DataFrame({"feature": preprocessor.get_feature_names_out(), "importance": model.feature_importances_})
        .sort_values("importance", ascending=False)
    )
    ensure_dir(output_dir)
    return _plot_importance_frame(importance_df, "Feature Importance", output_dir / "feature_importance.png", top_n=top_n)


def plot_contextual_feature_importance(model_path: Path, output_dir: Path, weather_features: list[str], event_features: list[str]) -> list[Path]:
    pipeline = joblib.load(model_path)
    model = pipeline.named_steps["model"]
    preprocessor = pipeline.named_steps["preprocessor"]
    if not hasattr(model, "feature_importances_"):
        return []
    feature_names = list(preprocessor.get_feature_names_out())
    importances = list(model.feature_importances_)
    contextual_df = _aggregate_importances(feature_names, importances, weather_features + event_features)
    weather_df = contextual_df[contextual_df["feature"].isin(weather_features)].copy()
    event_df = contextual_df[contextual_df["feature"].isin(event_features)].copy()
    ensure_dir(output_dir)
    paths = [
        _plot_importance_frame(contextual_df, "Contextual Feature Importance Ranking", output_dir / "contextual_feature_importance.png"),
        _plot_importance_frame(weather_df, "Weather Feature Impact", output_dir / "weather_feature_importance.png", top_n=len(weather_df)),
        _plot_importance_frame(event_df, "Event Feature Impact", output_dir / "event_feature_importance.png", top_n=len(event_df)),
    ]
    return paths


def plot_zone_context_sensitivity(base_predictions: pd.DataFrame, contextual_predictions: pd.DataFrame, output_dir: Path) -> Path:
    ensure_dir(output_dir)
    merged = base_predictions[["timestamp", "zone_id", "model_name", "y_pred"]].rename(columns={"y_pred": "base_y_pred"}).merge(
        contextual_predictions[["timestamp", "zone_id", "model_name", "y_pred"]].rename(columns={"y_pred": "context_y_pred"}),
        on=["timestamp", "zone_id", "model_name"],
        how="inner",
    )
    merged["prediction_delta"] = merged["context_y_pred"] - merged["base_y_pred"]
    zone_delta = merged.groupby("zone_id", as_index=False)["prediction_delta"].mean().sort_values("prediction_delta", ascending=False).head(20)
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.barh(zone_delta["zone_id"].astype(str), zone_delta["prediction_delta"], color="#577590")
    ax.set_title("Zone Sensitivity to Contextual Signals")
    ax.set_xlabel("Average contextual prediction delta")
    ax.set_ylabel("Zone ID")
    fig.tight_layout()
    path = output_dir / "zone_context_sensitivity.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_forecast_horizon_rmse(horizon_metrics_df: pd.DataFrame, output_dir: Path) -> Path:
    ensure_dir(output_dir)
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.lineplot(data=horizon_metrics_df, x="horizon_step", y="rmse", hue="model_name", marker="o", ax=ax)
    benchmark_df = horizon_metrics_df[["horizon_step", "benchmark_rmse"]].drop_duplicates().rename(columns={"benchmark_rmse": "rmse"})
    sns.lineplot(data=benchmark_df, x="horizon_step", y="rmse", marker="o", label="Naive benchmark", ax=ax, linestyle="--", color="black")
    ax.set_title("24-Hour Forecast RMSE by Horizon Step")
    ax.set_xlabel("Forecast horizon (hours ahead)")
    ax.set_ylabel("RMSE")
    fig.tight_layout()
    path = output_dir / "forecast_horizon_rmse.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def plot_forecast_example(predictions_df: pd.DataFrame, output_dir: Path, model_name: str) -> Path:
    ensure_dir(output_dir)
    if predictions_df.empty:
        raise ValueError("Forecast predictions dataframe is empty.")
    example = (
        predictions_df[predictions_df["model_name"] == model_name]
        .sort_values(["zone_id", "anchor_timestamp", "horizon_step"])
        .groupby(["zone_id", "anchor_timestamp"], as_index=False)
        .head(24)
    )
    first_zone = int(example.iloc[0]["zone_id"])
    first_anchor = example.iloc[0]["anchor_timestamp"]
    example = example[(example["zone_id"] == first_zone) & (example["anchor_timestamp"] == first_anchor)].copy()
    fig, ax = plt.subplots(figsize=(11, 5))
    sns.lineplot(data=example, x="target_timestamp", y="y_true", marker="o", label="Actual", ax=ax)
    sns.lineplot(data=example, x="target_timestamp", y="y_pred", marker="o", label=model_name, ax=ax)
    sns.lineplot(data=example, x="target_timestamp", y="y_pred_benchmark", marker="o", label="Naive", ax=ax)
    ax.set_title(f"Example 24-Hour Forecast for Zone {first_zone}")
    ax.set_xlabel("Target timestamp")
    ax.set_ylabel("Pickup count")
    ax.tick_params(axis="x", rotation=30)
    fig.tight_layout()
    path = output_dir / "forecast_example_24h.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path
