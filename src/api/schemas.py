"""Pydantic request / response schemas for the MASEER API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SimulationRequest(BaseModel):
    """Inputs accepted by ``POST /api/simulation/run``.

    All scenario knobs are optional — when missing the API uses the latest
    real feature values for the requested ``zone_id``.
    """

    zone_id: int
    timestamp: str | None = None
    model: str | None = Field(default=None, alias="model_name")
    temperature: float | None = None
    precipitation: float | None = None
    snowfall: float | None = None
    wind_speed: float | None = None
    humidity: float | None = None
    event_intensity_score: float | None = None
    disruption_score: float | None = None
    incident_flag: int | float | None = None
    road_closure_flag: int | float | None = None
    pickup_count_roll_mean_24: float | None = None
    actual_next_hour_pickups: float | None = None

    model_config = {
        "populate_by_name": True,
        "extra": "ignore",
    }


class SimulationResponse(BaseModel):
    zone_id: int | None = None
    zone_name: str | None = None
    borough: str | None = None
    timestamp: str | None = None
    model: str | None = None
    baseline_prediction: float | None = None
    scenario_prediction: float | None = None
    delta: float | None = None
    delta_percent: float | None = None
    baseline_pressure_ratio: float | None = None
    scenario_pressure_ratio: float | None = None
    pressure_label: str | None = None
    absolute_error: float | None = None
    recommendation: str | None = None
    inputs_used: dict[str, Any] = {}
    prediction_source: str | None = None
    proxy_note: str | None = None
