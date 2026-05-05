from __future__ import annotations

from pathlib import Path

import pandas as pd

from src.config.settings import Settings
from src.data.validation import assert_yellow_schema
from src.utils.io import ensure_dir, read_dataframe, write_dataframe, write_json
from src.utils.logging_utils import get_logger


LOGGER = get_logger(__name__)
TRIP_COLUMNS = [
    "VendorID",
    "tpep_pickup_datetime",
    "tpep_dropoff_datetime",
    "passenger_count",
    "trip_distance",
    "PULocationID",
    "DOLocationID",
    "RatecodeID",
    "store_and_fwd_flag",
    "payment_type",
    "fare_amount",
    "extra",
    "mta_tax",
    "tip_amount",
    "tolls_amount",
    "improvement_surcharge",
    "total_amount",
]


def load_zone_lookup(settings: Settings) -> pd.DataFrame:
    zone_lookup_path = settings.path("external_data_dir") / "taxi_zone_lookup.csv"
    zones = read_dataframe(zone_lookup_path)
    zones.columns = [column.strip() for column in zones.columns]
    zones = zones.rename(columns={"LocationID": "zone_id", "Borough": "borough", "Zone": "zone_name", "service_zone": "service_zone"})
    return zones[["zone_id", "borough", "zone_name", "service_zone"]].drop_duplicates().sort_values("zone_id").reset_index(drop=True)


def raw_yellow_paths(settings: Settings) -> list[Path]:
    root = settings.path("raw_data_dir") / "yellow_taxi"
    return sorted(root.rglob("yellow_tripdata_*.parquet"))


def load_raw_yellow_data(settings: Settings) -> pd.DataFrame:
    paths = raw_yellow_paths(settings)
    if not paths:
        raise FileNotFoundError("No raw yellow taxi parquet files found. Run the ingest command first.")
    max_rows = int(settings.data_cfg["max_rows_per_file"])
    frames: list[pd.DataFrame] = []
    for path in paths:
        LOGGER.info("Reading %s", path.name)
        frame = pd.read_parquet(path, columns=TRIP_COLUMNS)
        assert_yellow_schema(frame)
        if max_rows > 0 and len(frame) > max_rows:
            frame = frame.sample(n=max_rows, random_state=settings.random_state).copy()
        frame["source_file"] = path.name
        frames.append(frame)
    combined = pd.concat(frames, ignore_index=True)
    LOGGER.info("Loaded %s rows from %s file(s)", len(combined), len(paths))
    return combined


def clean_trip_data(raw_df: pd.DataFrame, zones: pd.DataFrame, settings: Settings) -> tuple[pd.DataFrame, dict]:
    df = raw_df.copy()
    audit = {
        "raw_rows": int(len(df)),
        "duplicates_removed": 0,
        "invalid_timestamp_rows": 0,
        "source_month_mismatch_rows": 0,
        "invalid_zone_rows": 0,
        "outlier_rows_removed": 0,
        "outliers_by_reason": {},
    }
    df["tpep_pickup_datetime"] = pd.to_datetime(df["tpep_pickup_datetime"], errors="coerce")
    df["tpep_dropoff_datetime"] = pd.to_datetime(df["tpep_dropoff_datetime"], errors="coerce")
    invalid_ts_mask = df["tpep_pickup_datetime"].isna() | df["tpep_dropoff_datetime"].isna()
    audit["invalid_timestamp_rows"] = int(invalid_ts_mask.sum())
    df = df.loc[~invalid_ts_mask].copy()

    before = len(df)
    df = df.drop_duplicates().reset_index(drop=True)
    audit["duplicates_removed"] = int(before - len(df))

    if "source_file" in df.columns:
        expected_month = df["source_file"].str.extract(r"(\d{4}-\d{2})", expand=False)
        observed_month = df["tpep_pickup_datetime"].dt.strftime("%Y-%m")
        month_mask = expected_month.eq(observed_month)
        audit["source_month_mismatch_rows"] = int((~month_mask).sum())
        df = df.loc[month_mask].copy()

    df["trip_duration_minutes"] = (df["tpep_dropoff_datetime"] - df["tpep_pickup_datetime"]).dt.total_seconds() / 60.0
    min_trip_minutes = float(settings.data_cfg["min_trip_minutes"])
    max_trip_minutes = float(settings.data_cfg["max_trip_minutes"])
    min_trip_distance = float(settings.data_cfg["min_trip_distance"])
    max_trip_distance = float(settings.data_cfg["max_trip_distance"])
    min_fare_amount = float(settings.data_cfg.get("min_fare_amount", 0.0))
    max_fare_amount = float(settings.data_cfg.get("max_fare_amount", 500.0))
    min_total_amount = float(settings.data_cfg.get("min_total_amount", 0.0))
    max_total_amount = float(settings.data_cfg.get("max_total_amount", 600.0))
    min_passenger_count = float(settings.data_cfg.get("min_passenger_count", 0.0))
    max_passenger_count = float(settings.data_cfg.get("max_passenger_count", 6.0))

    df["trip_distance"] = pd.to_numeric(df["trip_distance"], errors="coerce")
    df["fare_amount"] = pd.to_numeric(df["fare_amount"], errors="coerce")
    df["total_amount"] = pd.to_numeric(df["total_amount"], errors="coerce")
    df["passenger_count"] = pd.to_numeric(df["passenger_count"], errors="coerce")
    outlier_rules = {
        "trip_duration_below_min": df["trip_duration_minutes"] < min_trip_minutes,
        "trip_duration_above_max": df["trip_duration_minutes"] > max_trip_minutes,
        "trip_distance_below_min": df["trip_distance"] < min_trip_distance,
        "trip_distance_above_max": df["trip_distance"] > max_trip_distance,
        "fare_amount_outside_range": df["fare_amount"].isna() | (df["fare_amount"] < min_fare_amount) | (df["fare_amount"] > max_fare_amount),
        "total_amount_outside_range": df["total_amount"].isna() | (df["total_amount"] < min_total_amount) | (df["total_amount"] > max_total_amount),
        "passenger_count_outside_range": df["passenger_count"].isna() | (df["passenger_count"] < min_passenger_count) | (df["passenger_count"] > max_passenger_count),
        "missing_pickup_or_dropoff_zone": df["PULocationID"].isna() | df["DOLocationID"].isna(),
    }
    audit["outliers_by_reason"] = {reason: int(mask.sum()) for reason, mask in outlier_rules.items()}
    outlier_mask = pd.concat(outlier_rules.values(), axis=1).any(axis=1)
    audit["outlier_rows_removed"] = int(outlier_mask.sum())
    df = df.loc[~outlier_mask].copy()

    valid_zone_ids = set(zones["zone_id"].astype(int).tolist())
    zone_mask = df["PULocationID"].astype(int).isin(valid_zone_ids) & df["DOLocationID"].astype(int).isin(valid_zone_ids)
    audit["invalid_zone_rows"] = int((~zone_mask).sum())
    df = df.loc[zone_mask].copy()

    df["pickup_hour"] = df["tpep_pickup_datetime"].dt.floor(settings.feature_cfg["aggregation_frequency"])
    audit["clean_rows"] = int(len(df))
    audit["row_count_before_cleaning"] = audit["raw_rows"]
    audit["row_count_after_cleaning"] = audit["clean_rows"]
    audit["cleaning_thresholds"] = {
        "trip_duration_minutes": [min_trip_minutes, max_trip_minutes],
        "trip_distance": [min_trip_distance, max_trip_distance],
        "fare_amount": [min_fare_amount, max_fare_amount],
        "total_amount": [min_total_amount, max_total_amount],
        "passenger_count": [min_passenger_count, max_passenger_count],
    }
    return df.reset_index(drop=True), audit


