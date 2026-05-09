"""Data layer for the MASEER FastAPI service.

Dashboard hourly rows are loaded in priority order:

    1. ``data/processed/dashboard_zone_hour_light.parquet`` (narrow cache)
    2. Pruned columns from ``zone_hour_features.parquet`` (``MASEER_FEATURES_PATH`` optional)
    3. Stream-built light parquet when the full file cannot be read into RAM
    4. ``zone_hour_aggregates.parquet`` / ``final_merged_dataset.parquet`` (same column filter)
    5. ``frontend/public/data/zone_pressure.json`` only when no processed parquet is usable

Other artefacts: metrics CSVs, predictions parquet/JSON, weather/collisions CSVs,
taxi zone lookup, and taxi zone GeoJSON.
"""

from __future__ import annotations

import json
import logging
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from src.api.utils import (
    canonical_model_order,
    clean_records,
    compute_pressure_ratio,
    find_existing_file,
    iso,
    normalize_model_name,
    pressure_label,
    safe_number,
    safe_ratio,
)
from src.config.settings import PROJECT_ROOT


logger = logging.getLogger("maseer.api")


# ---------------------------------------------------------------------------
# Constants and known paths
# ---------------------------------------------------------------------------


TARGET_COLUMN = "target_pickup_count_next_hour"
PROXY_NOTE = (
    "Proxy measure; NYC TLC trip data does not include a direct passenger "
    "waiting-time label. Pressure ratio is predicted next-hour pickups divided "
    "by the trailing 24-hour rolling mean for the same zone."
)
DATA_SOURCES = [
    "NYC TLC Yellow Trip Data",
    "Taxi Zone Lookup",
    "Open-Meteo Weather",
    "NYC Collisions / Event Incidents",
]

DATA_DIR = PROJECT_ROOT / "data"
PROCESSED_DIR = DATA_DIR / "processed"
EXTERNAL_DIR = DATA_DIR / "external"
ARTIFACTS_DIR = PROJECT_ROOT / "artifacts"
REPORTS_DIR = PROJECT_ROOT / "reports"
FRONTEND_DATA_DIR = PROJECT_ROOT / "frontend" / "public" / "data"
FRONTEND_FIGURES_DIR = PROJECT_ROOT / "frontend" / "public" / "figures"

# Narrow on-disk cache built automatically when the full features parquet exists
# but cannot be read into RAM even with column pruning.
DASHBOARD_LIGHT_PARQUET = PROCESSED_DIR / "dashboard_zone_hour_light.parquet"

_DASHBOARD_LOAD_META: dict[str, Any] = {
    "dashboard_dataset_path": None,
    "dashboard_source_tag": None,
    "fallback_snapshot_used": False,
    "processed_parquet_failed": False,
}

ZONE_LOOKUP_CANDIDATES: list[str | Path] = [
    EXTERNAL_DIR / "taxi_zone_lookup.csv",
    PROCESSED_DIR / "taxi_zone_lookup.csv",
]

GEOJSON_CANDIDATES: list[str | Path] = [
    EXTERNAL_DIR / "taxi_zones.geojson",
    EXTERNAL_DIR / "taxi_zones.json",
    EXTERNAL_DIR / "taxi_zones.zip",
    FRONTEND_DATA_DIR / "taxi_zones.geojson",
    PROCESSED_DIR / "taxi_zones.geojson",
]

WEATHER_CANDIDATES: list[str | Path] = [
    EXTERNAL_DIR / "weather" / "weather_nyc_20240101_20240331.csv",
    EXTERNAL_DIR / "weather_nyc_20240101_20240331.csv",
    PROCESSED_DIR / "weather_hourly.csv",
]

COLLISION_CANDIDATES: list[str | Path] = [
    EXTERNAL_DIR / "events" / "collisions_20240101_20240331.csv",
    EXTERNAL_DIR / "events" / "collisions.csv",
    PROCESSED_DIR / "collisions_hourly.csv",
]

EXCLUDE_TEXT = ("outside of nyc", "outside", "none")


def _api_selected_model(model: str | None) -> str:
    """Normalised model from query/body; when omitted, default to XGBoost (API contract)."""

    if model is None or (isinstance(model, str) and not str(model).strip()):
        return "XGBoost"
    normalized = normalize_model_name(model)
    return normalized if normalized else str(model).strip()


WEATHER_CODE_CATEGORY = {
    0: "Clear",
    1: "Mainly Clear",
    2: "Partly Cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing Rime Fog",
    51: "Light Drizzle",
    53: "Drizzle",
    55: "Heavy Drizzle",
    56: "Freezing Drizzle",
    57: "Heavy Freezing Drizzle",
    61: "Light Rain",
    63: "Rain",
    65: "Heavy Rain",
    66: "Freezing Rain",
    67: "Heavy Freezing Rain",
    71: "Light Snow",
    73: "Snow",
    75: "Heavy Snow",
    77: "Snow Grains",
    80: "Rain Showers",
    81: "Heavy Rain Showers",
    82: "Violent Rain Showers",
    85: "Snow Showers",
    86: "Heavy Snow Showers",
    95: "Thunderstorm",
    96: "Thunderstorm with Hail",
    99: "Severe Thunderstorm",
}


# ---------------------------------------------------------------------------
# Internal IO helpers
# ---------------------------------------------------------------------------


def _safe_read_json(path: Path | None) -> Any | None:
    if path is None or not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        logger.warning("Failed to read JSON %s", path, exc_info=True)
        return None


def _safe_read_csv(path: Path | None, **kwargs: Any) -> pd.DataFrame | None:
    if path is None or not path.exists():
        return None
    try:
        return pd.read_csv(path, **kwargs)
    except Exception:
        logger.warning("Failed to read CSV %s", path, exc_info=True)
        return None


def _safe_read_parquet(path: Path | None) -> pd.DataFrame | None:
    if path is None or not path.exists():
        return None
    try:
        return pd.read_parquet(path)
    except Exception:
        logger.warning("Failed to read parquet %s", path, exc_info=True)
        return None


def get_dashboard_load_meta() -> dict[str, Any]:
    """Last-resolved dashboard frame provenance (populated when ``load_final_dataset`` runs)."""

    return dict(_DASHBOARD_LOAD_META)


# Canonical dashboard column -> acceptable physical names in modeling parquets.
_DASHBOARD_CANONICAL_ALIASES: dict[str, tuple[str, ...]] = {
    "timestamp": ("timestamp", "datetime", "pickup_datetime", "hour_start", "ts"),
    "zone_id": ("zone_id", "PULocationID", "LocationID", "location_id"),
    "zone_name": ("zone_name", "Zone"),
    "borough": ("borough", "Borough"),
    "service_zone": ("service_zone", "ServiceZone"),
    "pickup_count": ("pickup_count",),
    "pickup_count_roll_mean_24": ("pickup_count_roll_mean_24",),
    TARGET_COLUMN: (TARGET_COLUMN,),
    "temperature": ("temperature",),
    "precipitation": ("precipitation",),
    "snowfall": ("snowfall",),
    "wind_speed": ("wind_speed",),
    "humidity": ("humidity",),
    "weather_category": ("weather_category",),
    "weather_status": ("weather_status",),
    "event_intensity_score": ("event_intensity_score",),
    "disruption_score": ("disruption_score",),
    "zone_incident_count": ("zone_incident_count",),
    "citywide_incident_count": ("citywide_incident_count",),
    "incident_flag": ("incident_flag",),
    "event_flag": ("event_flag",),
    "road_closure_flag": ("road_closure_flag",),
    "predicted_next_hour_pickups": ("predicted_next_hour_pickups",),
    "event_active": ("event_active",),
}


_DASHBOARD_REQUIRED_CANONICAL = (
    "timestamp",
    "zone_id",
    "pickup_count",
    "pickup_count_roll_mean_24",
    TARGET_COLUMN,
)


def _parquet_schema_column_names(path: Path) -> list[str]:
    import pyarrow.parquet as pq

    return list(pq.ParquetFile(path).schema_arrow.names)


def _dashboard_read_plan(available: Iterable[str]) -> tuple[list[str], dict[str, str]] | None:
    """Return (columns_to_read, physical_name -> canonical_name)."""

    have = set(available)
    read_cols: list[str] = []
    rename: dict[str, str] = {}
    for canon, aliases in _DASHBOARD_CANONICAL_ALIASES.items():
        for phys in aliases:
            if phys in have:
                read_cols.append(phys)
                rename[phys] = canon
                break
    for req in _DASHBOARD_REQUIRED_CANONICAL:
        if req not in rename.values():
            return None
    return read_cols, rename


def _read_parquet_dashboard_columns(path: Path) -> pd.DataFrame | None:
    """Memory-safe read: only dashboard columns via ``columns=``."""

    if not path.is_file():
        return None
    try:
        names = _parquet_schema_column_names(path)
    except Exception:
        logger.warning("Unable to read parquet schema for %s", path, exc_info=True)
        return None
    plan = _dashboard_read_plan(names)
    if plan is None:
        logger.warning(
            "Dashboard parquet %s is missing required columns (have: %s).",
            path,
            sorted(names)[:40],
        )
        return None
    read_cols, rename = plan
    try:
        df = pd.read_parquet(path, columns=read_cols)
    except Exception as exc:
        exc_name = type(exc).__name__
        if "ArrowMemory" in exc_name or "MemoryError" in exc_name:
            logger.warning(
                "Full modeling parquet exists but selected-column load failed (%s): %s",
                exc_name,
                path,
            )
        else:
            logger.warning("Parquet read failed for %s: %s", path, exc, exc_info=True)
        return None
    df = df.rename(columns=rename)
    return df


