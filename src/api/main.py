"""FastAPI entry-point for the MASEER dashboard backend."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from src.api.schemas import SimulationRequest
from src.config.settings import PROJECT_ROOT
from src.api.service import (
    PROXY_NOTE,
    TARGET_COLUMN,
    get_borough_trend,
    get_city_trend,
    get_dashboard_snapshot,
    get_data_diagnostics,
    get_figures_manifest,
    get_models,
    get_models_metrics_payload,
    get_models_predictions,
    get_overview,
    get_startup_log_counts,
    get_taxi_zone_geojson,
    get_timestamps,
    get_zone_history,
    get_zone_hour_heatmap,
    get_zones,
    run_simulation,
)


logger = logging.getLogger("maseer.api")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s | %(message)s")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    diag = get_data_diagnostics()
    counts = get_startup_log_counts()
    logger.info("MASEER API starting...")
    logger.info(
        "Dashboard dataset path: %s | source tag: %s | fallback_snapshot_used=%s | processed_parquet_failed=%s",
        diag.get("dashboard_dataset_path"),
        diag.get("dashboard_source_tag"),
        diag.get("fallback_snapshot_used"),
        diag.get("processed_parquet_failed"),
    )
    logger.info(
        "Final dashboard dataset rows: %s | zones (lookup): %s | distinct zones in frame: %s",
        diag["final_dataset_rows"],
        diag["zone_lookup_rows"],
        diag["snapshot_zones"],
    )
    logger.info(
        "Timestamps (modeling): count=%s min=%s max=%s",
        diag["timestamp_count"],
        diag["timestamp_min"],
        diag["timestamp_max"],
    )
    if int(diag.get("timestamp_count") or 0) <= 1 and int(diag.get("final_dataset_rows") or 0) > 1:
        logger.warning(
            "Timestamps count is %s but dashboard frame has %s rows — timeline may be wrong.",
            diag.get("timestamp_count"),
            diag.get("final_dataset_rows"),
        )
    logger.info(
        "Model metrics rows: %s | prediction rows: %s | hourly timeline (weather/collisions): %s",
        diag["model_metrics_rows"],
        diag["predictions_rows"],
        diag["timeline_rows"],
    )
    logger.info(
        "GeoJSON loaded: %s | feature count: %s | modeling data path: %s",
        diag["geojson_loaded"],
        diag["geojson_feature_count"],
        diag["feature_parquet_path"],
    )
    logger.info(
        "Sample counts — city trend (h=168): %s | borough trend (h=168): %s | latest snapshot rows: %s",
        counts["city_trend_rows_168"],
        counts["borough_trend_rows_168"],
        counts["snapshot_rows_latest"],
    )
    yield


app = FastAPI(
    title="MASEER API",
    version="2.0.0",
    description=(
        "Backend data service for the MASEER NYC Taxi Demand Pressure dashboard. "
        f"Target: `{TARGET_COLUMN}` — {PROXY_NOTE}"
    ),
    lifespan=_lifespan,
)


_reports_figures = PROJECT_ROOT / "reports" / "figures"
_artifacts_figures = PROJECT_ROOT / "artifacts" / "figures"
if _reports_figures.is_dir():
    app.mount(
        "/static/reports/figures",
        StaticFiles(directory=str(_reports_figures)),
        name="reports_figures_static",
    )
if _artifacts_figures.is_dir():
    app.mount(
        "/static/artifacts/figures",
        StaticFiles(directory=str(_artifacts_figures)),
        name="artifacts_figures_static",
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health / overview / catalogue endpoints
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, Any]:
    diag = get_data_diagnostics()
    return {
        "status": "ok",
        "service": "MASEER API",
        "target": TARGET_COLUMN,
        "data_loaded": bool(diag.get("final_dataset_rows", 0) > 0),
    }


@app.get("/api/overview")
def overview() -> dict[str, Any]:
    return get_overview()


@app.get("/api/timestamps")
def timestamps() -> dict[str, Any]:
    return get_timestamps()


@app.get("/api/models")
def models() -> dict[str, Any]:
    return get_models()


@app.get("/api/zones")
def zones() -> dict[str, Any]:
    return get_zones()


# ---------------------------------------------------------------------------
# Dashboard data endpoints
# ---------------------------------------------------------------------------


@app.get("/api/dashboard/snapshot")
def dashboard_snapshot(
    timestamp: str | None = Query(default=None),
    model: str | None = Query(default=None),
    borough: str | None = Query(default=None),
    limit: int | None = Query(default=None, ge=1, le=10_000),
) -> dict[str, Any]:
    return get_dashboard_snapshot(timestamp=timestamp, model=model, borough=borough, limit=limit)


@app.get("/api/city/trend")
def city_trend(
    hours: int = Query(default=168, ge=1, le=24 * 365),
    start: str | None = Query(default=None),
    end: str | None = Query(default=None),
    model: str | None = Query(default=None),
) -> dict[str, Any]:
    return get_city_trend(hours=hours, start=start, end=end, model=model)


@app.get("/api/borough/trend")
def borough_trend(
    hours: int = Query(default=168, ge=1, le=24 * 365),
    start: str | None = Query(default=None),
    end: str | None = Query(default=None),
    model: str | None = Query(default=None),
) -> dict[str, Any]:
    return get_borough_trend(hours=hours, start=start, end=end, model=model)


@app.get("/api/zone/{zone_id}/history")
def zone_history(
    zone_id: int,
    hours: int = Query(default=168, ge=1, le=24 * 365),
    start: str | None = Query(default=None),
    end: str | None = Query(default=None),
    model: str | None = Query(default=None),
) -> dict[str, Any]:
    return get_zone_history(zone_id=zone_id, hours=hours, start=start, end=end, model=model)


@app.get("/api/heatmap/zone-hour")
def heatmap_zone_hour(
    hours: int = Query(default=168, ge=1, le=24 * 365),
    top_n: int = Query(default=20, ge=1, le=263),
    model: str | None = Query(default=None),
    metric: str = Query(default="pressure_ratio"),
) -> dict[str, Any]:
    return get_zone_hour_heatmap(hours=hours, top_n=top_n, model=model, metric=metric)


# ---------------------------------------------------------------------------
# Map / figures
# ---------------------------------------------------------------------------


@app.get("/api/map/taxi-zones")
def map_taxi_zones() -> dict[str, Any]:
    payload = get_taxi_zone_geojson()
    if payload.get("error") and not payload.get("features"):
        raise HTTPException(status_code=404, detail=payload["error"])
    return payload


@app.get("/api/figures")
def figures() -> dict[str, Any]:
    return get_figures_manifest()


# ---------------------------------------------------------------------------
# Models / predictions
# ---------------------------------------------------------------------------


@app.get("/api/models/metrics")
def models_metrics() -> dict[str, Any]:
    return get_models_metrics_payload()


@app.get("/api/models/predictions")
def models_predictions(
    model: str | None = Query(default=None),
    zone_id: int | None = Query(default=None, ge=1),
    hours: int = Query(default=168, ge=1, le=24 * 365),
    start: str | None = Query(default=None),
    end: str | None = Query(default=None),
    limit: int = Query(default=5_000, ge=1, le=50_000),
) -> dict[str, Any]:
    return get_models_predictions(
        model=model, zone_id=zone_id, hours=hours, start=start, end=end, limit=limit
    )


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------


@app.post("/api/simulation/run")
def simulation_run(payload: SimulationRequest) -> dict[str, Any]:
    response = run_simulation(payload.model_dump(by_alias=False))
    if "error" in response:
        raise HTTPException(status_code=404, detail=response["error"])
    return response
