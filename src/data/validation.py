from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


REQUIRED_YELLOW_COLUMNS = [
    "VendorID",
    "tpep_pickup_datetime",
    "tpep_dropoff_datetime",
    "passenger_count",
    "trip_distance",
    "RatecodeID",
    "store_and_fwd_flag",
    "PULocationID",
    "DOLocationID",
    "payment_type",
    "fare_amount",
    "extra",
    "mta_tax",
    "tip_amount",
    "tolls_amount",
    "improvement_surcharge",
    "total_amount",
]


@dataclass(frozen=True)
class ValidationReport:
    row_count: int
    missing_columns: list[str]


def validate_yellow_schema(df: pd.DataFrame) -> ValidationReport:
    missing = [column for column in REQUIRED_YELLOW_COLUMNS if column not in df.columns]
    return ValidationReport(row_count=len(df), missing_columns=missing)


def assert_yellow_schema(df: pd.DataFrame) -> None:
    report = validate_yellow_schema(df)
    if report.missing_columns:
        raise ValueError(f"Yellow taxi schema mismatch. Missing columns: {report.missing_columns}")