def materialize_dashboard_light_parquet(source: Path, dest: Path) -> bool:
    """Stream ``source`` to ``dest`` using only dashboard columns (row batches)."""

    import pyarrow as pa
    import pyarrow.parquet as pq

    if not source.is_file():
        return False
    try:
        names = _parquet_schema_column_names(source)
    except Exception:
        logger.exception("materialize: cannot read schema for %s", source)
        return False
    plan = _dashboard_read_plan(names)
    if plan is None:
        logger.error("materialize: required columns missing in %s", source)
        return False
    read_cols, _rename = plan
    tmp = dest.with_suffix(".tmp.parquet")
    if tmp.exists():
        try:
            tmp.unlink()
        except OSError:
            pass
    writer: pq.ParquetWriter | None = None
    try:
        pf = pq.ParquetFile(source)
        for batch in pf.iter_batches(columns=read_cols, batch_size=32_768):
            tbl = pa.Table.from_batches([batch])
            if writer is None:
                writer = pq.ParquetWriter(str(tmp), tbl.schema, compression="snappy")
            writer.write_table(tbl)
        if writer is not None:
            writer.close()
            writer = None
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp.replace(dest)
        logger.info("Created lightweight dashboard parquet at %s", dest)
        return True
    except Exception:
        logger.exception(
            "materialize_dashboard_light_parquet failed (source=%s dest=%s)",
            source,
            dest,
        )
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        return False


def _post_process_dashboard_frame(df: pd.DataFrame, source_tag: str) -> pd.DataFrame:
    if df.empty:
        out = df.copy()
        out["__source__"] = source_tag
        return out
    # Avoid a full deep copy of large frames (Arrow-backed columns may still OOM on copy).
    out = df
    out = _normalize_timestamp_column(out, "timestamp")
    if "zone_id" not in out.columns:
        for src, dst in (
            ("PULocationID", "zone_id"),
            ("LocationID", "zone_id"),
            ("location_id", "zone_id"),
        ):
            if src in out.columns:
                out["zone_id"] = out[src]
                break
    if "zone_id" in out.columns:
        out["zone_id"] = pd.to_numeric(out["zone_id"], errors="coerce")
        out = out.dropna(subset=["zone_id"])
        out["zone_id"] = out["zone_id"].astype(int)
    if "zone_name" not in out.columns and "Zone" in out.columns:
        out = out.rename(columns={"Zone": "zone_name"})
    if "borough" not in out.columns and "Borough" in out.columns:
        out = out.rename(columns={"Borough": "borough"})
    out = _attach_zone_lookup(out)
    out["__source__"] = source_tag
    return out


def _load_zone_pressure_json_frame() -> pd.DataFrame:
    payload = _safe_read_json(FRONTEND_DATA_DIR / "zone_pressure.json")
    if not isinstance(payload, list) or not payload:
        return pd.DataFrame()
    df = pd.DataFrame(payload)
    return _post_process_dashboard_frame(df, "zone_pressure_export")


def _try_read_dashboard_parquet_chain() -> tuple[pd.DataFrame | None, dict[str, Any]]:
    """Try processed parquets in API priority order. Returns (df or None, meta updates)."""

    meta_updates: dict[str, Any] = {
        "dashboard_dataset_path": None,
        "dashboard_source_tag": None,
        "processed_parquet_failed": False,
    }

    if DASHBOARD_LIGHT_PARQUET.is_file():
        df = _read_parquet_dashboard_columns(DASHBOARD_LIGHT_PARQUET)
        if df is not None and not df.empty:
            meta_updates["dashboard_dataset_path"] = str(DASHBOARD_LIGHT_PARQUET)
            meta_updates["dashboard_source_tag"] = "dashboard_zone_hour_light"
            return df, meta_updates

    feature_candidates: list[Path] = []
    env = os.environ.get("MASEER_FEATURES_PATH")
    if env:
        ep = Path(env)
        if ep.is_file():
            feature_candidates.append(ep)
    zf = PROCESSED_DIR / "zone_hour_features.parquet"
    if zf.is_file() and zf not in feature_candidates:
        feature_candidates.append(zf)

    for fp in feature_candidates:
        df = _read_parquet_dashboard_columns(fp)
        if df is not None and not df.empty:
            meta_updates["dashboard_dataset_path"] = str(fp)
            meta_updates["dashboard_source_tag"] = "zone_hour_features"
            return df, meta_updates
        if fp.is_file():
            logger.warning(
                "Full modeling parquet exists but selected-column load failed: %s",
                fp,
            )
            meta_updates["processed_parquet_failed"] = True
            if materialize_dashboard_light_parquet(fp, DASHBOARD_LIGHT_PARQUET):
                df2 = _read_parquet_dashboard_columns(DASHBOARD_LIGHT_PARQUET)
                if df2 is not None and not df2.empty:
                    meta_updates["processed_parquet_failed"] = False
                    meta_updates["dashboard_dataset_path"] = str(DASHBOARD_LIGHT_PARQUET)
                    meta_updates["dashboard_source_tag"] = "dashboard_zone_hour_light_materialized"
                    return df2, meta_updates

    for alt in (PROCESSED_DIR / "zone_hour_aggregates.parquet", PROCESSED_DIR / "final_merged_dataset.parquet"):
        if str(alt) in {str(p) for p in feature_candidates} or not alt.is_file():
            continue
        df = _read_parquet_dashboard_columns(alt)
        if df is not None and not df.empty:
            meta_updates["dashboard_dataset_path"] = str(alt)
            meta_updates["dashboard_source_tag"] = alt.stem
            return df, meta_updates

    return None, meta_updates


def _geojson_from_zip(zip_path: Path) -> dict[str, Any] | None:
    """Build a GeoJSON FeatureCollection from a zipped shapefile (TLC layout)."""

    import json
    import tempfile
    import zipfile

    try:
        import geopandas as gpd
    except ImportError:
        logger.warning("geopandas is required to read taxi_zones.zip")
        return None
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            shp_members = [n for n in zf.namelist() if n.lower().endswith(".shp")]
            if not shp_members:
                return None
            with tempfile.TemporaryDirectory() as tmp:
                zf.extractall(tmp)
                shp_path = Path(tmp) / shp_members[0]
                gdf = gpd.read_file(shp_path)
    except Exception:
        logger.warning("Failed to read shapefile inside %s", zip_path, exc_info=True)
        return None
    if gdf.empty:
        return None
    try:
        if gdf.crs is not None:
            gdf = gdf.to_crs(4326)
    except Exception:
        logger.warning("CRS reprojection to EPSG:4326 failed for %s", zip_path, exc_info=True)
        return None
    try:
        payload = json.loads(gdf.to_json())
    except Exception:
        logger.warning("GeoJSON serialisation failed for %s", zip_path, exc_info=True)
        return None
    if payload.get("type") != "FeatureCollection":
        return None
    return payload


def _is_valid_zone(zone_name: Any, borough: Any) -> bool:
    if zone_name is None or borough is None:
        return False
    try:
        if pd.isna(zone_name) or pd.isna(borough):
            return False
    except (TypeError, ValueError):
        pass
    zn = str(zone_name).strip().lower()
    br = str(borough).strip().lower()
    if not zn or not br:
        return False
    if any(token in zn for token in EXCLUDE_TEXT):
        return False
    if any(token in br for token in EXCLUDE_TEXT):
        return False
    return True


def _valid_zone_mask(df: pd.DataFrame) -> pd.Series:
    """Vectorized version of ``_is_valid_zone`` for full DataFrames.

    The simple ``df.apply(..., axis=1)`` approach materialises the entire
    frame as a single object array, which is prohibitively expensive on the
    485k-row modeling dataset.  Working column-wise stays inside numpy's
    string kernels and is ~100x faster.
    """

    if df.empty:
        return pd.Series([], dtype=bool)
    name_col = df.get("zone_name")
    borough_col = df.get("borough")
    if name_col is None or borough_col is None:
        return pd.Series(False, index=df.index)
    name_lower = name_col.astype("string").str.strip().str.lower()
    borough_lower = borough_col.astype("string").str.strip().str.lower()
    not_blank = name_lower.notna() & borough_lower.notna() & (name_lower != "") & (borough_lower != "")
    bad = pd.Series(False, index=df.index)
    for token in EXCLUDE_TEXT:
        bad = bad | name_lower.str.contains(token, na=False)
        bad = bad | borough_lower.str.contains(token, na=False)
    return not_blank & ~bad


def _normalize_timestamp_column(df: pd.DataFrame, column: str = "timestamp") -> pd.DataFrame:
    if column in df.columns:
        df[column] = pd.to_datetime(df[column], errors="coerce")
    return df


def _weather_status_from_code(code: Any) -> str:
    code_value = safe_number(code)
    if code_value is None:
        return "Unknown"
    try:
        return WEATHER_CODE_CATEGORY.get(int(code_value), "Unknown")
    except (TypeError, ValueError):
        return "Unknown"


# ---------------------------------------------------------------------------
# Cached loaders
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def load_training_manifest() -> dict[str, Any]:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "training_manifest.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_forecast_manifest() -> dict[str, Any]:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "forecast_manifest.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_run_summary() -> dict[str, Any]:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "run_summary.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_dataset_summary() -> dict[str, Any]:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "final_merged_dataset_summary.json")
    if isinstance(payload, dict) and payload:
        return payload
    fallback = _safe_read_json(FRONTEND_DATA_DIR / "dataset_summary.json")
    return fallback if isinstance(fallback, dict) else {}


