from __future__ import annotations

import pandas as pd

from src.config.settings import load_settings
from src.features.engineering import TARGET_COLUMN, build_feature_dataset


def build_panel() -> pd.DataFrame:
    timestamps = pd.date_range("2024-01-01 00:00:00", periods=200, freq="1h")
    rows = []
    for zone_id in [1, 2]:
        for idx, ts in enumerate(timestamps):
            rows.append(
                {
                    "timestamp": ts,
                    "zone_id": zone_id,
                    "pickup_count": (idx % 10) + zone_id,
                    "mean_trip_distance": 1.0 + zone_id,
                    "mean_total_amount": 12.0,
                    "mean_fare_amount": 10.0,
                    "mean_duration_minutes": 15.0,
                    "median_duration_minutes": 14.0,
                    "mean_passenger_count": 1.5,
                    "unique_dropoff_zones": 5,
                    "borough": "Manhattan",
                    "zone_name": f"Zone {zone_id}",
                    "service_zone": "Yellow Zone",
                }
            )
    return pd.DataFrame(rows)


def test_feature_dataset_contains_target_and_lags():
    settings = load_settings()
    feature_df = build_feature_dataset(build_panel(), settings)
    assert TARGET_COLUMN in feature_df.columns
    assert "pickup_count_lag_24" in feature_df.columns
    assert feature_df[TARGET_COLUMN].isna().sum() == 0
