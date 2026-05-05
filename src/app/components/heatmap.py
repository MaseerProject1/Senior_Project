from __future__ import annotations

import pandas as pd
import streamlit as st

from src.features.engineering import ALL_FEATURES
from src.visualization.geospatial import build_choropleth_figure, build_heatmap_frame


def render_heatmap_section(feature_df: pd.DataFrame, zone_gdf, model, min_denominator: float) -> None:
    st.subheader("NYC Demand Heatmap")
    st.caption("Interactive zone-level view using official TLC taxi-zone geometry. The predicted layer reflects next-hour pickup demand, which is used as a demand-pressure proxy rather than a direct wait-time measure.")

    available_timestamps = sorted(pd.to_datetime(feature_df["timestamp"]).unique())
    default_index = max(0, len(available_timestamps) - 2)
    selected_timestamp = pd.Timestamp(
        st.select_slider(
            "Heatmap timestamp",
            options=available_timestamps,
            value=available_timestamps[default_index],
            format_func=lambda value: pd.Timestamp(value).strftime("%Y-%m-%d %H:%M"),
            key="heatmap_timestamp",
        )
    )
    mode = st.radio(
        "Heatmap layer",
        options=["Demand only", "Demand + weather influence", "Demand + event influence", "Pressure ratio vs baseline"],
        horizontal=True,
        key="heatmap_mode",
    )

    snapshot = feature_df[pd.to_datetime(feature_df["timestamp"]) == selected_timestamp].sort_values("zone_id").reset_index(drop=True)
    predicted = pd.Series(model.predict(snapshot[ALL_FEATURES]), index=snapshot.index)
    heatmap_df = build_heatmap_frame(feature_df, selected_timestamp, predicted, min_denominator=min_denominator)
    figure = build_choropleth_figure(heatmap_df, zone_gdf, mode=mode)
    st.plotly_chart(figure, use_container_width=True)

    st.dataframe(
        heatmap_df[["zone_id", "zone_name", "borough", "pickup_count", "predicted_next_hour", "weather_influence_score", "event_influence_score", "safe_pressure_ratio"]]
        .rename(columns={"pickup_count": "observed_pickups", "safe_pressure_ratio": "pressure_ratio"})
        .sort_values("predicted_next_hour", ascending=False)
        .head(25),
        use_container_width=True,
    )
