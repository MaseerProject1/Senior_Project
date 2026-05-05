from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import requests

from src.config.settings import Settings
from src.utils.io import ensure_dir, read_dataframe, write_dataframe, write_json
from src.utils.logging_utils import get_logger
from src.visualization.geospatial import load_zone_geometries

try:  # pragma: no cover
    import geopandas as gpd
except ImportError:  # pragma: no cover
    gpd = None


LOGGER = get_logger(__name__)
EVENT_COLUMNS = [
    "timestamp",
    "zone_id",
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
    "event_mapping_quality",
]
EVENT_NUMERIC_COLUMNS = [column for column in EVENT_COLUMNS[2:] if column != "event_mapping_quality"]


def _events_dir(settings: Settings) -> Path:
    return ensure_dir(settings.path("external_data_dir") / "events")


def _collision_cache_path(settings: Settings, start: pd.Timestamp, end: pd.Timestamp) -> Path:
    return _events_dir(settings) / f"collisions_{start:%Y%m%d}_{end:%Y%m%d}.csv"


def _processed_path(settings: Settings) -> Path:
    return _events_dir(settings) / "event_features.parquet"


def _mapped_collisions_path(settings: Settings) -> Path:
    return _events_dir(settings) / "mapped_collision_events.parquet"


def _summary_json_path(settings: Settings) -> Path:
    return settings.path("artifacts_dir") / "metadata" / "event_integration_summary.json"


def _summary_csv_path(settings: Settings) -> Path:
    return settings.path("reports_dir") / "tables" / "event_integration_summary.csv"


def _neutral_event_features(panel_df: pd.DataFrame) -> pd.DataFrame:
    base = panel_df[["timestamp", "zone_id"]].drop_duplicates().copy()
    for column in EVENT_NUMERIC_COLUMNS:
        base[column] = 0.0
    base["event_mapping_quality"] = "none"
    integer_cols = ["event_active", "event_flag", "incident_flag", "accident_flag", "road_disruption_flag", "road_closure_flag"]
    for column in integer_cols:
        base[column] = base[column].astype(int)
    return base


def _load_local_table(path_like: str | Path) -> pd.DataFrame:
    path = Path(path_like)
    if not path.exists():
        return pd.DataFrame()
    return read_dataframe(path)


def _expand_time_windows(source_df: pd.DataFrame, start_col: str, end_col: str, feature_name: str, value_name: str) -> pd.DataFrame:
    if source_df.empty:
        return pd.DataFrame(columns=["timestamp", "zone_id", feature_name, value_name])
    frame = source_df.copy()
    frame[start_col] = pd.to_datetime(frame[start_col], errors="coerce")
    frame[end_col] = pd.to_datetime(frame[end_col], errors="coerce")
    frame = frame.dropna(subset=[start_col, end_col])
    rows: list[dict] = []
    for _, row in frame.iterrows():
        hours = pd.date_range(row[start_col].floor("1h"), row[end_col].ceil("1h"), freq="1h")
        base_value = float(row.get(value_name, 1.0) or 1.0)
        zone_id = row.get("zone_id")
        for timestamp in hours:
            rows.append(
                {
                    "timestamp": timestamp,
                    "zone_id": int(zone_id) if pd.notna(zone_id) else np.nan,
                    feature_name: 1,
                    value_name: base_value,
                }
            )
    return pd.DataFrame(rows)


def _normalize_collision_columns(df: pd.DataFrame) -> pd.DataFrame:
    normalized = df.copy()
    normalized.columns = [column.strip().lower().replace(" ", "_") for column in normalized.columns]
    rename_map = {
        "crash_date": "crash_date",
        "crash_time": "crash_time",
        "zip_code": "zip_code",
        "on_street_name": "on_street_name",
        "cross_street_name": "cross_street_name",
        "location": "location",
    }
    return normalized.rename(columns=rename_map)