def aggregate_zone_hour(clean_df: pd.DataFrame, zones: pd.DataFrame) -> pd.DataFrame:
    grouped = (
        clean_df.groupby(["pickup_hour", "PULocationID"], as_index=False)
        .agg(
            pickup_count=("VendorID", "count"),
            mean_trip_distance=("trip_distance", "mean"),
            mean_total_amount=("total_amount", "mean"),
            mean_fare_amount=("fare_amount", "mean"),
            mean_duration_minutes=("trip_duration_minutes", "mean"),
            median_duration_minutes=("trip_duration_minutes", "median"),
            mean_passenger_count=("passenger_count", "mean"),
            unique_dropoff_zones=("DOLocationID", "nunique"),
        )
        .rename(columns={"PULocationID": "zone_id"})
    )
    grouped["pickup_count"] = grouped["pickup_count"].astype(int)
    grouped["timestamp"] = pd.to_datetime(grouped["pickup_hour"])
    result = grouped.merge(zones, on="zone_id", how="left")
    return result.sort_values(["timestamp", "zone_id"]).reset_index(drop=True)


def build_zone_hour_grid(aggregated_df: pd.DataFrame, zones: pd.DataFrame) -> pd.DataFrame:
    def fill_group_median(series: pd.Series) -> pd.Series:
        if series.notna().any():
            return series.fillna(series.median())
        return series.fillna(0.0)

    active_zones = zones[zones["zone_id"].isin(aggregated_df["zone_id"].unique())].copy()
    timestamps = pd.date_range(aggregated_df["timestamp"].min(), aggregated_df["timestamp"].max(), freq="1h")
    grid = pd.MultiIndex.from_product([timestamps, active_zones["zone_id"].astype(int).tolist()], names=["timestamp", "zone_id"]).to_frame(index=False)
    aggregated_core = aggregated_df.drop(columns=["pickup_hour", "borough", "zone_name", "service_zone"], errors="ignore")
    merged = grid.merge(aggregated_core, on=["timestamp", "zone_id"], how="left")
    merged = merged.merge(active_zones, on="zone_id", how="left")
    zero_fill_cols = ["pickup_count"]
    stat_fill_cols = [
        "mean_trip_distance",
        "mean_total_amount",
        "mean_fare_amount",
        "mean_duration_minutes",
        "median_duration_minutes",
        "mean_passenger_count",
        "unique_dropoff_zones",
    ]
    for column in zero_fill_cols:
        merged[column] = merged[column].fillna(0)
    for column in stat_fill_cols:
        merged[column] = merged.groupby("zone_id")[column].transform(fill_group_median)
    return merged.sort_values(["zone_id", "timestamp"]).reset_index(drop=True)


def prepare_datasets(settings: Settings) -> dict:
    ensure_dir(settings.path("interim_data_dir"))
    ensure_dir(settings.path("processed_data_dir"))
    zones = load_zone_lookup(settings)
    raw_df = load_raw_yellow_data(settings)
    clean_df, audit = clean_trip_data(raw_df=raw_df, zones=zones, settings=settings)
    aggregated_df = aggregate_zone_hour(clean_df=clean_df, zones=zones)
    panel_df = build_zone_hour_grid(aggregated_df=aggregated_df, zones=zones)

    interim_path = settings.path("interim_data_dir") / "yellow_trip_cleaned.parquet"
    aggregated_path = settings.path("processed_data_dir") / "zone_hour_aggregates.parquet"
    audit_path = settings.path("interim_data_dir") / "data_audit.json"
    write_dataframe(clean_df, interim_path)
    write_dataframe(panel_df, aggregated_path)
    write_json(audit, audit_path)
    return {"zones": zones, "clean_df": clean_df, "panel_df": panel_df, "audit": audit}
