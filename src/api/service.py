from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import joblib
import pandas as pd

from src.api.utils import clean_records, pressure_label, safe_number, safe_ratio
from src.config.settings import PROJECT_ROOT

TARGET_COLUMN = "target_pickup_count_next_hour"
PROXY_NOTE = "Proxy measure; NYC TLC data does not provide a direct passenger waiting-time label."
DATA_SOURCES = [
    "NYC TLC Yellow Trip Data",
    "Taxi Zone Lookup",
    "Weather",
    "Event/Incident Data",
]

DATA_DIR = PROJECT_ROOT / "data" / "processed"
ARTIFACTS_DIR = PROJECT_ROOT / "artifacts"
FRONTEND_DATA_DIR = PROJECT_ROOT / "frontend" / "public" / "data"

EXCLUDE_TEXT = ("outside of nyc", "outside", "none")
META_COLUMNS = {
    "timestamp",
    "zone_id",
    "zone_name",
    "borough",
    "service_zone",
    TARGET_COLUMN,
    "demand_pressure_ratio",
}


def _safe_read_json(path: Path) -> dict[str, Any] | list[dict[str, Any]] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def _safe_read_csv(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    try:
        return pd.read_csv(path)
    except Exception:
        return None


def _safe_read_parquet(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    try:
        return pd.read_parquet(path)
    except Exception:
        return None


def _normalize_ts(df: pd.DataFrame, column: str = "timestamp") -> pd.DataFrame:
    if column in df.columns:
        df[column] = pd.to_datetime(df[column], errors="coerce")
    return df


def _is_valid_zone_name(zone_name: Any, borough: Any) -> bool:
    if zone_name is None or borough is None:
        return False
    if pd.isna(zone_name) or pd.isna(borough):
        return False
    zn = str(zone_name).strip().lower()
    br = str(borough).strip().lower()
    if not zn or not br:
        return False
    if any(term in zn for term in EXCLUDE_TEXT) or any(term in br for term in EXCLUDE_TEXT):
        return False
    return True


@lru_cache(maxsize=1)
def load_training_manifest() -> dict[str, Any]:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "training_manifest.json")
    if isinstance(payload, dict):
        return payload
    payload = _safe_read_json(FRONTEND_DATA_DIR / "overview.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_forecast_manifest() -> dict[str, Any]:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "forecast_manifest.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_dataset_summary() -> dict[str, Any]:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "final_merged_dataset_summary.json")
    if isinstance(payload, dict):
        return payload
    payload = _safe_read_json(FRONTEND_DATA_DIR / "dataset_summary.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_overview_fallback() -> dict[str, Any]:
    payload = _safe_read_json(FRONTEND_DATA_DIR / "overview.json")
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def load_model_metrics() -> pd.DataFrame:
    df = _safe_read_csv(ARTIFACTS_DIR / "metrics" / "model_metrics.csv")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "model_metrics.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    if df is None:
        return pd.DataFrame()
    if "test_rmse" in df.columns:
        df = df.sort_values("test_rmse", ascending=True, na_position="last")
    return df.reset_index(drop=True)


@lru_cache(maxsize=1)
def load_forecast_metrics() -> pd.DataFrame:
    df = _safe_read_csv(ARTIFACTS_DIR / "metrics" / "forecast_metrics.csv")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "forecast_metrics.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    return pd.DataFrame() if df is None else df.reset_index(drop=True)


@lru_cache(maxsize=1)
def load_contextual_comparison() -> pd.DataFrame:
    df = _safe_read_csv(ARTIFACTS_DIR / "metrics" / "contextual_comparison.csv")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "contextual_comparison.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    return pd.DataFrame() if df is None else df.reset_index(drop=True)


@lru_cache(maxsize=1)
def load_predictions_frame() -> pd.DataFrame:
    df = _safe_read_parquet(ARTIFACTS_DIR / "predictions" / "test_predictions.parquet")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "predictions_preview.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    if df is None:
        return pd.DataFrame()
    rename_map = {"y_true": "actual", "y_pred": "predicted"}
    for old, new in rename_map.items():
        if old in df.columns and new not in df.columns:
            df = df.rename(columns={old: new})
    if "model_name" not in df.columns:
        df["model_name"] = load_best_tabular_model()
    if "zone_id" in df.columns:
        df["zone_id"] = pd.to_numeric(df["zone_id"], errors="coerce")
    df = _normalize_ts(df, "timestamp")
    return df


@lru_cache(maxsize=1)
def load_feature_frame() -> pd.DataFrame:
    df = _safe_read_parquet(DATA_DIR / "zone_hour_features.parquet")
    if df is not None:
        df = _normalize_ts(df, "timestamp")
        if "zone_id" in df.columns:
            df["zone_id"] = pd.to_numeric(df["zone_id"], errors="coerce")
        return df
    fallback = _safe_read_json(FRONTEND_DATA_DIR / "zone_pressure.json")
    if isinstance(fallback, list):
        df = pd.DataFrame(fallback)
        df = _normalize_ts(df, "timestamp")
        if "zone_id" in df.columns:
            df["zone_id"] = pd.to_numeric(df["zone_id"], errors="coerce")
        if "predicted_next_hour_pickups" in df.columns and "predicted" not in df.columns:
            df["predicted"] = pd.to_numeric(df["predicted_next_hour_pickups"], errors="coerce")
        if "observed_next_hour_pickups" in df.columns and "actual" not in df.columns:
            df["actual"] = pd.to_numeric(df["observed_next_hour_pickups"], errors="coerce")
        return df
    return pd.DataFrame()


@lru_cache(maxsize=1)
def load_feature_dictionary() -> pd.DataFrame:
    df = _safe_read_csv(DATA_DIR / "final_merged_dataset_dictionary.csv")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "feature_dictionary.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    return pd.DataFrame() if df is None else df


@lru_cache(maxsize=1)
def load_event_integration_summary() -> pd.DataFrame:
    df = _safe_read_csv(PROJECT_ROOT / "reports" / "tables" / "event_integration_summary.csv")
    if df is None:
        fallback = _safe_read_json(FRONTEND_DATA_DIR / "event_integration_summary.json")
        if isinstance(fallback, list):
            df = pd.DataFrame(fallback)
    return pd.DataFrame() if df is None else df


@lru_cache(maxsize=1)
def load_data_quality_summary() -> dict[str, Any] | None:
    payload = _safe_read_json(ARTIFACTS_DIR / "metadata" / "run_summary.json")
    return payload if isinstance(payload, dict) else None


@lru_cache(maxsize=1)
def load_models() -> dict[str, Any]:
    models_dir = ARTIFACTS_DIR / "models"
    loaded: dict[str, Any] = {}
    if not models_dir.exists():
        return loaded
    for path in sorted(models_dir.glob("*.joblib")):
        try:
            loaded[path.stem.replace("_", " ").title()] = joblib.load(path)
        except Exception:
            continue
    return loaded


def load_best_tabular_model() -> str:
    manifest = load_training_manifest()
    overview = load_overview_fallback()
    return str(
        manifest.get("best_tabular_model")
        or overview.get("best_tabular_model")
        or "XGBoost"
    )


def load_best_forecast_model() -> str:
    forecast_manifest = load_forecast_manifest()
    overview = load_overview_fallback()
    return str(
        forecast_manifest.get("best_forecast_model")
        or overview.get("best_forecast_model")
        or "GRU 24H Forecaster"
    )


def get_feature_columns() -> list[str]:
    try:
        from src.features.engineering import ALL_FEATURES  # local import to avoid hard dependency during startup

        return list(ALL_FEATURES)
    except Exception:
        pass
    manifest = load_training_manifest()
    columns = manifest.get("contextual_feature_columns") or manifest.get("base_feature_columns")
    if isinstance(columns, list) and columns:
        return [str(c) for c in columns]
    feature_df = load_feature_frame()
    if feature_df.empty:
        return []
    derived = [c for c in feature_df.columns if c not in META_COLUMNS]
    return derived


def get_valid_default_row() -> pd.Series | None:
    feature_df = load_feature_frame()
    if feature_df.empty:
        return None
    work = feature_df.copy()
    required = ["zone_name", "borough", "pickup_count", "pickup_count_roll_mean_24"]
    for col in required:
        if col not in work.columns:
            return None
    work = work[
        work.apply(lambda r: _is_valid_zone_name(r.get("zone_name"), r.get("borough")), axis=1)
    ]
    work = work[pd.to_numeric(work["pickup_count_roll_mean_24"], errors="coerce") > 1]
    work = work[pd.to_numeric(work["pickup_count"], errors="coerce").notna()]
    if TARGET_COLUMN in work.columns:
        subset = work[pd.to_numeric(work[TARGET_COLUMN], errors="coerce").notna()]
        if not subset.empty:
            work = subset
    if work.empty:
        return None
    work["timestamp"] = pd.to_datetime(work["timestamp"], errors="coerce")
    activity = work.groupby("zone_id", dropna=True)["pickup_count"].sum().sort_values(ascending=False)
    if activity.empty:
        return work.sort_values("timestamp").iloc[-1]
    top_zone_id = activity.index[0]
    zone_rows = work[work["zone_id"] == top_zone_id].sort_values("timestamp")
    if zone_rows.empty:
        return None
    return zone_rows.iloc[-1]


def get_zone_snapshot(timestamp: str | None = None) -> pd.DataFrame:
    feature_df = load_feature_frame()
    if feature_df.empty:
        return pd.DataFrame()
    work = feature_df.copy()
    work["timestamp"] = pd.to_datetime(work["timestamp"], errors="coerce")
    if timestamp:
        selected = pd.to_datetime(timestamp, errors="coerce")
    else:
        selected = work["timestamp"].max()
    if pd.isna(selected):
        return pd.DataFrame()
    out = work[work["timestamp"] == selected].copy()
    if out.empty and not timestamp:
        out = work.sort_values("timestamp").groupby("zone_id", as_index=False).tail(1)
    return out


def _prediction_from_join(
    frame: pd.DataFrame, model_name: str | None = None
) -> pd.Series:
    pred_df = load_predictions_frame()
    if pred_df.empty:
        return pd.Series([None] * len(frame), index=frame.index, dtype="float64")
    merged = pred_df.copy()
    if model_name and "model_name" in merged.columns:
        candidate = merged[merged["model_name"] == model_name]
        if not candidate.empty:
            merged = candidate
    merged = merged.drop_duplicates(subset=[c for c in ["timestamp", "zone_id"] if c in merged.columns])
    if not {"timestamp", "zone_id", "predicted"}.issubset(merged.columns):
        return pd.Series([None] * len(frame), index=frame.index, dtype="float64")
    out = frame.merge(
        merged[["timestamp", "zone_id", "predicted"]],
        on=["timestamp", "zone_id"],
        how="left",
    )
    return pd.to_numeric(out["predicted"], errors="coerce")


def build_snapshot(timestamp: str | None = None, model_name: str | None = None) -> dict[str, Any]:
    frame = get_zone_snapshot(timestamp)
    if frame.empty:
        return {"prediction_source": "unavailable", "summary": {}, "rows": []}

    selected_model = model_name or load_best_tabular_model()
    predicted = _prediction_from_join(frame, selected_model)
    prediction_source = "model_prediction" if predicted.notna().any() else "observed_target_proxy"

    if "predicted_next_hour_pickups" in frame.columns:
        fallback_pred = pd.to_numeric(frame["predicted_next_hour_pickups"], errors="coerce")
        predicted = predicted.fillna(fallback_pred)
        if predicted.notna().any():
            prediction_source = "model_prediction"

    observed = pd.to_numeric(frame.get(TARGET_COLUMN), errors="coerce")
    predicted = predicted.fillna(observed)
    frame["predicted_next_hour_pickups"] = predicted
    frame["pressure_ratio"] = frame.apply(
        lambda r: safe_ratio(r.get("predicted_next_hour_pickups"), r.get("pickup_count_roll_mean_24")),
        axis=1,
    )
    frame["pressure_label"] = frame["pressure_ratio"].apply(pressure_label)

    expected_cols = [
        "zone_id",
        "zone_name",
        "borough",
        "timestamp",
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
        "event_intensity_score",
        "disruption_score",
        "zone_incident_count",
        "citywide_incident_count",
        "incident_flag",
        "road_closure_flag",
    ]
    for col in expected_cols:
        if col not in frame.columns:
            frame[col] = None
    frame = frame[expected_cols].sort_values(["borough", "zone_name"], na_position="last")

    high_pressure = frame[frame["pressure_ratio"].apply(lambda v: isinstance(v, (float, int)) and v >= 1.35)]
    incident_rows = frame[
        (pd.to_numeric(frame.get("incident_flag"), errors="coerce").fillna(0) > 0)
        | (pd.to_numeric(frame.get("zone_incident_count"), errors="coerce").fillna(0) > 0)
    ]
    weather_status = "Unavailable"
    if "weather_category" in get_zone_snapshot(timestamp).columns:
        weather_mode = (
            get_zone_snapshot(timestamp)["weather_category"].dropna().astype(str).mode().tolist()
        )
        if weather_mode:
            weather_status = weather_mode[0]
    elif "precipitation" in frame.columns:
        precip_sum = pd.to_numeric(frame["precipitation"], errors="coerce").fillna(0).sum()
        weather_status = "Wet Conditions" if precip_sum > 0 else "Dry Conditions"

    max_idx = frame["pressure_ratio"].astype("float64").idxmax() if frame["pressure_ratio"].notna().any() else None
    max_zone = None
    if max_idx is not None and max_idx in frame.index:
        candidate = frame.loc[max_idx]
        max_zone = {
            "zone_id": safe_number(candidate.get("zone_id")),
            "zone_name": candidate.get("zone_name"),
            "borough": candidate.get("borough"),
            "pressure_ratio": safe_number(candidate.get("pressure_ratio")),
            "pressure_label": candidate.get("pressure_label"),
        }

    summary = {
        "timestamp": frame["timestamp"].iloc[0].isoformat() if len(frame) else None,
        "total_predicted_next_hour_pickups": safe_number(pd.to_numeric(frame["predicted_next_hour_pickups"], errors="coerce").fillna(0).sum()),
        "high_pressure_zone_count": int(len(high_pressure)),
        "active_incident_rows": int(len(incident_rows)),
        "weather_status": weather_status,
        "max_pressure_zone": max_zone,
    }
    return {
        "prediction_source": prediction_source,
        "model_name": selected_model,
        "summary": summary,
        "rows": clean_records(frame),
    }


def _valid_zone_frame() -> pd.DataFrame:
    feature_df = load_feature_frame()
    if feature_df.empty or not {"zone_id", "zone_name", "borough"}.issubset(feature_df.columns):
        return pd.DataFrame(columns=["zone_id", "zone_name", "borough"])
    out = (
        feature_df[["zone_id", "zone_name", "borough"]]
        .drop_duplicates()
        .dropna()
    )
    out = out[out.apply(lambda r: _is_valid_zone_name(r["zone_name"], r["borough"]), axis=1)]
    out["zone_id"] = pd.to_numeric(out["zone_id"], errors="coerce")
    return out.sort_values(["borough", "zone_name"], ascending=True, na_position="last")


def get_zones() -> list[dict[str, Any]]:
    return clean_records(_valid_zone_frame())


def get_timestamps(zone_id: int | None = None) -> list[str]:
    df = load_feature_frame()
    if df.empty or "timestamp" not in df.columns:
        return []
    work = df.copy()
    if zone_id is not None and "zone_id" in work.columns:
        work = work[pd.to_numeric(work["zone_id"], errors="coerce") == float(zone_id)]
    stamps = pd.to_datetime(work["timestamp"], errors="coerce").dropna().drop_duplicates().sort_values()
    return [ts.isoformat() for ts in stamps]


def get_zone_history(zone_id: int, hours: int = 168) -> list[dict[str, Any]]:
    df = load_feature_frame()
    if df.empty:
        return []
    work = df[pd.to_numeric(df["zone_id"], errors="coerce") == float(zone_id)].copy()
    if work.empty:
        return []
    work = work.sort_values("timestamp").tail(max(hours, 1))
    predicted = _prediction_from_join(work, load_best_tabular_model())
    if "predicted_next_hour_pickups" in work.columns:
        predicted = predicted.fillna(pd.to_numeric(work["predicted_next_hour_pickups"], errors="coerce"))
    observed = pd.to_numeric(work.get(TARGET_COLUMN), errors="coerce")
    work["pressure_ratio"] = [
        safe_ratio(p if pd.notna(p) else o, d)
        for p, o, d in zip(predicted, observed, pd.to_numeric(work.get("pickup_count_roll_mean_24"), errors="coerce"))
    ]
    wanted = [
        "timestamp",
        "pickup_count",
        TARGET_COLUMN,
        "pickup_count_roll_mean_24",
        "pressure_ratio",
        "temperature",
        "precipitation",
        "event_intensity_score",
        "disruption_score",
        "zone_incident_count",
        "citywide_incident_count",
    ]
    for col in wanted:
        if col not in work.columns:
            work[col] = None
    return clean_records(work[wanted])


def get_city_trend(hours: int = 168) -> list[dict[str, Any]]:
    df = load_feature_frame()
    if df.empty:
        return []
    work = df.sort_values("timestamp").copy()
    work = work.groupby("timestamp", as_index=False).agg(
        total_pickups=("pickup_count", "sum"),
        total_next_hour_target=(TARGET_COLUMN, "sum"),
        avg_pressure_ratio=("demand_pressure_ratio", "mean") if "demand_pressure_ratio" in work.columns else ("pickup_count", "mean"),
        total_zone_incidents=("zone_incident_count", "sum") if "zone_incident_count" in work.columns else ("pickup_count", "sum"),
        avg_temperature=("temperature", "mean") if "temperature" in work.columns else ("pickup_count", "mean"),
        total_precipitation=("precipitation", "sum") if "precipitation" in work.columns else ("pickup_count", "sum"),
        avg_event_intensity_score=("event_intensity_score", "mean") if "event_intensity_score" in work.columns else ("pickup_count", "mean"),
        avg_disruption_score=("disruption_score", "mean") if "disruption_score" in work.columns else ("pickup_count", "mean"),
    )
    if "demand_pressure_ratio" not in df.columns:
        work["avg_pressure_ratio"] = [
            safe_ratio(n, d) for n, d in zip(work["total_next_hour_target"], work["total_pickups"])
        ]
    return clean_records(work.sort_values("timestamp").tail(max(hours, 1)))


def get_borough_trend(hours: int = 168) -> list[dict[str, Any]]:
    df = load_feature_frame()
    if df.empty or "borough" not in df.columns:
        return []
    work = df.copy()
    work = work[work.apply(lambda r: _is_valid_zone_name(r.get("zone_name"), r.get("borough")), axis=1)]
    grouped = work.groupby(["timestamp", "borough"], as_index=False).agg(
        pickup_count=("pickup_count", "sum"),
        target_pickup_count_next_hour=(TARGET_COLUMN, "sum"),
        avg_event_intensity_score=("event_intensity_score", "mean") if "event_intensity_score" in work.columns else ("pickup_count", "mean"),
        avg_disruption_score=("disruption_score", "mean") if "disruption_score" in work.columns else ("pickup_count", "mean"),
    )
    grouped["avg_pressure_ratio"] = [
        safe_ratio(n, d)
        for n, d in zip(grouped["target_pickup_count_next_hour"], grouped["pickup_count"])
    ]
    return clean_records(grouped.sort_values(["timestamp", "borough"]).tail(max(hours, 1) * 12))


def get_heatmap_zone_hour(hours: int = 24, top_n: int = 15) -> list[dict[str, Any]]:
    df = load_feature_frame()
    if df.empty:
        return []
    work = df.sort_values("timestamp").tail(max(hours, 1) * 300).copy()
    work["pressure_ratio"] = [
        safe_ratio(n, d)
        for n, d in zip(pd.to_numeric(work.get(TARGET_COLUMN), errors="coerce"), pd.to_numeric(work.get("pickup_count_roll_mean_24"), errors="coerce"))
    ]
    work = work[work.apply(lambda r: _is_valid_zone_name(r.get("zone_name"), r.get("borough")), axis=1)]
    work["hour"] = pd.to_datetime(work["timestamp"], errors="coerce").dt.hour
    work = work.sort_values("pressure_ratio", ascending=False, na_position="last").head(max(top_n, 1) * max(hours, 1))
    cols = [
        "zone_id",
        "zone_name",
        "borough",
        "timestamp",
        "hour",
        "pickup_count",
        TARGET_COLUMN,
        "pressure_ratio",
    ]
    for col in cols:
        if col not in work.columns:
            work[col] = None
    return clean_records(work[cols])


def get_weather_events_timeline(hours: int = 168) -> list[dict[str, Any]]:
    df = load_feature_frame()
    if df.empty:
        return []
    work = df.groupby("timestamp", as_index=False).agg(
        temperature=("temperature", "mean") if "temperature" in df.columns else ("pickup_count", "mean"),
        precipitation=("precipitation", "sum") if "precipitation" in df.columns else ("pickup_count", "mean"),
        snowfall=("snowfall", "sum") if "snowfall" in df.columns else ("pickup_count", "mean"),
        wind_speed=("wind_speed", "mean") if "wind_speed" in df.columns else ("pickup_count", "mean"),
        humidity=("humidity", "mean") if "humidity" in df.columns else ("pickup_count", "mean"),
        total_zone_incidents=("zone_incident_count", "sum") if "zone_incident_count" in df.columns else ("pickup_count", "sum"),
        citywide_incident_count=("citywide_incident_count", "max") if "citywide_incident_count" in df.columns else ("pickup_count", "sum"),
        avg_event_intensity_score=("event_intensity_score", "mean") if "event_intensity_score" in df.columns else ("pickup_count", "mean"),
        avg_disruption_score=("disruption_score", "mean") if "disruption_score" in df.columns else ("pickup_count", "mean"),
        incident_flag_count=("incident_flag", "sum") if "incident_flag" in df.columns else ("pickup_count", "sum"),
        road_closure_flag_count=("road_closure_flag", "sum") if "road_closure_flag" in df.columns else ("pickup_count", "sum"),
    )
    return clean_records(work.sort_values("timestamp").tail(max(hours, 1)))


def get_models_metrics_payload() -> dict[str, Any]:
    return {
        "model_metrics": clean_records(load_model_metrics()),
        "forecast_metrics": clean_records(load_forecast_metrics()),
        "contextual_comparison": clean_records(load_contextual_comparison()),
        "best_tabular_model": load_best_tabular_model(),
        "best_forecast_model": load_best_forecast_model(),
    }


def get_models_predictions(model: str | None = None, limit: int = 1000) -> list[dict[str, Any]]:
    df = load_predictions_frame()
    if df.empty:
        return []
    work = df.copy()
    if model and "model_name" in work.columns:
        filtered = work[work["model_name"] == model]
        if not filtered.empty:
            work = filtered
    if "actual" not in work.columns and TARGET_COLUMN in work.columns:
        work["actual"] = pd.to_numeric(work[TARGET_COLUMN], errors="coerce")
    if "predicted" not in work.columns and "predicted_next_hour_pickups" in work.columns:
        work["predicted"] = pd.to_numeric(work["predicted_next_hour_pickups"], errors="coerce")
    work["absolute_error"] = (
        pd.to_numeric(work.get("actual"), errors="coerce")
        - pd.to_numeric(work.get("predicted"), errors="coerce")
    ).abs()
    wanted = ["timestamp", "zone_id", "model_name", "actual", "predicted", "absolute_error"]
    for col in wanted:
        if col not in work.columns:
            work[col] = None
    return clean_records(work.sort_values("timestamp", ascending=False).head(max(limit, 1))[wanted])


def _resolve_model_name(model_name: str | None) -> str:
    return model_name or load_best_tabular_model()


def _predict_row(row_df: pd.DataFrame, model_name: str | None) -> tuple[float | None, str]:
    selected = _resolve_model_name(model_name)
    models = load_models()
    model_obj = models.get(selected)
    features = get_feature_columns()
    if model_obj is not None and features:
        available = [c for c in features if c in row_df.columns]
        if len(available) == len(features):
            try:
                pred = float(model_obj.predict(row_df[features])[0])
                return pred, "model_prediction"
            except Exception:
                pass
        return None, "Model prediction unavailable because feature schema was not found."
    joined_pred = _prediction_from_join(row_df, selected)
    if joined_pred.notna().any():
        return float(joined_pred.iloc[0]), "model_prediction"
    observed = safe_number(row_df.iloc[0].get(TARGET_COLUMN))
    if isinstance(observed, (float, int)):
        return float(observed), "observed_target_proxy"
    return None, "Model prediction unavailable because feature schema was not found."


def run_simulation(payload: dict[str, Any]) -> dict[str, Any]:
    zone_id = payload["zone_id"]
    feature_df = load_feature_frame()
    if feature_df.empty:
        return {"error": "No model-ready feature data available."}
    work = feature_df[pd.to_numeric(feature_df["zone_id"], errors="coerce") == float(zone_id)].copy()
    if work.empty:
        return {"error": f"Zone {zone_id} was not found in feature data."}
    if payload.get("timestamp"):
        ts = pd.to_datetime(payload["timestamp"], errors="coerce")
        selected = work[work["timestamp"] == ts]
        if not selected.empty:
            work = selected
    work = work.sort_values("timestamp")
    base_row = work.iloc[[-1]].copy()
    scenario_row = base_row.copy()

    for col in [
        "temperature",
        "precipitation",
        "event_intensity_score",
        "disruption_score",
        "pickup_count_roll_mean_24",
    ]:
        if payload.get(col) is not None and col in scenario_row.columns:
            scenario_row.at[scenario_row.index[0], col] = payload[col]

    baseline_pred, baseline_src = _predict_row(base_row, payload.get("model_name"))
    scenario_pred, scenario_src = _predict_row(scenario_row, payload.get("model_name"))
    final_source = scenario_src if scenario_src != "model_prediction" else "model_prediction"

    denom = safe_number(
        scenario_row.iloc[0].get("pickup_count_roll_mean_24")
        if payload.get("pickup_count_roll_mean_24") is None
        else payload.get("pickup_count_roll_mean_24")
    )
    pressure = safe_ratio(scenario_pred, denom)
    label = pressure_label(pressure)
    actual_next = payload.get("actual_next_hour_pickups")
    if actual_next is None:
        actual_next = safe_number(base_row.iloc[0].get(TARGET_COLUMN))
    absolute_error = None
    if scenario_pred is not None and isinstance(actual_next, (float, int)):
        absolute_error = abs(float(scenario_pred) - float(actual_next))

    recommendation = {
        "High Pressure": "Operational Priority: high-pressure zone. Recommended Monitoring and review supply coverage.",
        "Elevated Pressure": "Elevated demand pressure detected. Review Supply Coverage and monitor short-term trend.",
        "Typical Pressure": "Typical pressure conditions. Continue routine monitoring.",
        "Low Pressure": "Low pressure period. Keep standard monitoring cadence.",
        "Unavailable": "Pressure ratio unavailable due to denominator or prediction constraints.",
    }[label]

    return {
        "zone_id": safe_number(base_row.iloc[0].get("zone_id")),
        "zone_name": base_row.iloc[0].get("zone_name"),
        "borough": base_row.iloc[0].get("borough"),
        "timestamp": (
            base_row.iloc[0]["timestamp"].isoformat()
            if isinstance(base_row.iloc[0].get("timestamp"), pd.Timestamp)
            else str(base_row.iloc[0].get("timestamp"))
        ),
        "model_name": _resolve_model_name(payload.get("model_name")),
        "prediction_source": final_source,
        "baseline_prediction": safe_number(baseline_pred),
        "predicted_next_hour_pickups": safe_number(scenario_pred),
        "pickup_count_roll_mean_24": safe_number(denom),
        "pressure_ratio": safe_number(pressure),
        "pressure_label": label,
        "actual_next_hour_pickups": safe_number(actual_next),
        "absolute_error": safe_number(absolute_error),
        "recommendation": recommendation,
        "proxy_note": PROXY_NOTE,
    }


def get_overview_payload() -> dict[str, Any]:
    overview = load_overview_fallback()
    summary = load_dataset_summary()
    model_metrics = load_model_metrics()
    best_tabular = load_best_tabular_model()
    best_forecast = load_best_forecast_model()

    best_row = pd.Series(dtype="object")
    if not model_metrics.empty and "model_name" in model_metrics.columns:
        candidates = model_metrics[model_metrics["model_name"] == best_tabular]
        if not candidates.empty:
            best_row = candidates.iloc[0]

    return {
        "project_name": overview.get("project_name", "MASEER"),
        "subtitle": overview.get("subtitle", "NYC Taxi Demand Pressure Forecasting"),
        "target": TARGET_COLUMN,
        "target_definition": "Next-hour yellow taxi pickup count by NYC TLC taxi zone.",
        "proxy_note": PROXY_NOTE,
        "best_tabular_model": best_tabular,
        "best_forecast_model": best_forecast,
        "best_test_mae": safe_number(best_row.get("test_mae", overview.get("best_test_mae"))),
        "best_test_rmse": safe_number(best_row.get("test_rmse", overview.get("best_test_rmse"))),
        "best_test_r2": safe_number(best_row.get("test_r2", overview.get("best_test_r2"))),
        "rows": safe_number(summary.get("rows")),
        "columns": safe_number(summary.get("columns")),
        "zones": safe_number(summary.get("number_of_zones")),
        "time_range_start": summary.get("time_range_start"),
        "time_range_end": summary.get("time_range_end"),
        "data_sources": overview.get("data_sources", DATA_SOURCES),
    }


def get_data_info_payload() -> dict[str, Any]:
    summary = load_dataset_summary()
    return {
        "dataset_summary": summary,
        "feature_dictionary": clean_records(load_feature_dictionary()),
        "event_integration_summary": clean_records(load_event_integration_summary()),
        "data_quality_summary": load_data_quality_summary(),
        "target_explanation": {
            "target_column": TARGET_COLUMN,
            "target_definition": "Next-hour yellow taxi pickup count by NYC TLC taxi zone.",
            "proxy_note": PROXY_NOTE,
        },
        "data_sources": summary.get("data_sources", DATA_SOURCES),
    }


def get_figures_manifest() -> list[dict[str, Any]]:
    roots = [
        PROJECT_ROOT / "frontend" / "public" / "figures",
        PROJECT_ROOT / "reports" / "figures",
        PROJECT_ROOT / "artifacts" / "figures",
    ]
    manifests: list[dict[str, Any]] = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.glob("**/*")):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix not in {".png", ".jpg", ".jpeg", ".svg", ".webp"}:
                continue
            rel_name = path.stem.replace("_", " ").title()
            category = path.parent.name.replace("_", " ").title()
            url = None
            if root == PROJECT_ROOT / "frontend" / "public" / "figures":
                url = "/figures/" + str(path.relative_to(root)).replace("\\", "/")
            manifests.append(
                {
                    "title": rel_name,
                    "category": category,
                    "path": str(path),
                    "url": url,
                }
            )
    return manifests
