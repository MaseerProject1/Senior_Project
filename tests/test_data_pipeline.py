from __future__ import annotations

import pandas as pd

from src.config.settings import load_settings
from src.data.preprocess import aggregate_zone_hour, build_zone_hour_grid, clean_trip_data


def sample_zone_lookup() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "zone_id": [1, 2],
            "borough": ["Manhattan", "Queens"],
            "zone_name": ["Zone A", "Zone B"],
            "service_zone": ["Yellow Zone", "Yellow Zone"],
        }
    )


def sample_raw_trips() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "VendorID": [1, 1, 1],
            "tpep_pickup_datetime": ["2024-01-01 08:05:00", "2024-01-01 08:35:00", "2024-01-01 09:10:00"],
            "tpep_dropoff_datetime": ["2024-01-01 08:20:00", "2024-01-01 08:50:00", "2024-01-01 09:24:00"],
            "passenger_count": [1, 2, 1],
            "trip_distance": [1.2, 2.0, 1.1],
            "RatecodeID": [1, 1, 1],
            "store_and_fwd_flag": ["N", "N", "N"],
            "PULocationID": [1, 1, 2],
            "DOLocationID": [2, 2, 1],
            "payment_type": [1, 1, 2],
            "fare_amount": [10.0, 13.0, 9.0],
            "extra": [0.5, 0.5, 0.5],
            "mta_tax": [0.5, 0.5, 0.5],
            "tip_amount": [2.0, 2.5, 0.0],
            "tolls_amount": [0.0, 0.0, 0.0],
            "improvement_surcharge": [0.3, 0.3, 0.3],
            "total_amount": [13.3, 16.3, 9.8],
        }
    )


def test_clean_and_aggregate_pipeline():
    settings = load_settings()
    clean_df, audit = clean_trip_data(sample_raw_trips(), sample_zone_lookup(), settings)
    assert audit["clean_rows"] == 3
    aggregated = aggregate_zone_hour(clean_df, sample_zone_lookup())
    assert {"timestamp", "zone_id", "pickup_count"}.issubset(aggregated.columns)
    assert aggregated["pickup_count"].sum() == 3
    panel = build_zone_hour_grid(aggregated, sample_zone_lookup())
    assert panel["zone_id"].nunique() == 2
