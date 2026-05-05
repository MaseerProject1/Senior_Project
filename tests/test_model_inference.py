from __future__ import annotations

import pandas as pd

from src.config.settings import load_settings
from src.features.engineering import ALL_FEATURES, build_feature_dataset
from src.models.training import train_tabular_models


def build_training_frame() -> pd.DataFrame:
    timestamps = pd.date_range("2024-01-01 00:00:00", periods=220, freq="1h")
    rows = []
    for zone_id in [1, 2]:
        for idx, ts in enumerate(timestamps):
            rows.append(
                {
                    "timestamp": ts,
                    "zone_id": zone_id,
                    "pickup_count": (idx % 24) + zone_id,
                    "mean_trip_distance": 1.0 + 0.1 * zone_id,
                    "mean_total_amount": 12.0 + (idx % 5),
                    "mean_fare_amount": 10.0 + (idx % 3),
                    "mean_duration_minutes": 14.0 + (idx % 4),
                    "median_duration_minutes": 13.0 + (idx % 4),
                    "mean_passenger_count": 1.5,
                    "unique_dropoff_zones": 8,
                    "borough": "Manhattan",
                    "zone_name": f"Zone {zone_id}",
                    "service_zone": "Yellow Zone",
                }
            )
    return pd.DataFrame(rows)


def test_trained_tabular_model_runs_inference():
    settings = load_settings()
    feature_df = build_feature_dataset(build_training_frame(), settings)
    output = train_tabular_models(feature_df, settings)
    best_model_name = output["metrics_df"].iloc[0]["model_name"]
    model = output["fitted_models"][best_model_name]
    row = feature_df.iloc[[0]]
    pred = model.predict(row[ALL_FEATURES])
    assert len(pred) == 1
    assert float(pred[0]) >= 0
