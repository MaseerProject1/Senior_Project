from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import requests

from src.config.settings import Settings
from src.utils.io import ensure_dir, read_dataframe, write_dataframe
from src.utils.logging_utils import get_logger


LOGGER = get_logger(__name__)
WEATHER_COLUMNS = [
    "timestamp",
    "temperature",
    "precipitation",
    "snowfall",
    "wind_speed",
    "humidity",
    "weather_code",
    "weather_category",
]


def _weather_dir(settings: Settings) -> Path:
    return ensure_dir(settings.path("external_data_dir") / "weather")


def _cache_path(settings: Settings, start: pd.Timestamp, end: pd.Timestamp) -> Path:
    return _weather_dir(settings) / f"weather_nyc_{start:%Y%m%d}_{end:%Y%m%d}.csv"


def _processed_path(settings: Settings) -> Path:
    return _weather_dir(settings) / "weather_hourly.parquet"


def _weather_category_from_code(code: int | float | None) -> str:
    if pd.isna(code):
        return "unknown"
    code = int(code)
    if code == 0:
        return "clear"
    if code in {1, 2, 3}:
        return "cloudy"
    if code in {45, 48}:
        return "fog"
    if code in {51, 53, 55, 56, 57, 61, 63, 66, 80}:
        return "light_rain"
    if code in {65, 67, 81, 82}:
        return "heavy_rain"
    if code in {71, 73, 77, 85}:
        return "light_snow"
    if code in {75, 86}:
        return "heavy_snow"
    if code in {95, 96, 99}:
        return "storm"
    return "other"


def _validate_weather_schema(df: pd.DataFrame) -> None:
    missing = [column for column in WEATHER_COLUMNS if column not in df.columns]
    if missing:
        raise ValueError(f"Weather schema is missing required columns: {missing}")


def download_weather_data(start: pd.Timestamp, end: pd.Timestamp, settings: Settings) -> pd.DataFrame:
    cfg = settings.context_cfg.get("weather", {})
    cache_path = _cache_path(settings, start, end)
    if bool(cfg.get("cache_enabled", True)) and cache_path.exists():
        return read_dataframe(cache_path)

    params = {
        "latitude": float(cfg.get("latitude", 40.7128)),
        "longitude": float(cfg.get("longitude", -74.0060)),
        "start_date": start.strftime("%Y-%m-%d"),
        "end_date": end.strftime("%Y-%m-%d"),
        "timezone": str(cfg.get("timezone", settings.timezone)),
        "hourly": ",".join(
            [
                "temperature_2m",
                "precipitation",
                "snowfall",
                "wind_speed_10m",
                "relative_humidity_2m",
                "weather_code",
            ]
        ),
    }
    response = requests.get(str(cfg.get("archive_url")), params=params, timeout=10)
    response.raise_for_status()
    payload = response.json()
    hourly = pd.DataFrame(payload.get("hourly", {}))
    if hourly.empty:
        raise ValueError("Weather download returned an empty hourly payload.")
    raw_df = hourly.rename(
        columns={
            "time": "timestamp",
            "temperature_2m": "temperature",
            "wind_speed_10m": "wind_speed",
            "relative_humidity_2m": "humidity",
        }
    )
    write_dataframe(raw_df, cache_path)
    return raw_df


def preprocess_weather_data(raw_df: pd.DataFrame) -> pd.DataFrame:
    weather_df = raw_df.copy()
    weather_df["timestamp"] = pd.to_datetime(weather_df["timestamp"], errors="coerce").dt.floor("1h")
    weather_df = weather_df.dropna(subset=["timestamp"]).sort_values("timestamp")
    hourly_df = (
        weather_df.groupby("timestamp", as_index=False)
        .agg(
            temperature=("temperature", "mean"),
            precipitation=("precipitation", "sum"),
            snowfall=("snowfall", "sum"),
            wind_speed=("wind_speed", "mean"),
            humidity=("humidity", "mean"),
            weather_code=("weather_code", "last"),
        )
        .sort_values("timestamp")
        .reset_index(drop=True)
    )
    numeric_cols = ["temperature", "precipitation", "snowfall", "wind_speed", "humidity", "weather_code"]
    for column in numeric_cols:
        hourly_df[column] = pd.to_numeric(hourly_df[column], errors="coerce")
        hourly_df[column] = hourly_df[column].interpolate(limit_direction="both")
        median = float(hourly_df[column].median()) if hourly_df[column].notna().any() else 0.0
        hourly_df[column] = hourly_df[column].fillna(median)
    hourly_df["weather_category"] = hourly_df["weather_code"].map(_weather_category_from_code)
    _validate_weather_schema(hourly_df)
    return hourly_df


def build_weather_context(panel_df: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    cfg = settings.context_cfg.get("weather", {})
    neutral = pd.DataFrame({"timestamp": pd.to_datetime(panel_df["timestamp"]).drop_duplicates().sort_values()})
    if not bool(cfg.get("enabled", True)) or panel_df.empty:
        neutral["weather_available"] = 0
        return neutral
    if pd.to_datetime(panel_df["timestamp"]).nunique() < 24 * 14:
        neutral["weather_available"] = 0
        for column in WEATHER_COLUMNS[1:]:
            neutral[column] = 0.0 if column != "weather_category" else "unknown"
        return neutral
    start = pd.to_datetime(panel_df["timestamp"]).min().normalize()
    end = pd.to_datetime(panel_df["timestamp"]).max().normalize()
    try:
        raw_df = download_weather_data(start=start, end=end, settings=settings)
        weather_df = preprocess_weather_data(raw_df)
        write_dataframe(weather_df, _processed_path(settings))
        weather_df["weather_available"] = 1
        return weather_df
    except Exception as exc:  # pragma: no cover
        LOGGER.warning("Weather integration skipped: %s", exc)
        neutral["weather_available"] = 0
        for column in WEATHER_COLUMNS[1:]:
            neutral[column] = 0.0 if column != "weather_category" else "unknown"
        return neutral