@lru_cache(maxsize=1)
def load_overview_meta() -> dict[str, Any]:
    payload = _safe_read_json(FRONTEND_DATA_DIR / "overview.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_zone_lookup() -> pd.DataFrame:
    """Return the official TLC zone lookup with normalized columns."""

    path = find_existing_file(ZONE_LOOKUP_CANDIDATES)
    df = _safe_read_csv(path)
    if df is None:
        logger.warning("Zone lookup CSV not found in any candidate path.")
        return pd.DataFrame(columns=["zone_id", "zone_name", "borough", "service_zone"])
    rename = {}
    for src, dst in (
        ("LocationID", "zone_id"),
        ("locationid", "zone_id"),
        ("location_id", "zone_id"),
        ("PULocationID", "zone_id"),
        ("Borough", "borough"),
        ("Zone", "zone_name"),
        ("zone", "zone_name"),
    ):
        if src in df.columns and dst not in df.columns:
            rename[src] = dst
    if rename:
        df = df.rename(columns=rename)
    if "service_zone" not in df.columns and "ServiceZone" in df.columns:
        df = df.rename(columns={"ServiceZone": "service_zone"})
    if "zone_id" in df.columns:
        df["zone_id"] = pd.to_numeric(df["zone_id"], errors="coerce").astype("Int64")
    keep = [c for c in ["zone_id", "zone_name", "borough", "service_zone"] if c in df.columns]
    df = df[keep].dropna(subset=["zone_id"]).copy()
    df["zone_id"] = df["zone_id"].astype(int)
    return df.reset_index(drop=True)


@lru_cache(maxsize=1)
def load_geojson() -> dict[str, Any] | None:
    path = find_existing_file(GEOJSON_CANDIDATES)
    payload: dict[str, Any] | None = None
    if path is not None:
        if path.suffix.lower() == ".zip":
            payload = _geojson_from_zip(path)
        else:
            raw = _safe_read_json(path)
            payload = raw if isinstance(raw, dict) else None
    if not isinstance(payload, dict):
        return None
    if payload.get("type") != "FeatureCollection":
        return None
    # Make sure zone_id property exists on every feature (some datasets only
    # include LocationID).  We patch the lookup if the field is missing.
    lookup = load_zone_lookup()
    name_by_id: dict[int, dict[str, Any]] = {}
    if not lookup.empty:
        name_by_id = {
            int(row.zone_id): {
                "zone_name": row.zone_name,
                "borough": row.borough,
                "service_zone": row.service_zone,
            }
            for row in lookup.itertuples()
        }
    for feature in payload.get("features", []):
        props = feature.setdefault("properties", {})
        location_id = props.get("zone_id") or props.get("LocationID") or props.get("OBJECTID")
        try:
            location_id = int(location_id) if location_id is not None else None
        except (TypeError, ValueError):
            location_id = None
        if location_id is not None:
            props["zone_id"] = location_id
            props["LocationID"] = location_id
            meta = name_by_id.get(location_id)
            if meta:
                props.setdefault("zone_name", meta.get("zone_name"))
                props.setdefault("borough", meta.get("borough"))
                props.setdefault("service_zone", meta.get("service_zone"))
    return payload


@lru_cache(maxsize=1)
def load_model_metrics() -> pd.DataFrame:
    """Return all known model metrics merged into a single tidy frame."""

    frames: list[pd.DataFrame] = []
    for csv_path in [
        ARTIFACTS_DIR / "metrics" / "model_metrics.csv",
        ARTIFACTS_DIR / "metrics" / "model_metrics_contextual.csv",
        ARTIFACTS_DIR / "metrics" / "model_metrics_base.csv",
        ARTIFACTS_DIR / "metrics" / "sequence_metrics.csv",
    ]:
        df = _safe_read_csv(csv_path)
        if df is None or df.empty:
            continue
        df = df.copy()
        if "scenario" not in df.columns:
            df["scenario"] = "contextual"
        frames.append(df)
    if not frames:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "model_metrics.json")
        if isinstance(fallback, list):
            frames.append(pd.DataFrame(fallback))
    if not frames:
        return pd.DataFrame(
            columns=[
                "model_name",
                "model_family",
                "scenario",
                "test_mae",
                "test_rmse",
                "test_r2",
                "test_smape",
            ]
        )
    df = pd.concat(frames, ignore_index=True, sort=False)
    df["model_name_canonical"] = df["model_name"].apply(normalize_model_name)
    # Keep the row with the lowest test_rmse per model_name + scenario.
    sort_cols = [c for c in ["test_rmse", "test_mae"] if c in df.columns]
    if sort_cols:
        df = df.sort_values(sort_cols, ascending=True, na_position="last")
    df = df.drop_duplicates(subset=["model_name_canonical", "scenario"], keep="first")
    df = df.reset_index(drop=True)
    return df


@lru_cache(maxsize=1)
def load_forecast_metrics() -> pd.DataFrame:
    df = _safe_read_csv(ARTIFACTS_DIR / "metrics" / "forecast_metrics.csv")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "forecast_metrics.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.copy()
    df["model_name_canonical"] = df["model_name"].apply(normalize_model_name)
    return df.reset_index(drop=True)


@lru_cache(maxsize=1)
def load_forecast_horizon_metrics() -> pd.DataFrame:
    df = _safe_read_csv(ARTIFACTS_DIR / "metrics" / "forecast_horizon_metrics.csv")
    if df is None:
        return pd.DataFrame()
    return df.copy().reset_index(drop=True)


@lru_cache(maxsize=1)
def load_contextual_comparison() -> pd.DataFrame:
    df = _safe_read_csv(ARTIFACTS_DIR / "metrics" / "contextual_comparison.csv")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "contextual_comparison.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    return pd.DataFrame() if df is None else df.reset_index(drop=True)


def best_tabular_model() -> str:
    manifest = load_training_manifest()
    run = load_run_summary()
    overview = load_overview_meta()
    candidate = (
        manifest.get("best_tabular_model")
        or run.get("best_tabular_model")
        or overview.get("best_tabular_model")
        or "XGBoost"
    )
    canonical = normalize_model_name(candidate) or candidate
    return str(canonical)


def best_forecast_model() -> str:
    manifest = load_forecast_manifest()
    run = load_run_summary()
    overview = load_overview_meta()
    candidate = (
        manifest.get("best_forecast_model")
        or run.get("best_forecast_model")
        or overview.get("best_forecast_model")
        or "GRU 24H Forecaster"
    )
    canonical = normalize_model_name(candidate) or candidate
    return str(candidate)  # Keep the descriptive original (e.g., "GRU 24H Forecaster").


# ---------------------------------------------------------------------------
# Dataset loaders (zone snapshot + weather backbone)
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def load_final_dataset() -> pd.DataFrame:
    """Zone-hour dashboard frame.

    Priority:
        1. ``data/processed/dashboard_zone_hour_light.parquet`` (narrow cache).
        2. Selected columns from ``zone_hour_features.parquet`` (or ``MASEER_FEATURES_PATH``).
        3. If (2) exists on disk but read fails, stream materialize → light parquet, then read light.
        4. ``zone_hour_aggregates.parquet`` / ``final_merged_dataset.parquet`` with the same column filter.
        5. ``frontend/public/data/zone_pressure.json`` only when no processed parquet is usable
           (or after loud warnings when processed data existed but could not be loaded).
    """

    global _DASHBOARD_LOAD_META

    raw, meta_updates = _try_read_dashboard_parquet_chain()
    _DASHBOARD_LOAD_META.update(
        {
            "dashboard_dataset_path": None,
            "dashboard_source_tag": None,
            "fallback_snapshot_used": False,
            "processed_parquet_failed": bool(meta_updates.get("processed_parquet_failed")),
        }
    )
    _DASHBOARD_LOAD_META.update(meta_updates)

    if raw is not None and not raw.empty:
        tag = str(meta_updates.get("dashboard_source_tag") or "processed_parquet")
        out = _post_process_dashboard_frame(raw, tag)
        _DASHBOARD_LOAD_META["dashboard_dataset_path"] = meta_updates.get("dashboard_dataset_path")
        _DASHBOARD_LOAD_META["dashboard_source_tag"] = tag
        return out

    _candidates = [
        DASHBOARD_LIGHT_PARQUET,
        PROCESSED_DIR / "zone_hour_features.parquet",
        PROCESSED_DIR / "zone_hour_aggregates.parquet",
        PROCESSED_DIR / "final_merged_dataset.parquet",
    ]
    envp = os.environ.get("MASEER_FEATURES_PATH")
    if envp:
        _candidates.insert(1, Path(envp))
    processed_exists = any(p.is_file() for p in _candidates if isinstance(p, Path))

    if processed_exists:
        logger.warning(
            "WARNING: API is using one-timestamp fallback snapshot from zone_pressure.json "
            "(processed modeling parquet exists but could not be loaded or materialized)."
        )

    fb = _load_zone_pressure_json_frame()
    _DASHBOARD_LOAD_META["fallback_snapshot_used"] = not fb.empty
    _DASHBOARD_LOAD_META["dashboard_dataset_path"] = str(FRONTEND_DATA_DIR / "zone_pressure.json")
    _DASHBOARD_LOAD_META["dashboard_source_tag"] = "zone_pressure_export"
    return fb


