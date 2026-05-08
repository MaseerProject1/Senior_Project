from __future__ import annotations

from pydantic import BaseModel


class SimulationRequest(BaseModel):
    zone_id: int
    timestamp: str | None = None
    model_name: str | None = None
    temperature: float | None = None
    precipitation: float | None = None
    event_intensity_score: float | None = None
    disruption_score: float | None = None
    pickup_count_roll_mean_24: float | None = None
    actual_next_hour_pickups: float | None = None
