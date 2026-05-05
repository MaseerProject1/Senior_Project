from __future__ import annotations

from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from src.models.forecasting import naive_previous_24_forecast, predict_next_24_hours
from src.utils.io import read_json


def resolve_manifest_model_path(path_value: str | Path, artifacts_dir: Path) -> Path:
    path = Path(path_value)
    if path.exists():
        return path

    candidate = artifacts_dir / path
    if candidate.exists():
        return candidate

    candidate = artifacts_dir / "models" / path.name
    if candidate.exists():
        return candidate

    return path


def render_next_24h_forecast_section(panel_df: pd.DataFrame, artifacts_dir: Path, selected_zone_id: int, selected_timestamp: pd.Timestamp) -> None:
    st.subheader("Next 24 Hours Forecast")
    st.caption("This view uses the deep temporal forecasting stack to predict the next 24 hourly pickup counts for the selected taxi zone. Forecasted demand remains an operational pressure proxy, not a direct wait-time estimate.")

    manifest_path = artifacts_dir / "metadata" / "forecast_manifest.json"
    if not manifest_path.exists():
        st.warning("The deep forecasting artifacts are missing. Run `python -m src.cli train` to create them.")
        return
    manifest = read_json(manifest_path)

    model_options = [item["model_name"] for item in manifest.get("models", [])]
    if not model_options:
        st.warning("No deep forecast models were found in the manifest.")
        return
    default_model = manifest.get("best_forecast_model", model_options[0])
    selected_model_name = st.selectbox("Deep forecast model", model_options, index=model_options.index(default_model) if default_model in model_options else 0)
    selected_item = next(item for item in manifest["models"] if item["model_name"] == selected_model_name)
    model_path = resolve_manifest_model_path(selected_item["path"], artifacts_dir)
    if not model_path.exists():
        st.warning(
            "The selected deep forecast model file could not be found. "
            f"Expected: {model_path}.\nPlease re-run `python -m src.cli train` or check that your artifacts directory contains the forecast model files."
        )
        return

    zone_df = panel_df[panel_df["zone_id"] == selected_zone_id].sort_values("timestamp").copy()
    history_df = zone_df[pd.to_datetime(zone_df["timestamp"]) <= pd.Timestamp(selected_timestamp)].copy()
    if history_df.empty:
        st.warning("No history is available for the selected zone and timestamp.")
        return

    try:
        deep_forecast = predict_next_24_hours(model_path, history_df)
        naive_forecast = naive_previous_24_forecast(history_df, horizon=24)
    except ValueError as exc:
        st.warning(str(exc))
        return

    future_actual = (
        zone_df[pd.to_datetime(zone_df["timestamp"]) > pd.Timestamp(selected_timestamp)]
        .sort_values("timestamp")
        .head(24)[["timestamp", "pickup_count"]]
        .rename(columns={"timestamp": "forecast_timestamp", "pickup_count": "actual_pickup_count"})
    )
    comparison_df = deep_forecast.merge(
        naive_forecast.rename(columns={"predicted_pickup_count": "naive_pickup_count"}),
        on=["forecast_timestamp", "horizon_step"],
        how="left",
    )
    comparison_df = comparison_df.merge(future_actual, on="forecast_timestamp", how="left")

    recent_history = history_df.tail(48)[["timestamp", "pickup_count"]].rename(columns={"timestamp": "plot_timestamp"})
    forecast_plot_df = comparison_df.rename(columns={"forecast_timestamp": "plot_timestamp"})

    figure = go.Figure()
    figure.add_trace(go.Scatter(x=recent_history["plot_timestamp"], y=recent_history["pickup_count"], mode="lines+markers", name="Recent history"))
    figure.add_trace(go.Scatter(x=forecast_plot_df["plot_timestamp"], y=forecast_plot_df["predicted_pickup_count"], mode="lines+markers", name=selected_model_name))
    figure.add_trace(go.Scatter(x=forecast_plot_df["plot_timestamp"], y=forecast_plot_df["naive_pickup_count"], mode="lines+markers", name="Naive forecast"))
    if forecast_plot_df["actual_pickup_count"].notna().any():
        figure.add_trace(go.Scatter(x=forecast_plot_df["plot_timestamp"], y=forecast_plot_df["actual_pickup_count"], mode="lines+markers", name="Actual future"))
    figure.update_layout(
        height=460,
        margin={"r": 20, "t": 40, "l": 20, "b": 20},
        xaxis_title="Timestamp",
        yaxis_title="Pickup count",
        legend_title="Series",
    )
    st.plotly_chart(figure, use_container_width=True)
    st.dataframe(comparison_df, use_container_width=True)