# Backwards-compatible name used throughout the service module.
load_zone_snapshot_frame = load_final_dataset


def _slice_zone_hour_for_aggregations(
    snap: pd.DataFrame,
    *,
    extra: tuple[str, ...] = (),
) -> pd.DataFrame:
    """Drop wide feature columns before groupby / prediction joins (memory safety)."""

    keep = [
        "timestamp",
        "zone_id",
        "borough",
        "zone_name",
        "pickup_count",
        TARGET_COLUMN,
        "pickup_count_roll_mean_24",
        "zone_incident_count",
        "citywide_incident_count",
        *extra,
    ]
    use = []
    seen: set[str] = set()
    for c in keep:
        if c in snap.columns and c not in seen:
            use.append(c)
            seen.add(c)
    if not use:
        return snap.copy()
    return snap[use].copy()


def _attach_zone_lookup(df: pd.DataFrame) -> pd.DataFrame:
    """Ensure zone_name / borough / service_zone columns exist and are sane."""

    lookup = load_zone_lookup()
    if lookup.empty or "zone_id" not in df.columns:
        return df
    have_name = "zone_name" in df.columns
    have_borough = "borough" in df.columns
    have_service = "service_zone" in df.columns
    if have_name and have_borough and have_service:
        return df
    merged = df.merge(
        lookup.rename(
            columns={
                "zone_name": "zone_name_lookup",
                "borough": "borough_lookup",
                "service_zone": "service_zone_lookup",
            }
        ),
        on="zone_id",
        how="left",
    )
    for col, lookup_col in (
        ("zone_name", "zone_name_lookup"),
        ("borough", "borough_lookup"),
        ("service_zone", "service_zone_lookup"),
    ):
        if col not in merged.columns:
            merged[col] = merged[lookup_col]
        else:
            merged[col] = merged[col].fillna(merged[lookup_col])
    drop = [c for c in ["zone_name_lookup", "borough_lookup", "service_zone_lookup"] if c in merged.columns]
    return merged.drop(columns=drop)


# ---------------------------------------------------------------------------
# Predictions
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def load_model_predictions() -> pd.DataFrame:
    """Long-format predictions per (timestamp, zone_id, model)."""

    frames: list[pd.DataFrame] = []
    pred_path = ARTIFACTS_DIR / "predictions" / "test_predictions.parquet"
    if pred_path.is_file():
        want = ["timestamp", "zone_id", "model_name", "y_true", "y_pred", "actual", "predicted"]
        try:
            names = set(_parquet_schema_column_names(pred_path))
            cols = [c for c in want if c in names]
            if cols:
                parquet_df = pd.read_parquet(pred_path, columns=cols)
            else:
                parquet_df = None
        except Exception:
            logger.warning("Predictions parquet read failed: %s", pred_path, exc_info=True)
            parquet_df = None
        if parquet_df is not None and not parquet_df.empty:
            frames.append(parquet_df)
    fallback = _safe_read_json(FRONTEND_DATA_DIR / "predictions_preview.json")
    if isinstance(fallback, list) and fallback:
        frames.append(pd.DataFrame(fallback))
    if not frames:
        return pd.DataFrame(
            columns=["timestamp", "zone_id", "model_name", "actual", "predicted"]
        )
    df = pd.concat(frames, ignore_index=True, sort=False)
    df = _normalize_timestamp_column(df, "timestamp")
    rename = {"y_true": "actual", "y_pred": "predicted"}
    for old, new in rename.items():
        if old in df.columns and new not in df.columns:
            df[new] = df[old]
    if "zone_id" in df.columns:
        df["zone_id"] = pd.to_numeric(df["zone_id"], errors="coerce")
        df = df.dropna(subset=["zone_id"]).copy()
        df["zone_id"] = df["zone_id"].astype(int)
    if "model_name" in df.columns:
        df["model_name_canonical"] = df["model_name"].apply(normalize_model_name)
    else:
        df["model_name_canonical"] = normalize_model_name(best_tabular_model()) or best_tabular_model()
    return df


# ---------------------------------------------------------------------------
# Hourly weather backbone & collisions
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def load_weather_hourly() -> pd.DataFrame:
    path = find_existing_file(WEATHER_CANDIDATES)
    df = _safe_read_csv(path)
    if df is None:
        return pd.DataFrame(
            columns=[
                "timestamp",
                "temperature",
                "precipitation",
                "snowfall",
                "wind_speed",
                "humidity",
                "weather_code",
                "weather_status",
            ]
        )
    df = df.copy()
    df = _normalize_timestamp_column(df, "timestamp")
    df = df.dropna(subset=["timestamp"]).reset_index(drop=True)
    if "weather_code" in df.columns and "weather_status" not in df.columns:
        df["weather_status"] = df["weather_code"].apply(_weather_status_from_code)
    return df


@lru_cache(maxsize=1)
def load_collisions_hourly() -> pd.DataFrame:
    """Aggregate the raw collisions CSV into a hourly citywide count."""

    path = find_existing_file(COLLISION_CANDIDATES)
    df = _safe_read_csv(path)
    if df is None or df.empty:
        return pd.DataFrame(columns=["timestamp", "citywide_incident_count"])
    df = df.copy()
    if "crash_date" in df.columns and "crash_time" in df.columns:
        date_str = df["crash_date"].astype(str).str.slice(0, 10)
        time_str = df["crash_time"].astype(str).str.strip()
        # crash_time may be H:MM or HH:MM.
        time_str = time_str.where(time_str.str.match(r"^\d"), "00:00")
        time_str = time_str.str.split(":").str[:2].str.join(":").fillna("00:00")
        combined = date_str + " " + time_str
        df["timestamp"] = pd.to_datetime(combined, errors="coerce")
    elif "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    else:
        return pd.DataFrame(columns=["timestamp", "citywide_incident_count"])
    df = df.dropna(subset=["timestamp"])
    df["hour"] = df["timestamp"].dt.floor("h")
    grouped = (
        df.groupby("hour", as_index=False)
        .agg(citywide_incident_count=("collision_id", "count"))
        .rename(columns={"hour": "timestamp"})
    )
    grouped["citywide_incident_count"] = grouped["citywide_incident_count"].astype(int)
    return grouped


# ---------------------------------------------------------------------------
# Composite hourly timeline (real data only).
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def load_hourly_timeline() -> pd.DataFrame:
    """Citywide hourly timeline built from real weather + collision sources.

    The frame has one row per hour and the following columns:
        timestamp, temperature, precipitation, snowfall, wind_speed,
        humidity, weather_status, citywide_incident_count

    No values are invented; missing columns simply remain NaN.
    """

    weather = load_weather_hourly()
    collisions = load_collisions_hourly()
    if weather.empty and collisions.empty:
        return pd.DataFrame()
    df = weather.copy() if not weather.empty else collisions.copy()
    if not weather.empty and not collisions.empty:
        df = weather.merge(collisions, on="timestamp", how="outer")
    elif weather.empty:
        df = collisions
    df = df.sort_values("timestamp").reset_index(drop=True)
    if "citywide_incident_count" in df.columns:
        df["citywide_incident_count"] = (
            pd.to_numeric(df["citywide_incident_count"], errors="coerce")
            .fillna(0)
            .astype(int)
        )
    return df


# ---------------------------------------------------------------------------
# Snapshot helpers
# ---------------------------------------------------------------------------


def _ensure_pressure_columns(df: pd.DataFrame, predicted: pd.Series | None = None) -> pd.DataFrame:
    """Compute pressure_ratio + pressure_label for the supplied frame."""

    if df.empty:
        return df
    if predicted is None:
        predicted = pd.to_numeric(df.get("predicted_next_hour_pickups"), errors="coerce")
        if predicted is None:
            predicted = pd.Series([np.nan] * len(df), index=df.index)
    baseline = pd.to_numeric(df.get("pickup_count_roll_mean_24"), errors="coerce")
    df["pressure_ratio"] = [
        compute_pressure_ratio(p, b) for p, b in zip(predicted, baseline)
    ]
    df["pressure_label"] = df["pressure_ratio"].apply(pressure_label)
    return df


