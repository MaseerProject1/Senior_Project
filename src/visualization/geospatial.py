from __future__ import annotations

import json
import os
from pathlib import Path
import zipfile

import geopandas as gpd

os.environ.setdefault("MPLCONFIGDIR", str(Path.cwd() / ".mplconfig"))

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import plotly.express as px

from src.config.settings import Settings
from src.utils.io import read_dataframe


DEFAULT_MAP_CENTER = {"lat": 40.7128, "lon": -74.0060}
DEFAULT_MAP_ZOOM = 9.7


def load_zone_geometries(settings: Settings) -> gpd.GeoDataFrame:
    geometry_path = settings.path("external_data_dir") / "taxi_zones.zip"
    lookup_path = settings.path("external_data_dir") / "taxi_zone_lookup.csv"
    zone_lookup = read_dataframe(lookup_path).rename(columns={"LocationID": "zone_id", "Borough": "borough", "Zone": "zone_name"})
    zone_lookup["zone_id"] = zone_lookup["zone_id"].astype(int)

    with zipfile.ZipFile(geometry_path) as zip_handle:
        shape_members = [name for name in zip_handle.namelist() if name.lower().endswith(".shp")]
    if not shape_members:
        raise FileNotFoundError(f"No shapefile was found inside {geometry_path}")
    geometry_gdf = gpd.read_file(f"zip://{geometry_path}!{shape_members[0]}")
    if "LocationID" in geometry_gdf.columns:
        geometry_gdf = geometry_gdf.rename(columns={"LocationID": "zone_id"})
    geometry_gdf["zone_id"] = geometry_gdf["zone_id"].astype(int)
    geometry_gdf = geometry_gdf.merge(
        zone_lookup[["zone_id", "borough", "zone_name", "service_zone"]],
        on="zone_id",
        how="left",
        suffixes=("", "_lookup"),
    )
    for column in ["borough", "zone_name", "service_zone"]:
        lookup_column = f"{column}_lookup"
        if lookup_column in geometry_gdf.columns:
            geometry_gdf[column] = geometry_gdf[column].fillna(geometry_gdf[lookup_column])
            geometry_gdf = geometry_gdf.drop(columns=[lookup_column])
    return geometry_gdf.to_crs(epsg=4326)


def zone_geojson(zone_gdf: gpd.GeoDataFrame) -> dict:
    feature_frame = zone_gdf[["zone_id", "borough", "zone_name", "service_zone", "geometry"]].copy()
    return json.loads(feature_frame.to_json())


def safe_pressure_ratio(predicted: pd.Series | np.ndarray | float, baseline: pd.Series | np.ndarray | float, min_denominator: float) -> pd.Series:
    predicted_series = pd.Series(predicted, dtype=float)
    baseline_series = pd.Series(baseline, dtype=float)
    valid_mask = baseline_series >= float(min_denominator)
    ratio = pd.Series(np.nan, index=predicted_series.index, dtype=float)
    ratio.loc[valid_mask] = predicted_series.loc[valid_mask] / baseline_series.loc[valid_mask]
    return ratio


def _color_range(values: pd.Series) -> tuple[float, float]:
    finite_values = values.replace([np.inf, -np.inf], np.nan).dropna()
    if finite_values.empty:
        return 0.0, 1.0
    low = float(max(0.0, finite_values.quantile(0.05)))
    high = float(finite_values.quantile(0.95))
    if high <= low:
        high = low + 1.0
    return low, high


def build_heatmap_frame(
    feature_df: pd.DataFrame,
    timestamp: pd.Timestamp,
    predicted_next_hour: pd.Series,
    min_denominator: float,
) -> pd.DataFrame:
    snapshot = feature_df[pd.to_datetime(feature_df["timestamp"]) == pd.Timestamp(timestamp)].copy()
    snapshot = snapshot.sort_values("zone_id").reset_index(drop=True)
    snapshot["predicted_next_hour"] = np.maximum(predicted_next_hour.to_numpy(dtype=float), 0.0)
    snapshot["safe_pressure_ratio"] = safe_pressure_ratio(
        predicted=snapshot["predicted_next_hour"],
        baseline=snapshot["pickup_count_roll_mean_24"],
        min_denominator=min_denominator,
    )
    snapshot["weather_influence_score"] = (
        snapshot.get("rain_indicator", 0).astype(float)
        + snapshot.get("snowfall_indicator", 0).astype(float)
        + snapshot.get("heavy_rain_indicator", 0).astype(float)
        + snapshot.get("wind_speed", 0).astype(float) / 10.0
    )
    snapshot["event_influence_score"] = (
        snapshot.get("event_intensity_score", 0).astype(float)
        + snapshot.get("incident_flag", 0).astype(float)
        + snapshot.get("road_closure_flag", 0).astype(float)
    )
    snapshot["pressure_ratio_display"] = snapshot["safe_pressure_ratio"].map(lambda value: None if pd.isna(value) else round(float(value), 3))
    return snapshot