def _parse_collision_timestamps(collisions: pd.DataFrame) -> tuple[pd.Series, int]:
    if "timestamp" in collisions.columns:
        parsed = pd.to_datetime(collisions["timestamp"], errors="coerce")
        return parsed.dt.floor("1h"), int(parsed.isna().sum())
    if {"crash_date", "crash_time"}.issubset(collisions.columns):
        date_part = collisions["crash_date"].astype(str).str.slice(0, 10)
        time_part = collisions["crash_time"].astype(str).str.strip()
        parsed = pd.to_datetime(date_part + " " + time_part, format="%Y-%m-%d %H:%M", errors="coerce")
        fallback_mask = parsed.isna()
        if fallback_mask.any():
            parsed.loc[fallback_mask] = pd.to_datetime((date_part + " " + time_part).loc[fallback_mask], errors="coerce")
        return parsed.dt.floor("1h"), int(parsed.isna().sum())
    if "crash_date" in collisions.columns:
        parsed = pd.to_datetime(collisions["crash_date"], errors="coerce")
        return parsed.dt.floor("1h"), int(parsed.isna().sum())
    return pd.Series(pd.NaT, index=collisions.index, dtype="datetime64[ns]"), int(len(collisions))


def download_collision_data(start: pd.Timestamp, end: pd.Timestamp, settings: Settings) -> pd.DataFrame:
    cfg = settings.context_cfg.get("events", {})
    cache_path = _collision_cache_path(settings, start, end)
    if bool(cfg.get("cache_enabled", True)) and cache_path.exists():
        return read_dataframe(cache_path)
    start_iso = start.strftime("%Y-%m-%dT00:00:00")
    end_iso = (end + pd.Timedelta(days=1) - pd.Timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S")
    params = {
        "$limit": 500000,
        "$select": ",".join(
            [
                "collision_id",
                "crash_date",
                "crash_time",
                "latitude",
                "longitude",
                "borough",
                "number_of_persons_injured",
                "number_of_persons_killed",
            ]
        ),
        "$where": f"crash_date between '{start_iso}' and '{end_iso}'",
    }
    response = requests.get(str(cfg.get("collision_url")), params=params, timeout=10)
    response.raise_for_status()
    collisions = pd.read_csv(pd.io.common.StringIO(response.text))
    write_dataframe(collisions, cache_path)
    return collisions


def _assign_collision_zones(collisions_df: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    collisions = collisions_df.copy()
    collisions["zone_id"] = np.nan
    if collisions.empty or gpd is None:
        return collisions
    if not {"latitude", "longitude"}.issubset(collisions.columns):
        return collisions
    collisions["latitude"] = pd.to_numeric(collisions["latitude"], errors="coerce")
    collisions["longitude"] = pd.to_numeric(collisions["longitude"], errors="coerce")
    geo_ready = collisions.dropna(subset=["latitude", "longitude"]).copy()
    if geo_ready.empty:
        return collisions
    try:
        zone_gdf = load_zone_geometries(settings)[["zone_id", "geometry"]].rename(columns={"zone_id": "mapped_zone_id"}).copy()
        if zone_gdf.crs is None:
            zone_gdf = zone_gdf.set_crs("EPSG:4326")
        points = gpd.GeoDataFrame(
            geo_ready,
            geometry=gpd.points_from_xy(geo_ready["longitude"], geo_ready["latitude"]),
            crs="EPSG:4326",
        )
        zone_gdf = zone_gdf.to_crs(points.crs)
        joined = gpd.sjoin(points, zone_gdf, how="left", predicate="within").drop(columns=["index_right"], errors="ignore")
        collisions.loc[joined.index, "zone_id"] = joined["mapped_zone_id"].to_numpy()
    except Exception as exc:  # pragma: no cover
        LOGGER.warning("Event-to-zone mapping skipped: %s", exc)
    return collisions


def _write_event_summary(summary: dict, settings: Settings) -> None:
    write_json(summary, _summary_json_path(settings))
    write_dataframe(pd.DataFrame([summary]), _summary_csv_path(settings))


def preprocess_collision_data(raw_df: pd.DataFrame, settings: Settings) -> tuple[pd.DataFrame, dict]:
    base_columns = ["timestamp", "zone_id", "zone_incident_count", "citywide_incident_count", "incident_flag", "accident_flag", "event_intensity_score"]
    if raw_df.empty:
        return pd.DataFrame(columns=base_columns), {
            "total_raw_event_records": 0,
            "invalid_timestamp_records_dropped": 0,
            "records_with_latitude_longitude": 0,
            "records_mapped_to_taxi_zones": 0,
            "records_not_mapped": 0,
            "citywide_only_records": 0,
            "unique_mapped_zones": 0,
            "event_active_hours": 0,
        }
    collisions = _normalize_collision_columns(raw_df)
    collisions["timestamp"], invalid_timestamp_count = _parse_collision_timestamps(collisions)
    collisions = collisions.dropna(subset=["timestamp"]).copy()
    if "collision_id" not in collisions.columns:
        collisions["collision_id"] = collisions.index.astype(str)
    if "latitude" not in collisions.columns:
        collisions["latitude"] = np.nan
    if "longitude" not in collisions.columns:
        collisions["longitude"] = np.nan
    collisions = _assign_collision_zones(collisions, settings)
    collisions["injury_score"] = pd.to_numeric(collisions.get("number_of_persons_injured"), errors="coerce").fillna(0.0)
    collisions["fatality_score"] = pd.to_numeric(collisions.get("number_of_persons_killed"), errors="coerce").fillna(0.0)
    collisions["event_intensity_score"] = 1.0 + collisions["injury_score"] + 3.0 * collisions["fatality_score"]

    has_coordinates = collisions["latitude"].notna() & collisions["longitude"].notna()
    mapped_mask = collisions["zone_id"].notna()
    collisions["event_mapping_quality"] = np.where(mapped_mask, "zone_specific", "citywide")
    write_dataframe(collisions.drop(columns=["geometry"], errors="ignore"), _mapped_collisions_path(settings))

    zone_features = (
        collisions[mapped_mask]
        .groupby(["timestamp", "zone_id"], as_index=False)
        .agg(
            zone_incident_count=("collision_id", "count"),
            event_intensity_score=("event_intensity_score", "sum"),
        )
        .sort_values(["timestamp", "zone_id"])
        .reset_index(drop=True)
    )
    if not zone_features.empty:
        zone_features["zone_id"] = zone_features["zone_id"].astype(int)

    city_features = (
        collisions[~mapped_mask]
        .groupby("timestamp", as_index=False)
        .agg(
            citywide_incident_count=("collision_id", "count"),
            citywide_event_intensity_score=("event_intensity_score", "sum"),
        )
        .sort_values("timestamp")
        .reset_index(drop=True)
    )
    if zone_features.empty and city_features.empty:
        features = pd.DataFrame(columns=base_columns)
    else:
        features = zone_features.merge(city_features, on="timestamp", how="outer")
        features["zone_incident_count"] = pd.to_numeric(features.get("zone_incident_count"), errors="coerce").fillna(0.0)
        features["citywide_incident_count"] = pd.to_numeric(features.get("citywide_incident_count"), errors="coerce").fillna(0.0)
        features["event_intensity_score"] = pd.to_numeric(features.get("event_intensity_score"), errors="coerce").fillna(0.0)
        features["citywide_event_intensity_score"] = pd.to_numeric(features.get("citywide_event_intensity_score"), errors="coerce").fillna(0.0)
        features["event_intensity_score"] = features["event_intensity_score"] + features["citywide_event_intensity_score"]
        features["incident_flag"] = ((features["zone_incident_count"] + features["citywide_incident_count"]) > 0).astype(int)
        features["accident_flag"] = features["incident_flag"]
        features = features.drop(columns=["citywide_event_intensity_score"], errors="ignore")

    summary = {
        "total_raw_event_records": int(len(raw_df)),
        "invalid_timestamp_records_dropped": int(invalid_timestamp_count),
        "records_after_timestamp_cleaning": int(len(collisions)),
        "records_with_latitude_longitude": int(has_coordinates.sum()),
        "records_mapped_to_taxi_zones": int(mapped_mask.sum()),
        "records_not_mapped": int((~mapped_mask).sum()),
        "citywide_only_records": int((~mapped_mask).sum()),
        "unique_mapped_zones": int(collisions.loc[mapped_mask, "zone_id"].nunique()),
        "event_active_hours": int(collisions["timestamp"].nunique()),
        "citywide_fallback_used": bool((~mapped_mask).sum() > 0),
    }
    return features[base_columns], summary


def build_event_context(panel_df: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    cfg = settings.context_cfg.get("events", {})
    neutral = _neutral_event_features(panel_df)
    if not bool(cfg.get("enabled", True)) or panel_df.empty:
        return neutral
    if pd.to_datetime(panel_df["timestamp"]).nunique() < 24 * 14:
        return neutral
    start = pd.to_datetime(panel_df["timestamp"]).min().normalize()
    end = pd.to_datetime(panel_df["timestamp"]).max().normalize()

    collision_features = pd.DataFrame(columns=["timestamp", "zone_id", "zone_incident_count", "citywide_incident_count", "incident_flag", "accident_flag", "event_intensity_score"])
    integration_summary: dict = {}
    try:
        collision_raw = download_collision_data(start=start, end=end, settings=settings)
        collision_features, integration_summary = preprocess_collision_data(collision_raw, settings)
    except Exception as exc:  # pragma: no cover
        LOGGER.warning("Collision/event download skipped: %s", exc)

    major_events = _expand_time_windows(
        _load_local_table(cfg.get("major_events_path", _events_dir(settings) / "major_events.csv")),
        start_col="start_time",
        end_col="end_time",
        feature_name="event_active",
        value_name="event_intensity",
    )
    road_closures = _expand_time_windows(
        _load_local_table(cfg.get("road_closures_path", _events_dir(settings) / "road_closures.csv")),
        start_col="start_time",
        end_col="end_time",
        feature_name="road_closure_flag",
        value_name="closure_severity",
    )

    merged = neutral.copy()
    if not collision_features.empty:
        city_collision = collision_features[collision_features["zone_id"].isna()].drop(columns=["zone_id"])
        zone_collision = collision_features[collision_features["zone_id"].notna()].copy()
        collision_value_cols = [
            "zone_incident_count",
            "citywide_incident_count",
            "incident_flag",
            "accident_flag",
            "event_intensity_score",
        ]
        if not zone_collision.empty:
            zone_collision["zone_id"] = zone_collision["zone_id"].astype(int)
            zone_collision = zone_collision.rename(columns={column: f"{column}_zone_event" for column in collision_value_cols})
            merged = merged.merge(zone_collision, on=["timestamp", "zone_id"], how="left")
            for column in collision_value_cols:
                event_column = f"{column}_zone_event"
                if event_column in merged.columns:
                    merged[column] = pd.to_numeric(merged[column], errors="coerce").fillna(0.0) + pd.to_numeric(merged[event_column], errors="coerce").fillna(0.0)
                    merged = merged.drop(columns=[event_column])
        if not city_collision.empty:
            city_collision = city_collision.rename(columns={column: f"{column}_city_event" for column in collision_value_cols})
            merged = merged.merge(city_collision, on=["timestamp"], how="left")
            for column in collision_value_cols:
                event_column = f"{column}_city_event"
                if event_column in merged.columns:
                    if column == "zone_incident_count":
                        merged = merged.drop(columns=[event_column])
                        continue
                    merged[column] = pd.to_numeric(merged[column], errors="coerce").fillna(0.0) + pd.to_numeric(merged[event_column], errors="coerce").fillna(0.0)
                    merged = merged.drop(columns=[event_column])

    for event_df, flag_col, value_col in [
        (major_events, "event_active", "event_intensity"),
        (road_closures, "road_closure_flag", "closure_severity"),
    ]:
        if event_df.empty:
            continue
        zone_specific = event_df[event_df["zone_id"].notna()].copy()
        citywide = event_df[event_df["zone_id"].isna()].drop(columns=["zone_id"])
        if not zone_specific.empty:
            zone_specific["zone_id"] = zone_specific["zone_id"].astype(int)
            merged = merged.merge(zone_specific, on=["timestamp", "zone_id"], how="left", suffixes=("", "_local"))
            local_flag = f"{flag_col}_local"
            local_value = f"{value_col}_local"
            if local_flag in merged.columns:
                merged[flag_col] = merged[[flag_col, local_flag]].fillna(0).max(axis=1)
                merged = merged.drop(columns=[local_flag])
            if local_value in merged.columns:
                base_col = value_col if value_col in merged.columns else None
                if base_col is None:
                    merged[value_col] = merged[local_value]
                else:
                    merged[value_col] = merged[[base_col, local_value]].fillna(0).sum(axis=1)
                merged = merged.drop(columns=[local_value])
        if not citywide.empty:
            merged = merged.merge(citywide, on=["timestamp"], how="left", suffixes=("", "_citywide"))
            city_flag = f"{flag_col}_citywide"
            city_value = f"{value_col}_citywide"
            if city_flag in merged.columns:
                merged[flag_col] = merged[[flag_col, city_flag]].fillna(0).max(axis=1)
                merged = merged.drop(columns=[city_flag])
            if city_value in merged.columns:
                base_col = value_col if value_col in merged.columns else None
                if base_col is None:
                    merged[value_col] = merged[city_value]
                else:
                    merged[value_col] = merged[[base_col, city_value]].fillna(0).sum(axis=1)
                merged = merged.drop(columns=[city_value])

    merged["zone_incident_count"] = pd.to_numeric(merged.get("zone_incident_count"), errors="coerce").fillna(0.0)
    merged["citywide_incident_count"] = pd.to_numeric(merged.get("citywide_incident_count"), errors="coerce").fillna(0.0)
    merged["incident_flag"] = (merged["incident_flag"].fillna(0) > 0).astype(int)
    merged["accident_flag"] = (merged["accident_flag"].fillna(0) > 0).astype(int)
    merged["road_closure_flag"] = (merged["road_closure_flag"].fillna(0) > 0).astype(int)
    merged["event_intensity"] = pd.to_numeric(merged.get("event_intensity"), errors="coerce").fillna(0.0)
    merged["event_intensity_score"] = pd.to_numeric(merged.get("event_intensity_score"), errors="coerce").fillna(0.0) + merged["event_intensity"]
    merged["road_disruption_flag"] = ((merged["road_closure_flag"] > 0) | (merged["incident_flag"] > 0)).astype(int)
    merged["event_flag"] = ((merged["event_active"].fillna(0) > 0) | (merged["incident_flag"] > 0) | (merged["road_closure_flag"] > 0)).astype(int)
    merged["disruption_score"] = merged["event_intensity_score"] + merged["road_closure_flag"] + merged["incident_flag"]
    merged["event_mapping_quality"] = np.select(
        [merged["zone_incident_count"] > 0, merged["citywide_incident_count"] > 0],
        ["zone_specific", "citywide"],
        default="none",
    )
    merged = merged[["timestamp", "zone_id"] + EVENT_COLUMNS[2:]].copy()
    write_dataframe(merged, _processed_path(settings))

    integration_summary.update(
        {
            "number_of_event_feature_rows": int(len(merged)),
            "event_feature_rows_with_event_flag": int((merged["event_flag"] == 1).sum()),
            "event_feature_rows_with_incident_flag": int((merged["incident_flag"] == 1).sum()),
            "percentage_final_rows_event_flag_1": float((merged["event_flag"] == 1).mean() * 100) if len(merged) else 0.0,
            "percentage_final_rows_incident_flag_1": float((merged["incident_flag"] == 1).mean() * 100) if len(merged) else 0.0,
        }
    )
    _write_event_summary(integration_summary, settings)
    return merged