def _predicted_column_and_sources(
    snapshot: pd.DataFrame,
    model: str,
    *,
    fallback_to_target: bool = True,
) -> tuple[pd.Series, pd.Series]:
    """Per-row predicted next-hour pickups and ``prediction_source`` labels."""

    idx = snapshot.index
    predicted = pd.Series(np.nan, index=idx, dtype=float)
    sources = pd.Series("unavailable", index=idx, dtype=object)

    join_pred = pd.Series(np.nan, index=idx, dtype=float)
    preds = load_model_predictions()
    if not preds.empty and "predicted" in preds.columns:
        work = preds.copy()
        if model and "model_name_canonical" in work.columns:
            filtered = work[work["model_name_canonical"] == model]
            if not filtered.empty:
                work = filtered
        if not work.empty and "timestamp" in snapshot.columns:
            tmin = pd.to_datetime(snapshot["timestamp"], errors="coerce").min()
            tmax = pd.to_datetime(snapshot["timestamp"], errors="coerce").max()
            if pd.notna(tmin) and pd.notna(tmax) and "timestamp" in work.columns:
                work = work[(work["timestamp"] >= tmin) & (work["timestamp"] <= tmax)]
        if (
            not work.empty
            and "zone_id" in snapshot.columns
            and "zone_id" in work.columns
            and int(snapshot["zone_id"].nunique()) < 10_000
        ):
            zset = set(pd.to_numeric(snapshot["zone_id"], errors="coerce").dropna().astype(int).unique())
            work = work[work["zone_id"].isin(zset)]
        work = work.drop_duplicates(subset=[c for c in ["timestamp", "zone_id"] if c in work.columns])
        join_cols = [c for c in ["timestamp", "zone_id"] if c in work.columns and c in snapshot.columns]
        if join_cols:
            left = snapshot[join_cols].reset_index(drop=False)
            merged = left.merge(work[join_cols + ["predicted"]], on=join_cols, how="left")
            merged = merged.set_index("index")
            merged.index.name = snapshot.index.name
            join_pred = pd.to_numeric(merged["predicted"], errors="coerce").reindex(idx)

    embedded = (
        pd.to_numeric(snapshot["predicted_next_hour_pickups"], errors="coerce")
        if "predicted_next_hour_pickups" in snapshot.columns
        else None
    )
    target_series = (
        pd.to_numeric(snapshot[TARGET_COLUMN], errors="coerce")
        if TARGET_COLUMN in snapshot.columns
        else None
    )
    pickup_series = (
        pd.to_numeric(snapshot["pickup_count"], errors="coerce")
        if "pickup_count" in snapshot.columns
        else None
    )

    mask_model_join = join_pred.notna()
    predicted.loc[mask_model_join] = join_pred.loc[mask_model_join]
    sources.loc[mask_model_join] = "model_prediction"

    if embedded is not None:
        mask_emb = predicted.isna() & embedded.notna()
        predicted.loc[mask_emb] = embedded.loc[mask_emb]
        sources.loc[mask_emb] = "model_prediction"

    if fallback_to_target and target_series is not None:
        mask_tgt = predicted.isna() & target_series.notna()
        predicted.loc[mask_tgt] = target_series.loc[mask_tgt]
        sources.loc[mask_tgt] = "target_fallback"

    if pickup_series is not None:
        mask_pick = predicted.isna() & pickup_series.notna()
        predicted.loc[mask_pick] = pickup_series.loc[mask_pick]
        sources.loc[mask_pick] = "pickup_proxy"

    return predicted, sources


def _join_predictions_into_snapshot(
    snapshot: pd.DataFrame,
    model: str,
    *,
    fallback_to_target: bool = True,
) -> tuple[pd.Series, str]:
    """Return ``(predicted_series, dominant_source)`` aligned to ``snapshot``."""

    predicted, sources = _predicted_column_and_sources(
        snapshot, model, fallback_to_target=fallback_to_target
    )
    if sources.empty:
        return predicted, "unavailable"
    dominant = str(sources.astype(str).value_counts().idxmax())
    return predicted, dominant


# ---------------------------------------------------------------------------
# Public service functions used by the FastAPI endpoints
# ---------------------------------------------------------------------------


def get_overview() -> dict[str, Any]:
    overview = load_overview_meta()
    summary = load_dataset_summary()
    metrics = load_model_metrics()
    frame = load_final_dataset()

    best_tab = best_tabular_model()
    best_fc = best_forecast_model()

    best_test_mae = best_test_rmse = best_test_r2 = None
    if not metrics.empty:
        candidates = metrics[metrics["model_name_canonical"] == best_tab]
        if not candidates.empty:
            row = candidates.iloc[0]
            best_test_mae = safe_number(row.get("test_mae"))
            best_test_rmse = safe_number(row.get("test_rmse"))
            best_test_r2 = safe_number(row.get("test_r2"))

    rows_val = summary.get("rows") or overview.get("rows")
    cols_val = summary.get("columns") or overview.get("columns")
    zones_val = summary.get("number_of_zones") or overview.get("zones")
    t_start = summary.get("time_range_start")
    t_end = summary.get("time_range_end")
    if not frame.empty and "timestamp" in frame.columns:
        rows_val = int(len(frame))
        cols_val = int(len(frame.columns))
        if "zone_id" in frame.columns:
            zones_val = int(frame["zone_id"].nunique())
        ts_min = pd.to_datetime(frame["timestamp"], errors="coerce").min()
        ts_max = pd.to_datetime(frame["timestamp"], errors="coerce").max()
        if pd.notna(ts_min):
            t_start = pd.Timestamp(ts_min).isoformat()
        if pd.notna(ts_max):
            t_end = pd.Timestamp(ts_max).isoformat()

    return {
        "project_name": overview.get("project_name", "MASEER"),
        "subtitle": overview.get("subtitle", "NYC Taxi Demand Pressure Forecasting"),
        "target": TARGET_COLUMN,
        "target_definition": overview.get(
            "target_definition",
            "Next-hour yellow taxi pickup count by NYC TLC taxi zone (waiting-pressure proxy).",
        ),
        "proxy_note": overview.get("proxy_note", PROXY_NOTE),
        "rows": safe_number(rows_val),
        "columns": safe_number(cols_val),
        "zones": safe_number(zones_val),
        "time_range_start": t_start,
        "time_range_end": t_end,
        "data_sources": summary.get("data_sources") or overview.get("data_sources") or DATA_SOURCES,
        "best_tabular_model": best_tab,
        "best_forecast_model": best_fc,
        "best_test_mae": best_test_mae if best_test_mae is not None else safe_number(overview.get("best_test_mae")),
        "best_test_rmse": best_test_rmse if best_test_rmse is not None else safe_number(overview.get("best_test_rmse")),
        "best_test_r2": best_test_r2 if best_test_r2 is not None else safe_number(overview.get("best_test_r2")),
    }


def get_timestamps() -> dict[str, Any]:
    """Return all hourly timestamps from the final modeling dataset (ISO strings)."""

    snapshot = load_final_dataset()
    timestamps: set[pd.Timestamp] = set()
    if not snapshot.empty and "timestamp" in snapshot.columns:
        timestamps.update(pd.to_datetime(snapshot["timestamp"], errors="coerce").dropna().unique().tolist())
    sorted_ts = sorted(t for t in timestamps if pd.notna(t))
    iso_list = [pd.Timestamp(ts).isoformat() for ts in sorted_ts]
    if len(iso_list) <= 1 and not snapshot.empty:
        logger.warning(
            "Timestamps count is %s — expected a long hourly modeling timeline. "
            "Verify ``data/processed/zone_hour_features.parquet`` / ``dashboard_zone_hour_light.parquet``.",
            len(iso_list),
        )
    return {
        "count": len(iso_list),
        "min": iso_list[0] if iso_list else None,
        "max": iso_list[-1] if iso_list else None,
        "timestamps": list(reversed(iso_list)),  # descending by default
    }


def get_models() -> dict[str, Any]:
    metrics = load_model_metrics()
    forecast = load_forecast_metrics()
    preds = load_model_predictions()

    candidates: list[str] = []
    for source in (metrics, forecast, preds):
        if source.empty or "model_name_canonical" not in source.columns:
            continue
        candidates.extend([str(x) for x in source["model_name_canonical"].dropna().unique().tolist()])

    seen: list[str] = []
    canonical = canonical_model_order()
    for name in canonical:
        if name in candidates and name not in seen:
            seen.append(name)
    for name in candidates:
        if name and name not in seen:
            seen.append(name)
    default_model = best_tabular_model()
    if default_model not in seen and default_model:
        seen.insert(0, default_model)
    # API contract: prefer XGBoost when that model exists in discovered artefacts.
    api_default = "XGBoost" if "XGBoost" in seen else default_model
    return {
        "models": seen,
        "default_model": api_default or "XGBoost",
    }


def get_zones() -> dict[str, Any]:
    lookup = load_zone_lookup()
    if lookup.empty:
        return {"count": 0, "zones": []}
    df = lookup[lookup.apply(lambda r: _is_valid_zone(r.get("zone_name"), r.get("borough")), axis=1)].copy()
    df = df.sort_values(["borough", "zone_name"], na_position="last")
    return {"count": int(len(df)), "zones": clean_records(df)}


