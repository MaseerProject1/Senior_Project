from __future__ import annotations

import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar

from src.config.settings import Settings
from src.data.events import build_event_context
from src.data.weather import build_weather_context
from src.utils.io import write_dataframe, write_json


TARGET_COLUMN = "target_pickup_count_next_hour"
BASE_FEATURES = [
    "pickup_count",
    "mean_trip_distance",
    "mean_total_amount",
    "mean_fare_amount",
    "mean_duration_minutes",
    "median_duration_minutes",
    "mean_passenger_count",
    "unique_dropoff_zones",
    "hour",
    "day_of_week",
    "day_of_month",
    "month",
    "week_of_year",
    "is_weekend",
    "is_holiday",
    "is_rush_hour",
    "hour_sin",
    "hour_cos",
    "day_of_week_sin",
    "day_of_week_cos",
]
LAG_FEATURES = [
    "pickup_count_lag_1",
    "pickup_count_lag_2",
    "pickup_count_lag_3",
    "pickup_count_lag_24",
    "pickup_count_lag_168",
    "pickup_count_roll_mean_3",
    "pickup_count_roll_mean_6",
    "pickup_count_roll_mean_24",
    "pickup_count_roll_std_24",
    "pickup_count_roll_mean_168",
    "pickup_count_roll_std_168",
]
WEATHER_FEATURES = [
    "temperature",
    "precipitation",
    "snowfall",
    "wind_speed",
    "humidity",
    "weather_category",
    "rain_indicator",
    "heavy_rain_indicator",
    "snowfall_indicator",
    "weather_available",
]
EVENT_FEATURES = [
    "event_active",
    "event_flag",
    "event_intensity",
    "event_intensity_score",
    "zone_incident_count",
    "citywide_incident_count",
    "incident_flag",
    "accident_flag",
    "road_disruption_flag",
    "road_closure_flag",
    "disruption_score",
]
INTERACTION_FEATURES = [
    "rain_x_rush_hour",
    "snow_x_zone_demand",
    "event_x_baseline_demand",
    "accident_x_pickup_pressure",
]
CATEGORICAL_FEATURES = ["borough", "service_zone", "zone_name", "zone_id", "weather_category"]
NUMERIC_FEATURES = BASE_FEATURES + LAG_FEATURES + [feature for feature in WEATHER_FEATURES if feature != "weather_category"] + EVENT_FEATURES + INTERACTION_FEATURES
CONTEXTUAL_FEATURES = WEATHER_FEATURES + EVENT_FEATURES + INTERACTION_FEATURES
BASELINE_COMPARISON_FEATURES = BASE_FEATURES + LAG_FEATURES + ["borough", "service_zone", "zone_name", "zone_id"]
ALL_FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES


def add_calendar_features(df: pd.DataFrame) -> pd.DataFrame:
    enriched = df.copy()
    timestamps = pd.to_datetime(enriched["timestamp"])
    enriched["hour"] = timestamps.dt.hour
    enriched["day_of_week"] = timestamps.dt.dayofweek
    enriched["day_of_month"] = timestamps.dt.day
    enriched["month"] = timestamps.dt.month
    enriched["week_of_year"] = timestamps.dt.isocalendar().week.astype(int)
    enriched["is_weekend"] = (enriched["day_of_week"] >= 5).astype(int)
    enriched["is_rush_hour"] = enriched["hour"].isin([7, 8, 9, 16, 17, 18, 19]).astype(int)
    enriched["hour_sin"] = np.sin(2 * np.pi * enriched["hour"] / 24)
    enriched["hour_cos"] = np.cos(2 * np.pi * enriched["hour"] / 24)
    enriched["day_of_week_sin"] = np.sin(2 * np.pi * enriched["day_of_week"] / 7)
    enriched["day_of_week_cos"] = np.cos(2 * np.pi * enriched["day_of_week"] / 7)
    calendar = USFederalHolidayCalendar()
    holidays = calendar.holidays(start=timestamps.min().normalize(), end=timestamps.max().normalize())
    enriched["is_holiday"] = timestamps.dt.normalize().isin(holidays).astype(int)
    return enriched


