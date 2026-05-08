from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from src.api.schemas import SimulationRequest
from src.api.service import (
    TARGET_COLUMN,
    build_snapshot,
    get_borough_trend,
    get_city_trend,
    get_data_info_payload,
    get_figures_manifest,
    get_heatmap_zone_hour,
    get_models_metrics_payload,
    get_models_predictions,
    get_overview_payload,
    get_timestamps,
    get_weather_events_timeline,
    get_zone_history,
    get_zones,
    run_simulation,
)

app = FastAPI(
    title="MASEER API",
    version="1.0.0",
    description=(
        "Interactive API for NYC taxi demand-pressure dashboards. "
        "Target represents next-hour pickup count as a waiting-pressure proxy."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "MASEER API", "target": TARGET_COLUMN}


@app.get("/api/overview")
def overview() -> dict:
    return get_overview_payload()


@app.get("/api/zones")
def zones() -> dict:
    return {"rows": get_zones()}


@app.get("/api/timestamps")
def timestamps(zone_id: int | None = Query(default=None)) -> dict:
    return {"rows": get_timestamps(zone_id=zone_id)}


@app.get("/api/dashboard/snapshot")
def dashboard_snapshot(
    timestamp: str | None = Query(default=None),
    model: str | None = Query(default=None),
) -> dict:
    return build_snapshot(timestamp=timestamp, model_name=model)


@app.get("/api/zone/{zone_id}/history")
def zone_history(zone_id: int, hours: int = Query(default=168, ge=1, le=24 * 90)) -> dict:
    return {"zone_id": zone_id, "hours": hours, "rows": get_zone_history(zone_id=zone_id, hours=hours)}


@app.get("/api/city/trend")
def city_trend(hours: int = Query(default=168, ge=1, le=24 * 365)) -> dict:
    return {"hours": hours, "rows": get_city_trend(hours=hours)}


@app.get("/api/borough/trend")
def borough_trend(hours: int = Query(default=168, ge=1, le=24 * 365)) -> dict:
    return {"hours": hours, "rows": get_borough_trend(hours=hours)}


@app.get("/api/heatmap/zone-hour")
def heatmap_zone_hour(
    hours: int = Query(default=24, ge=1, le=24 * 30),
    top_n: int = Query(default=15, ge=1, le=500),
) -> dict:
    return {"hours": hours, "top_n": top_n, "rows": get_heatmap_zone_hour(hours=hours, top_n=top_n)}


@app.get("/api/weather-events/timeline")
def weather_events_timeline(hours: int = Query(default=168, ge=1, le=24 * 365)) -> dict:
    return {"hours": hours, "rows": get_weather_events_timeline(hours=hours)}


@app.get("/api/models/metrics")
def models_metrics() -> dict:
    return get_models_metrics_payload()


@app.get("/api/models/predictions")
def models_predictions(
    model: str | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=50000),
) -> dict:
    return {"rows": get_models_predictions(model=model, limit=limit), "limit": limit}


@app.post("/api/simulation/run")
def simulation_run(payload: SimulationRequest) -> dict:
    response = run_simulation(payload.model_dump())
    if "error" in response:
        raise HTTPException(status_code=404, detail=response["error"])
    return response


@app.get("/api/data-info")
def data_info() -> dict:
    return get_data_info_payload()


@app.get("/api/figures")
def figures() -> dict:
    return {"rows": get_figures_manifest()}