def get_dashboard_snapshot(
    timestamp: str | None = None,
    model: str | None = None,
    borough: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    snapshot = load_zone_snapshot_frame()
    if snapshot.empty:
        return {
            "timestamp": None,
            "model": _api_selected_model(model),
            "prediction_source": "unavailable",
            "rows": [],
            "summary": {},
        }

    work = snapshot.copy()
    if timestamp:
        target_ts = pd.to_datetime(timestamp, errors="coerce")
        if pd.notna(target_ts):
            filtered = work[work["timestamp"] == target_ts]
            if not filtered.empty:
                work = filtered
    if work["timestamp"].nunique() > 1:
        latest = work["timestamp"].max()
        work = work[work["timestamp"] == latest]
    selected_ts = work["timestamp"].iloc[0] if "timestamp" in work.columns and len(work) else None

    selected_model = _api_selected_model(model)
    predicted, sources = _predicted_column_and_sources(work, selected_model)
    if sources.empty:
        dominant_source = "unavailable"
    else:
        dominant_source = str(sources.astype(str).value_counts().idxmax())
    work = work.copy()
    work["predicted_next_hour_pickups"] = predicted
    work["prediction_source"] = sources
    work = _ensure_pressure_columns(work, predicted)

    if borough and borough.lower() != "all":
        work = work[work["borough"].astype(str).str.lower() == borough.lower()]

    cols = [
        "timestamp",
        "zone_id",
        "zone_name",
        "borough",
        "service_zone",
        "pickup_count",
        "pickup_count_roll_mean_24",
        TARGET_COLUMN,
        "predicted_next_hour_pickups",
        "pressure_ratio",
        "pressure_label",
        "temperature",
        "precipitation",
        "snowfall",
        "wind_speed",
        "humidity",
        "weather_category",
        "weather_status",
        "event_active",
        "event_flag",
        "event_intensity_score",
        "disruption_score",
        "zone_incident_count",
        "citywide_incident_count",
        "incident_flag",
        "road_closure_flag",
    ]
    for col in cols:
        if col not in work.columns:
            work[col] = None
    if "weather_status" not in work.columns or work["weather_status"].isna().all():
        if "weather_category" in work.columns:
            work["weather_status"] = work["weather_category"]

    work = work[cols + ["prediction_source"]].copy()
    if borough and borough.lower() != "all":
        rows = work
    else:
        rows = work
    rows = rows.sort_values(["pressure_ratio"], ascending=False, na_position="last")
    if limit and limit > 0:
        rows = rows.head(int(limit))

    # Summary aggregates.
    rows_for_summary = rows
    citywide_predicted = float(
        pd.to_numeric(rows_for_summary["predicted_next_hour_pickups"], errors="coerce").fillna(0).sum()
    )
    high_pressure = int(
        rows_for_summary[
            pd.to_numeric(rows_for_summary["pressure_ratio"], errors="coerce") >= 1.35
        ].shape[0]
    )
    incident_flag_num = pd.to_numeric(rows_for_summary.get("incident_flag"), errors="coerce").fillna(0)
    zone_incidents_num = pd.to_numeric(rows_for_summary.get("zone_incident_count"), errors="coerce").fillna(0)
    active_incident_rows = int(((incident_flag_num > 0) | (zone_incidents_num > 0)).sum())
    weather_status = "Unavailable"
    if "weather_status" in rows_for_summary.columns:
        modes = rows_for_summary["weather_status"].dropna().astype(str)
        if not modes.empty:
            weather_status = modes.mode().iat[0]
    elif "weather_category" in rows_for_summary.columns:
        modes = rows_for_summary["weather_category"].dropna().astype(str)
        if not modes.empty:
            weather_status = modes.mode().iat[0]

    peak_borough = None
    if "borough" in rows_for_summary.columns:
        bor_groups = rows_for_summary.groupby("borough")["predicted_next_hour_pickups"].sum()
        if not bor_groups.empty:
            peak_borough = str(bor_groups.idxmax())

    summary = {
        "timestamp": iso(selected_ts),
        "model": selected_model,
        "rows_returned": int(len(rows)),
        "citywide_predicted_next_hour_pickups": citywide_predicted,
        "high_pressure_zone_count": high_pressure,
        "active_incident_rows": active_incident_rows,
        "weather_status": weather_status,
        "peak_borough": peak_borough,
        "prediction_source": dominant_source,
    }

    return {
        "timestamp": iso(selected_ts),
        "model": selected_model,
        "prediction_source": dominant_source,
        "summary": summary,
        "rows": clean_records(rows),
    }


def _filter_by_window(
    df: pd.DataFrame,
    start: str | None,
    end: str | None,
    hours: int | None,
    timestamp_col: str = "timestamp",
) -> pd.DataFrame:
    if df.empty or timestamp_col not in df.columns:
        return df
    work = df.copy()
    work[timestamp_col] = pd.to_datetime(work[timestamp_col], errors="coerce")
    if start:
        start_ts = pd.to_datetime(start, errors="coerce")
        if pd.notna(start_ts):
            work = work[work[timestamp_col] >= start_ts]
    if end:
        end_ts = pd.to_datetime(end, errors="coerce")
        if pd.notna(end_ts):
            work = work[work[timestamp_col] <= end_ts]
    if hours and hours > 0 and not work.empty:
        max_ts = work[timestamp_col].max()
        if pd.notna(max_ts):
            work = work[work[timestamp_col] >= max_ts - pd.Timedelta(hours=hours)]
    return work.sort_values(timestamp_col)


def get_city_trend(
    hours: int = 168,
    start: str | None = None,
    end: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    timeline = load_hourly_timeline()
    snapshot = load_zone_snapshot_frame()
    selected_model = _api_selected_model(model)

    if not snapshot.empty:
        snap = _slice_zone_hour_for_aggregations(snapshot)
        predicted_full, _src = _join_predictions_into_snapshot(snap, selected_model)
        snap["predicted_next_hour_pickups"] = predicted_full
        snap = _ensure_pressure_columns(snap, predicted_full)
        agg = (
            snap.groupby("timestamp", as_index=False).agg(
                pickup_count_sum=("pickup_count", "sum"),
                target_next_hour_sum=(TARGET_COLUMN, "sum"),
                predicted_next_hour_sum=("predicted_next_hour_pickups", "sum"),
                average_pressure_ratio=("pressure_ratio", "mean"),
                high_pressure_zones=(
                    "pressure_ratio",
                    lambda s: int((pd.to_numeric(s, errors="coerce") >= 1.35).sum()),
                ),
            )
        )
    else:
        agg = pd.DataFrame(columns=[
            "timestamp",
            "pickup_count_sum",
            "target_next_hour_sum",
            "predicted_next_hour_sum",
            "average_pressure_ratio",
            "high_pressure_zones",
        ])

    if not timeline.empty:
        merged = timeline.merge(agg, on="timestamp", how="left")
    else:
        merged = agg

    merged = _filter_by_window(merged, start, end, hours)
    if merged.empty:
        return {"hours": hours, "model": selected_model, "rows": []}

    keep_cols = [
        "timestamp",
        "pickup_count_sum",
        "target_next_hour_sum",
        "predicted_next_hour_sum",
        "average_pressure_ratio",
        "high_pressure_zones",
        "citywide_incident_count",
        "temperature",
        "precipitation",
        "snowfall",
        "wind_speed",
        "humidity",
        "weather_status",
    ]
    for col in keep_cols:
        if col not in merged.columns:
            merged[col] = None
    if "incident_count_sum" not in merged.columns:
        merged["incident_count_sum"] = pd.to_numeric(
            merged.get("citywide_incident_count"), errors="coerce"
        )
    keep_cols.append("incident_count_sum")
    merged = merged[keep_cols]

    return {"hours": hours, "model": selected_model, "rows": clean_records(merged)}


def get_borough_trend(
    hours: int = 168,
    start: str | None = None,
    end: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    snapshot = load_zone_snapshot_frame()
    selected_model = _api_selected_model(model)
    if snapshot.empty or "borough" not in snapshot.columns:
        return {"hours": hours, "model": selected_model, "rows": []}

    snap = _slice_zone_hour_for_aggregations(snapshot)
    predicted_full, _src = _join_predictions_into_snapshot(snap, selected_model)
    snap["predicted_next_hour_pickups"] = predicted_full
    snap = _ensure_pressure_columns(snap, predicted_full)
    snap = snap.loc[_valid_zone_mask(snap)]

    if snap.empty:
        return {"hours": hours, "model": selected_model, "rows": []}

    if "zone_incident_count" not in snap.columns:
        snap_work = snap.assign(_incident_placeholder=0)
        incident_col = "_incident_placeholder"
    else:
        snap_work = snap
        incident_col = "zone_incident_count"
    grouped = snap_work.groupby(["timestamp", "borough"], as_index=False).agg(
        pickup_count_sum=("pickup_count", "sum"),
        target_next_hour_sum=(TARGET_COLUMN, "sum"),
        predicted_next_hour_sum=("predicted_next_hour_pickups", "sum"),
        average_pressure_ratio=("pressure_ratio", "mean"),
        high_pressure_zones=(
            "pressure_ratio",
            lambda s: int((pd.to_numeric(s, errors="coerce") >= 1.35).sum()),
        ),
        incident_count_sum=(incident_col, "sum"),
    )
    grouped = _filter_by_window(grouped, start, end, hours)
    return {"hours": hours, "model": selected_model, "rows": clean_records(grouped)}


def get_zone_history(
    zone_id: int,
    hours: int = 168,
    start: str | None = None,
    end: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    snapshot = load_zone_snapshot_frame()
    selected_model = _api_selected_model(model)
    if snapshot.empty:
        return {"zone_id": zone_id, "hours": hours, "model": selected_model, "rows": []}
    work = snapshot[pd.to_numeric(snapshot["zone_id"], errors="coerce") == float(zone_id)].copy()
    if work.empty:
        return {"zone_id": zone_id, "hours": hours, "model": selected_model, "rows": []}

    predicted_full, _src = _join_predictions_into_snapshot(work, selected_model)
    work["predicted_next_hour_pickups"] = predicted_full
    work = _ensure_pressure_columns(work, predicted_full)
    work = _filter_by_window(work, start, end, hours)

    cols = [
        "timestamp",
        "zone_id",
        "zone_name",
        "borough",
        "pickup_count",
        TARGET_COLUMN,
        "predicted_next_hour_pickups",
        "pickup_count_roll_mean_24",
        "pressure_ratio",
        "pressure_label",
        "event_intensity_score",
        "disruption_score",
        "zone_incident_count",
        "citywide_incident_count",
        "temperature",
        "precipitation",
        "weather_status",
        "weather_category",
    ]
    for col in cols:
        if col not in work.columns:
            work[col] = None
    work = work[cols].sort_values("timestamp")
    return {"zone_id": zone_id, "hours": hours, "model": selected_model, "rows": clean_records(work)}


def get_zone_hour_heatmap(
    hours: int = 168,
    top_n: int = 20,
    model: str | None = None,
    metric: str = "pressure_ratio",
) -> dict[str, Any]:
    snapshot = load_zone_snapshot_frame()
    selected_model = _api_selected_model(model)
    if snapshot.empty:
        return {"hours": hours, "top_n": top_n, "metric": metric, "rows": []}
    extra: tuple[str, ...] = ()
    if metric == "incident_context":
        extra = ("zone_incident_count",)
    work = _slice_zone_hour_for_aggregations(snapshot, extra=extra)
    predicted_full, _src = _join_predictions_into_snapshot(work, selected_model)
    work["predicted_next_hour_pickups"] = predicted_full
    work = _ensure_pressure_columns(work, predicted_full)
    work = work.loc[_valid_zone_mask(work)]

    work = _filter_by_window(work, None, None, hours)
    if work.empty:
        return {"hours": hours, "top_n": top_n, "metric": metric, "rows": []}

    work["hour"] = pd.to_datetime(work["timestamp"], errors="coerce").dt.hour
    metric_col = {
        "pressure_ratio": "pressure_ratio",
        "predicted_pickups": "predicted_next_hour_pickups",
        "pickup_count": "pickup_count",
        "incident_context": "zone_incident_count",
    }.get(metric, "pressure_ratio")
    if metric_col not in work.columns:
        metric_col = "pressure_ratio"
    work["value"] = pd.to_numeric(work[metric_col], errors="coerce")

    # Find top zones by mean value.
    rank = (
        work.dropna(subset=["value"])  # ignore unavailable values for ranking
        .groupby("zone_id")["value"]
        .mean()
        .sort_values(ascending=False)
    )
    top_zone_ids = rank.head(int(top_n)).index.tolist()
    if not top_zone_ids:
        top_zone_ids = work["zone_id"].dropna().unique().tolist()[:top_n]
    work = work[work["zone_id"].isin(top_zone_ids)]
    work["metric"] = metric
    cols = ["zone_id", "zone_name", "borough", "timestamp", "hour", "value", "metric"]
    for col in cols:
        if col not in work.columns:
            work[col] = None
    rows = work[cols].sort_values(["zone_id", "timestamp"], na_position="last")
    return {
        "hours": hours,
        "top_n": top_n,
        "metric": metric,
        "rows": clean_records(rows),
    }


def get_taxi_zone_geojson() -> dict[str, Any]:
    geo = load_geojson()
    if geo is None:
        return {
            "type": "FeatureCollection",
            "features": [],
            "error": (
                "Taxi zone GeoJSON could not be loaded. Ensure that "
                "data/external/taxi_zones.zip or data/external/taxi_zones.geojson is present."
            ),
        }
    return geo


def get_figures_manifest() -> dict[str, Any]:
    figures: list[dict[str, Any]] = []
    roots = [
        (FRONTEND_FIGURES_DIR, "/figures"),
        (REPORTS_DIR / "figures", "/static/reports/figures"),
        (ARTIFACTS_DIR / "figures", "/static/artifacts/figures"),
    ]
    for root, url_prefix in roots:
        if not root.exists():
            continue
        for path in sorted(root.glob("**/*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".svg", ".webp"}:
                continue
            section = path.parent.name.replace("_", " ").title()
            title = path.stem.replace("_", " ").title()
            rel = path.relative_to(root).as_posix()
            url: str | None = f"{url_prefix}/{rel}" if url_prefix else None
            figures.append(
                {
                    "title": title,
                    "section": section,
                    "url": url,
                    "filename": path.name,
                    "path": str(path),
                    "description": title,
                }
            )
    return {"count": len(figures), "figures": figures}


def get_models_metrics_payload() -> dict[str, Any]:
    metrics = load_model_metrics()
    forecast = load_forecast_metrics()
    contextual = load_contextual_comparison()

    rows: list[dict[str, Any]] = []
    if not metrics.empty:
        for row in metrics.itertuples():
            rows.append(
                {
                    "model_name": getattr(row, "model_name_canonical", None) or getattr(row, "model_name", None),
                    "model_family": getattr(row, "model_family", None),
                    "scenario": getattr(row, "scenario", None),
                    "mape": safe_number(getattr(row, "mape", None)),
                    "test_mae": safe_number(getattr(row, "test_mae", None)),
                    "test_rmse": safe_number(getattr(row, "test_rmse", None)),
                    "test_r2": safe_number(getattr(row, "test_r2", None)),
                    "test_smape": safe_number(getattr(row, "test_smape", None)),
                    "validation_mae": safe_number(getattr(row, "validation_mae", None)),
                    "validation_rmse": safe_number(getattr(row, "validation_rmse", None)),
                    "validation_r2": safe_number(getattr(row, "validation_r2", None)),
                    "cv_mae_mean": safe_number(getattr(row, "cv_mae_mean", None)),
                    "cv_rmse_mean": safe_number(getattr(row, "cv_rmse_mean", None)),
                    "cv_r2_mean": safe_number(getattr(row, "cv_r2_mean", None)),
                    "horizon": safe_number(getattr(row, "horizon", None)),
                    "notes": getattr(row, "notes", None),
                }
            )
    if not forecast.empty:
        for row in forecast.itertuples():
            rows.append(
                {
                    "model_name": getattr(row, "model_name_canonical", None) or getattr(row, "model_name", None),
                    "model_family": "forecast",
                    "scenario": "24h_forecast",
                    "test_mae": safe_number(getattr(row, "mae", None)),
                    "test_rmse": safe_number(getattr(row, "rmse", None)),
                    "test_r2": safe_number(getattr(row, "r2", None)),
                    "test_smape": safe_number(getattr(row, "smape", None)),
                    "mape": safe_number(getattr(row, "mape", None)),
                    "horizon": 24,
                    "notes": f"24h horizon forecast vs {getattr(row, 'benchmark_name', 'naive')} baseline.",
                }
            )

    return {
        "count": len(rows),
        "rows": rows,
        "best_tabular_model": best_tabular_model(),
        "best_forecast_model": best_forecast_model(),
        "contextual_comparison": clean_records(contextual),
    }


def get_models_predictions(
    model: str | None = None,
    zone_id: int | None = None,
    hours: int | None = 168,
    start: str | None = None,
    end: str | None = None,
    limit: int = 5000,
) -> dict[str, Any]:
    preds = load_model_predictions()
    selected_model = _api_selected_model(model)
    if preds.empty:
        return {"count": 0, "rows": [], "model": selected_model}

    work = preds.copy()
    if selected_model:
        candidate = work[work["model_name_canonical"] == selected_model]
        if not candidate.empty:
            work = candidate
        elif model is None or (isinstance(model, str) and not str(model).strip()):
            # Default ``XGBoost`` filter matched nothing (e.g. preview only has other models).
            pass
        else:
            work = candidate
    if zone_id is not None and "zone_id" in work.columns:
        work = work[pd.to_numeric(work["zone_id"], errors="coerce") == float(zone_id)]
    work = _filter_by_window(work, start, end, hours)
    if work.empty:
        return {"count": 0, "rows": [], "model": selected_model}

    lookup = load_zone_lookup()
    if not lookup.empty and "zone_id" in work.columns:
        work = work.merge(
            lookup[["zone_id", "zone_name", "borough"]],
            on="zone_id",
            how="left",
            suffixes=("", "_lookup"),
        )
    if "actual" not in work.columns and "y_true" in work.columns:
        work["actual"] = work["y_true"]
    if "predicted" not in work.columns and "y_pred" in work.columns:
        work["predicted"] = work["y_pred"]

    work["actual"] = pd.to_numeric(work.get("actual"), errors="coerce")
    work["predicted"] = pd.to_numeric(work.get("predicted"), errors="coerce")
    work["error"] = work["predicted"] - work["actual"]
    work["absolute_error"] = work["error"].abs()
    work["model_name"] = work.get("model_name_canonical").fillna(work.get("model_name"))

    cols = [
        "model_name",
        "timestamp",
        "zone_id",
        "zone_name",
        "borough",
        "actual",
        "predicted",
        "error",
        "absolute_error",
    ]
    for col in cols:
        if col not in work.columns:
            work[col] = None
    work = work[cols].sort_values(["model_name", "timestamp", "zone_id"]).head(int(limit))
    return {
        "count": int(len(work)),
        "rows": clean_records(work),
        "model": selected_model,
    }


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------


_RECOMMENDATIONS = {
    "High": "High-pressure zone. Increase supply coverage and monitor closely.",
    "Elevated": "Elevated demand pressure. Review supply coverage; expect growing demand.",
    "Typical": "Typical pressure. Continue routine monitoring.",
    "Low": "Low pressure period. Maintain standard cadence.",
    "Unavailable": "Pressure ratio unavailable due to denominator or prediction constraints.",
}


def _rule_based_scenario_prediction(
    base_prediction: float,
    *,
    base_temperature: float | None,
    base_precipitation: float | None,
    base_snowfall: float | None,
    base_event: float | None,
    base_disruption: float | None,
    base_incident: float | None,
    base_closure: float | None,
    new_temperature: float | None,
    new_precipitation: float | None,
    new_snowfall: float | None,
    new_event: float | None,
    new_disruption: float | None,
    new_incident: float | None,
    new_closure: float | None,
) -> float:
    """Transparent scenario adjustment using exported feature deltas.

    The dashboard does not load live trained models on this machine, so the
    simulation endpoint returns a deterministic heuristic that *amplifies* or
    *dampens* the baseline forecast based on weather/event deltas.  This is
    explicitly labelled as ``scenario_approximation`` in the response so it
    is never confused with a live model prediction.
    """

    if not math.isfinite(base_prediction):
        return base_prediction
    multiplier = 1.0

    def _delta(new: float | None, old: float | None) -> float:
        if new is None:
            return 0.0
        try:
            new_f = float(new)
            old_f = float(old) if old is not None else 0.0
        except (TypeError, ValueError):
            return 0.0
        return new_f - old_f

    rain_delta = _delta(new_precipitation, base_precipitation)
    snow_delta = _delta(new_snowfall, base_snowfall)
    temp_delta = _delta(new_temperature, base_temperature)
    event_delta = _delta(new_event, base_event)
    disruption_delta = _delta(new_disruption, base_disruption)
    incident_delta = _delta(new_incident, base_incident)
    closure_delta = _delta(new_closure, base_closure)

    multiplier += 0.06 * max(rain_delta, 0)            # rain pushes demand up
    multiplier -= 0.08 * max(-rain_delta, 0)            # drying weather softens it
    multiplier += 0.10 * max(snow_delta, 0)
    multiplier += 0.005 * max(15 - max(temp_delta + (base_temperature or 10), -20), 0)
    multiplier += 0.12 * max(event_delta, 0)
    multiplier += 0.08 * max(disruption_delta, 0)
    multiplier += 0.05 * max(incident_delta, 0)
    multiplier += 0.06 * max(closure_delta, 0)
    multiplier = max(0.5, min(multiplier, 1.8))
    return float(max(base_prediction * multiplier, 0.0))


def run_simulation(payload: dict[str, Any]) -> dict[str, Any]:
    snapshot = load_zone_snapshot_frame()
    if snapshot.empty:
        return {"error": "No model-ready feature data available."}

    zone_id = int(payload["zone_id"])
    work = snapshot[pd.to_numeric(snapshot["zone_id"], errors="coerce") == zone_id].copy()
    if work.empty:
        return {"error": f"Zone {zone_id} not found in zone snapshot data."}

    # Pick the closest available row to the requested timestamp.
    if payload.get("timestamp"):
        req_ts = pd.to_datetime(payload["timestamp"], errors="coerce")
        if pd.notna(req_ts):
            exact = work[work["timestamp"] == req_ts]
            if not exact.empty:
                work = exact
    work = work.sort_values("timestamp")
    base_row = work.iloc[-1].copy()

    selected_model = _api_selected_model(payload.get("model") or payload.get("model_name"))

    base_pred_series, source = _join_predictions_into_snapshot(work.tail(1), selected_model)
    baseline = float(base_pred_series.iloc[0]) if not base_pred_series.empty and pd.notna(base_pred_series.iloc[0]) else None
    if baseline is None:
        target_value = safe_number(base_row.get(TARGET_COLUMN))
        if isinstance(target_value, (int, float)):
            baseline = float(target_value)
            source = "target_fallback"
        else:
            pickup = safe_number(base_row.get("pickup_count"))
            if isinstance(pickup, (int, float)):
                baseline = float(pickup)
                source = "pickup_proxy"
            else:
                baseline = 0.0
                source = "unavailable"

    inputs_used = {
        "temperature": payload.get("temperature") if payload.get("temperature") is not None else safe_number(base_row.get("temperature")),
        "precipitation": payload.get("precipitation") if payload.get("precipitation") is not None else safe_number(base_row.get("precipitation")),
        "snowfall": payload.get("snowfall") if payload.get("snowfall") is not None else safe_number(base_row.get("snowfall")),
        "wind_speed": payload.get("wind_speed") if payload.get("wind_speed") is not None else safe_number(base_row.get("wind_speed")),
        "humidity": payload.get("humidity") if payload.get("humidity") is not None else safe_number(base_row.get("humidity")),
        "event_intensity_score": payload.get("event_intensity_score") if payload.get("event_intensity_score") is not None else safe_number(base_row.get("event_intensity_score")),
        "disruption_score": payload.get("disruption_score") if payload.get("disruption_score") is not None else safe_number(base_row.get("disruption_score")),
        "incident_flag": payload.get("incident_flag") if payload.get("incident_flag") is not None else safe_number(base_row.get("incident_flag")),
        "road_closure_flag": payload.get("road_closure_flag") if payload.get("road_closure_flag") is not None else safe_number(base_row.get("road_closure_flag")),
        "pickup_count_roll_mean_24": (
            payload.get("pickup_count_roll_mean_24")
            if payload.get("pickup_count_roll_mean_24") is not None
            else safe_number(base_row.get("pickup_count_roll_mean_24"))
        ),
    }

    scenario = _rule_based_scenario_prediction(
        baseline,
        base_temperature=safe_number(base_row.get("temperature")),
        base_precipitation=safe_number(base_row.get("precipitation")),
        base_snowfall=safe_number(base_row.get("snowfall")),
        base_event=safe_number(base_row.get("event_intensity_score")),
        base_disruption=safe_number(base_row.get("disruption_score")),
        base_incident=safe_number(base_row.get("incident_flag")),
        base_closure=safe_number(base_row.get("road_closure_flag")),
        new_temperature=payload.get("temperature"),
        new_precipitation=payload.get("precipitation"),
        new_snowfall=payload.get("snowfall"),
        new_event=payload.get("event_intensity_score"),
        new_disruption=payload.get("disruption_score"),
        new_incident=payload.get("incident_flag"),
        new_closure=payload.get("road_closure_flag"),
    )

    denom = inputs_used.get("pickup_count_roll_mean_24")
    baseline_pressure = safe_ratio(baseline, denom)
    scenario_pressure = safe_ratio(scenario, denom)
    label = pressure_label(scenario_pressure)
    delta = scenario - baseline
    delta_percent = None
    if baseline > 0:
        delta_percent = (delta / baseline) * 100.0

    actual = payload.get("actual_next_hour_pickups")
    if actual is None:
        actual = safe_number(base_row.get(TARGET_COLUMN))
    absolute_error = None
    if actual is not None and isinstance(actual, (int, float)):
        absolute_error = abs(scenario - float(actual))

    final_source = "scenario_approximation" if any(
        payload.get(k) is not None
        for k in (
            "temperature",
            "precipitation",
            "snowfall",
            "event_intensity_score",
            "disruption_score",
            "incident_flag",
            "road_closure_flag",
        )
    ) else source

    return {
        "zone_id": zone_id,
        "zone_name": base_row.get("zone_name"),
        "borough": base_row.get("borough"),
        "timestamp": iso(base_row.get("timestamp")),
        "model": selected_model,
        "baseline_prediction": safe_number(baseline),
        "scenario_prediction": safe_number(scenario),
        "delta": safe_number(delta),
        "delta_percent": safe_number(delta_percent),
        "baseline_pressure_ratio": safe_number(baseline_pressure),
        "scenario_pressure_ratio": safe_number(scenario_pressure),
        "pressure_label": label,
        "absolute_error": safe_number(absolute_error),
        "recommendation": _RECOMMENDATIONS.get(label, _RECOMMENDATIONS["Unavailable"]),
        "inputs_used": inputs_used,
        "prediction_source": final_source,
        "proxy_note": PROXY_NOTE,
        "actual_next_hour_pickups": safe_number(actual) if actual is not None else None,
    }


# ---------------------------------------------------------------------------
# Diagnostics utilities (used by /api/health and startup logging)
# ---------------------------------------------------------------------------


def get_data_diagnostics() -> dict[str, Any]:
    snapshot = load_final_dataset()
    timeline = load_hourly_timeline()
    metrics = load_model_metrics()
    preds = load_model_predictions()
    geo = load_geojson()
    timestamps = get_timestamps()
    lookup = load_zone_lookup()
    dash_meta = get_dashboard_load_meta()
    return {
        "final_dataset_rows": int(0 if snapshot.empty else len(snapshot)),
        "snapshot_rows": int(0 if snapshot.empty else len(snapshot)),
        "snapshot_zones": int(0 if snapshot.empty else snapshot["zone_id"].nunique()) if "zone_id" in snapshot.columns else 0,
        "zone_lookup_rows": int(len(lookup)),
        "timestamp_count": timestamps["count"],
        "timestamp_min": timestamps["min"],
        "timestamp_max": timestamps["max"],
        "timeline_rows": int(0 if timeline.empty else len(timeline)),
        "model_metrics_rows": int(0 if metrics.empty else len(metrics)),
        "predictions_rows": int(0 if preds.empty else len(preds)),
        "geojson_loaded": bool(geo and geo.get("features")),
        "geojson_feature_count": int(len(geo.get("features", [])) if geo else 0),
        "dashboard_dataset_path": dash_meta.get("dashboard_dataset_path"),
        "dashboard_source_tag": dash_meta.get("dashboard_source_tag"),
        "fallback_snapshot_used": bool(dash_meta.get("fallback_snapshot_used")),
        "processed_parquet_failed": bool(dash_meta.get("processed_parquet_failed")),
        "feature_parquet_path": dash_meta.get("dashboard_dataset_path"),
    }


def get_startup_log_counts() -> dict[str, int]:
    """Lightweight sample sizes for startup logging (not returned by /api/health)."""

    city = get_city_trend(hours=168)
    borough = get_borough_trend(hours=168)
    snap = get_dashboard_snapshot(timestamp=None, model=None, borough=None, limit=None)
    return {
        "city_trend_rows_168": len(city.get("rows", []) or []),
        "borough_trend_rows_168": len(borough.get("rows", []) or []),
        "snapshot_rows_latest": len(snap.get("rows", []) or []),
    }