def build_choropleth_figure(heatmap_df: pd.DataFrame, zone_gdf: gpd.GeoDataFrame, mode: str):
    geojson = zone_geojson(zone_gdf)
    merged = zone_gdf.drop(columns=["geometry"]).merge(
        heatmap_df.drop(columns=["borough", "zone_name", "service_zone"], errors="ignore"),
        on="zone_id",
        how="left",
    )

    mode_config = {
        "Observed current demand": ("pickup_count", "Observed pickups in selected hour", "YlOrRd"),
        "Predicted next-hour demand": ("predicted_next_hour", "Predicted pickups in next hour", "Blues"),
        "Pressure ratio vs baseline": ("safe_pressure_ratio", "Predicted next hour / 24h rolling mean", "Turbo"),
        "Demand only": ("predicted_next_hour", "Predicted pickups in next hour", "Blues"),
        "Demand + weather influence": ("weather_influence_score", "Weather influence score", "Viridis"),
        "Demand + event influence": ("event_influence_score", "Event influence score", "Magma"),
    }
    color_column, legend_label, color_scale = mode_config[mode]
    range_min, range_max = _color_range(merged[color_column])

    figure = px.choropleth_mapbox(
        merged,
        geojson=geojson,
        locations="zone_id",
        featureidkey="properties.zone_id",
        color=color_column,
        color_continuous_scale=color_scale,
        range_color=(range_min, range_max),
        mapbox_style="carto-positron",
        center=DEFAULT_MAP_CENTER,
        zoom=DEFAULT_MAP_ZOOM,
        opacity=0.8,
        hover_name="zone_name",
        hover_data={
            "zone_id": True,
            "borough": True,
            "pickup_count": ":.0f",
            "predicted_next_hour": ":.2f",
            "safe_pressure_ratio": ":.2f",
            color_column: False,
        },
        labels={color_column: legend_label},
    )
    figure.update_layout(margin={"r": 0, "t": 40, "l": 0, "b": 0}, coloraxis_colorbar_title=legend_label)
    return figure


def save_static_heatmap_figure(heatmap_df: pd.DataFrame, zone_gdf: gpd.GeoDataFrame, output_path: Path, mode: str) -> Path:
    merged = zone_gdf.merge(heatmap_df.drop(columns=["borough", "zone_name", "service_zone"], errors="ignore"), on="zone_id", how="left")
    mode_config = {
        "Observed current demand": ("pickup_count", "Observed pickups in selected hour", "YlOrRd"),
        "Predicted next-hour demand": ("predicted_next_hour", "Predicted pickups in next hour", "Blues"),
        "Pressure ratio vs baseline": ("safe_pressure_ratio", "Predicted next hour / 24h rolling mean", "viridis"),
        "Demand only": ("predicted_next_hour", "Predicted pickups in next hour", "Blues"),
        "Demand + weather influence": ("weather_influence_score", "Weather influence score", "viridis"),
        "Demand + event influence": ("event_influence_score", "Event influence score", "magma"),
    }
    color_column, legend_label, cmap = mode_config[mode]
    fig, ax = plt.subplots(figsize=(10, 10))
    merged.plot(column=color_column, cmap=cmap, linewidth=0.2, edgecolor="black", legend=True, ax=ax, missing_kwds={"color": "lightgrey"})
    ax.set_title(f"NYC Taxi Zone Heatmap: {legend_label}")
    ax.set_axis_off()
    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=300, bbox_inches="tight")
    plt.close(fig)
    return output_path