def merge_contextual_data(df: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    weather_df = build_weather_context(df, settings)
    event_df = build_event_context(df, settings)
    merged = df.merge(weather_df, on="timestamp", how="left")
    merged = merged.merge(event_df, on=["timestamp", "zone_id"], how="left")

    default_values: dict[str, object] = {
        "temperature": 0.0,
        "precipitation": 0.0,
        "snowfall": 0.0,
        "wind_speed": 0.0,
        "humidity": 0.0,
        "weather_code": 0.0,
        "weather_category": "unknown",
        "weather_available": 0,
        "event_active": 0,
        "event_flag": 0,
        "event_intensity": 0.0,
        "event_intensity_score": 0.0,
        "zone_incident_count": 0.0,
        "citywide_incident_count": 0.0,
        "incident_flag": 0,
        "accident_flag": 0,
        "road_disruption_flag": 0,
        "road_closure_flag": 0,
        "disruption_score": 0.0,
        "event_mapping_quality": "none",
    }
    for column, value in default_values.items():
        if column not in merged.columns:
            merged[column] = value
        else:
            merged[column] = merged[column].fillna(value)
    return merged


def add_zone_lag_features(df: pd.DataFrame) -> pd.DataFrame:
    enriched = df.sort_values(["zone_id", "timestamp"]).copy()
    group = enriched.groupby("zone_id", group_keys=False)
    enriched["pickup_count_lag_1"] = group["pickup_count"].shift(1)
    enriched["pickup_count_lag_2"] = group["pickup_count"].shift(2)
    enriched["pickup_count_lag_3"] = group["pickup_count"].shift(3)
    enriched["pickup_count_lag_24"] = group["pickup_count"].shift(24)
    enriched["pickup_count_lag_168"] = group["pickup_count"].shift(168)
    enriched["pickup_count_roll_mean_3"] = group["pickup_count"].shift(1).rolling(3).mean().reset_index(level=0, drop=True)
    enriched["pickup_count_roll_mean_6"] = group["pickup_count"].shift(1).rolling(6).mean().reset_index(level=0, drop=True)
    enriched["pickup_count_roll_mean_24"] = group["pickup_count"].shift(1).rolling(24).mean().reset_index(level=0, drop=True)
    enriched["pickup_count_roll_std_24"] = group["pickup_count"].shift(1).rolling(24).std().reset_index(level=0, drop=True)
    enriched["pickup_count_roll_mean_168"] = group["pickup_count"].shift(1).rolling(168).mean().reset_index(level=0, drop=True)
    enriched["pickup_count_roll_std_168"] = group["pickup_count"].shift(1).rolling(168).std().reset_index(level=0, drop=True)
    enriched[TARGET_COLUMN] = group["pickup_count"].shift(-1)
    enriched["demand_pressure_ratio"] = enriched[TARGET_COLUMN] / enriched["pickup_count_roll_mean_24"].replace(0, np.nan)
    enriched["demand_pressure_ratio"] = enriched["demand_pressure_ratio"].replace([np.inf, -np.inf], np.nan)
    return enriched


def add_contextual_features(df: pd.DataFrame) -> pd.DataFrame:
    enriched = df.copy()
    enriched["rain_indicator"] = (pd.to_numeric(enriched["precipitation"], errors="coerce").fillna(0.0) > 0).astype(int)
    enriched["heavy_rain_indicator"] = (pd.to_numeric(enriched["precipitation"], errors="coerce").fillna(0.0) >= 5.0).astype(int)
    enriched["snowfall_indicator"] = (pd.to_numeric(enriched["snowfall"], errors="coerce").fillna(0.0) > 0).astype(int)
    enriched["event_flag"] = enriched["event_flag"].astype(int)
    enriched["accident_flag"] = enriched["accident_flag"].astype(int)
    enriched["road_closure_flag"] = enriched["road_closure_flag"].astype(int)
    enriched["road_disruption_flag"] = enriched["road_disruption_flag"].astype(int)
    enriched["zone_incident_count"] = pd.to_numeric(enriched.get("zone_incident_count"), errors="coerce").fillna(0.0)
    enriched["citywide_incident_count"] = pd.to_numeric(enriched.get("citywide_incident_count"), errors="coerce").fillna(0.0)
    enriched["event_mapping_quality"] = enriched.get("event_mapping_quality", "none")
    enriched["rain_x_rush_hour"] = enriched["rain_indicator"] * enriched["is_rush_hour"]
    enriched["snow_x_zone_demand"] = enriched["snowfall_indicator"] * enriched["pickup_count"]
    enriched["event_x_baseline_demand"] = enriched["event_intensity_score"] * enriched["pickup_count_roll_mean_24"].fillna(0.0)
    enriched["accident_x_pickup_pressure"] = enriched["accident_flag"] * enriched["pickup_count"].fillna(0.0)
    return enriched


def build_feature_dataset(panel_df: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    feature_df = add_calendar_features(panel_df)
    feature_df = merge_contextual_data(feature_df, settings)
    feature_df = add_zone_lag_features(feature_df)
    feature_df = add_contextual_features(feature_df)
    feature_df = feature_df.dropna(subset=LAG_FEATURES + [TARGET_COLUMN]).reset_index(drop=True)
    for column in ["pickup_count_roll_std_24", "pickup_count_roll_std_168"]:
        feature_df[column] = feature_df[column].fillna(0.0)
    for column in [feature for feature in NUMERIC_FEATURES if feature in feature_df.columns]:
        feature_df[column] = pd.to_numeric(feature_df[column], errors="coerce").fillna(0.0)
    feature_df["weather_category"] = feature_df["weather_category"].fillna("unknown").astype(str)
    return feature_df.sort_values(["timestamp", "zone_id"]).reset_index(drop=True)


def save_feature_dataset(feature_df: pd.DataFrame, settings: Settings) -> dict:
    feature_path = settings.path("processed_data_dir") / "zone_hour_features.parquet"
    metadata_path = settings.path("artifacts_dir") / "metadata" / "feature_metadata.json"
    write_dataframe(feature_df, feature_path)
    metadata = {
        "target_column": TARGET_COLUMN,
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "all_features": ALL_FEATURES,
        "baseline_comparison_features": BASELINE_COMPARISON_FEATURES,
        "contextual_features": CONTEXTUAL_FEATURES,
        "weather_features": WEATHER_FEATURES,
        "event_features": EVENT_FEATURES,
        "interaction_features": INTERACTION_FEATURES,
        "target_definition": "Next-hour yellow taxi pickup count by NYC TLC taxi zone.",
        "target_justification": "Observed pickup demand is used as a waiting-pressure proxy because TLC yellow taxi data does not publish direct passenger wait time.",
        "merge_logic": {
            "weather": "City-level weather joins onto the hourly zone panel on timestamp after hourly normalization.",
            "events": "Events and incidents join onto the hourly zone panel on timestamp and zone_id when available, with citywide incidents broadcast by timestamp.",
        },
    }
    write_json(metadata, metadata_path)
    return {"feature_path": feature_path, "metadata_path": metadata_path, "metadata": metadata}
