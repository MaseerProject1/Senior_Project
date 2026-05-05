from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path.cwd() / ".mplconfig"))

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

from src.config.settings import Settings
from src.features.engineering import (
    BASE_FEATURES,
    CATEGORICAL_FEATURES,
    CONTEXTUAL_FEATURES,
    EVENT_FEATURES,
    INTERACTION_FEATURES,
    LAG_FEATURES,
    TARGET_COLUMN,
    WEATHER_FEATURES,
)
from src.utils.io import ensure_dir, read_dataframe, write_dataframe, write_json


sns.set_theme(style="whitegrid")


def _figure_dir(settings: Settings) -> Path:
    return ensure_dir(settings.path("reports_dir") / "figures")


def _table_dir(settings: Settings) -> Path:
    return ensure_dir(settings.path("reports_dir") / "tables")


def _dataset_profile(name: str, df: pd.DataFrame) -> dict:
    return {
        "dataset": name,
        "rows": int(len(df)),
        "columns": int(len(df.columns)),
        "duplicate_rows": int(df.duplicated().sum()) if not df.empty else 0,
        "column_names": ", ".join(df.columns.astype(str).tolist()),
    }


def save_dataset_profiles(datasets: dict[str, pd.DataFrame], settings: Settings) -> dict[str, Path]:
    table_dir = _table_dir(settings)
    profiles = []
    missing_rows = []
    dtype_rows = []
    for name, df in datasets.items():
        if df is None or df.empty:
            continue
        profiles.append(_dataset_profile(name, df))
        for column in df.columns:
            missing_rows.append(
                {
                    "dataset": name,
                    "column": column,
                    "missing_count": int(df[column].isna().sum()),
                    "missing_percent": float(df[column].isna().mean() * 100),
                }
            )
            dtype_rows.append({"dataset": name, "column": column, "dtype": str(df[column].dtype)})

        numeric = df.select_dtypes(include="number")
        if not numeric.empty:
            stats = numeric.describe().T.reset_index().rename(columns={"index": "column"})
            stats.insert(0, "dataset", name)
            write_dataframe(stats, table_dir / f"{name.lower().replace(' ', '_')}_descriptive_stats.csv")

    paths = {
        "dataset_summary": table_dir / "eda_dataset_summary.csv",
        "missing_values": table_dir / "eda_missing_values.csv",
        "column_dtypes": table_dir / "eda_column_dtypes.csv",
    }
    write_dataframe(pd.DataFrame(profiles), paths["dataset_summary"])
    write_dataframe(pd.DataFrame(missing_rows), paths["missing_values"])
    write_dataframe(pd.DataFrame(dtype_rows), paths["column_dtypes"])
    return paths


def save_final_dataset_artifacts(feature_df: pd.DataFrame, settings: Settings) -> dict[str, Path]:
    processed_dir = ensure_dir(settings.path("processed_data_dir"))
    metadata_dir = ensure_dir(settings.path("artifacts_dir") / "metadata")
    final_path = processed_dir / "final_merged_dataset.parquet"
    dictionary_path = processed_dir / "final_merged_dataset_dictionary.csv"
    summary_path = metadata_dir / "final_merged_dataset_summary.json"

    write_dataframe(feature_df, final_path)
    feature_groups = {
        "taxi_demand_features": [column for column in BASE_FEATURES if column in feature_df.columns],
        "taxi_zone_lookup_features": [column for column in ["borough", "service_zone", "zone_name", "zone_id"] if column in feature_df.columns],
        "weather_features": [column for column in WEATHER_FEATURES if column in feature_df.columns],
        "event_incident_features": [column for column in EVENT_FEATURES + ["event_mapping_quality"] if column in feature_df.columns],
        "lag_rolling_calendar_features": [column for column in LAG_FEATURES if column in feature_df.columns],
        "interaction_features": [column for column in INTERACTION_FEATURES if column in feature_df.columns],
        "target": [TARGET_COLUMN] if TARGET_COLUMN in feature_df.columns else [],
    }
    dictionary_rows = []
    for group_name, columns in feature_groups.items():
        for column in columns:
            dictionary_rows.append(
                {
                    "column": column,
                    "feature_group": group_name,
                    "dtype": str(feature_df[column].dtype),
                    "missing_count": int(feature_df[column].isna().sum()),
                }
            )
    write_dataframe(pd.DataFrame(dictionary_rows), dictionary_path)

    timestamps = pd.to_datetime(feature_df["timestamp"]) if "timestamp" in feature_df.columns and not feature_df.empty else pd.Series(dtype="datetime64[ns]")
    summary = {
        "rows": int(len(feature_df)),
        "columns": int(len(feature_df.columns)),
        "time_range_start": str(timestamps.min()) if not timestamps.empty else None,
        "time_range_end": str(timestamps.max()) if not timestamps.empty else None,
        "number_of_zones": int(feature_df["zone_id"].nunique()) if "zone_id" in feature_df.columns else 0,
        "target_column": TARGET_COLUMN,
        "feature_groups": feature_groups,
        "merge_summary": "Final model-ready zone-hour dataset combining aggregated TLC yellow taxi demand, TLC taxi-zone lookup fields, weather context, event/incident context, lag/rolling features, calendar variables, interactions, and the next-hour pickup-count target.",
    }
    write_json(summary, summary_path)
    return {"final_dataset": final_path, "data_dictionary": dictionary_path, "summary": summary_path}


def save_cleaning_audit_tables(audit: dict, settings: Settings) -> dict[str, Path]:
    table_dir = _table_dir(settings)
    row_counts = pd.DataFrame(
        [
            {"stage": "Before cleaning", "rows": int(audit.get("row_count_before_cleaning", audit.get("raw_rows", 0)))},
            {"stage": "After cleaning", "rows": int(audit.get("row_count_after_cleaning", audit.get("clean_rows", 0)))},
        ]
    )
    outlier_items = audit.get("outliers_by_reason", {})
    if not outlier_items and int(audit.get("outlier_rows_removed", 0)) > 0:
        outlier_items = {"combined_outlier_rows_from_existing_audit": int(audit.get("outlier_rows_removed", 0))}
    outliers = pd.DataFrame([{"reason": reason, "rows_removed": count} for reason, count in outlier_items.items()])
    paths = {
        "row_counts": table_dir / "cleaning_row_counts.csv",
        "outlier_counts": table_dir / "outlier_counts_by_reason.csv",
    }
    write_dataframe(row_counts, paths["row_counts"])
    write_dataframe(outliers, paths["outlier_counts"])
    return paths


def plot_data_understanding(feature_df: pd.DataFrame, settings: Settings) -> list[Path]:
    fig_dir = _figure_dir(settings)
    paths: list[Path] = []
    if feature_df.empty:
        return paths

    hourly = feature_df.groupby("hour", as_index=False)["pickup_count"].mean()
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.lineplot(data=hourly, x="hour", y="pickup_count", marker="o", ax=ax)
    ax.set_title("Data Understanding: Average Pickup Pattern by Hour")
    ax.set_xlabel("Hour of day")
    ax.set_ylabel("Average pickups")
    fig.tight_layout()
    path = fig_dir / "data_understanding_hourly_pickup_pattern.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)

    fig, ax = plt.subplots(figsize=(10, 5))
    sns.histplot(feature_df["pickup_count"], bins=40, ax=ax, color="#2a9d8f")
    ax.set_title("Data Understanding: Pickup Count Distribution")
    ax.set_xlabel("Hourly pickups per zone")
    fig.tight_layout()
    path = fig_dir / "data_understanding_pickup_distribution.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)

    top_zones = feature_df.groupby(["zone_id", "zone_name"], as_index=False)["pickup_count"].sum().nlargest(15, "pickup_count")
    fig, ax = plt.subplots(figsize=(10, 6))
    sns.barplot(data=top_zones, x="pickup_count", y="zone_name", ax=ax, color="#457b9d")
    ax.set_title("Data Understanding: Top Taxi Zones by Pickup Count")
    ax.set_xlabel("Total pickups")
    ax.set_ylabel("")
    fig.tight_layout()
    path = fig_dir / "data_understanding_top_zones_by_pickups.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)

    if "temperature" in feature_df.columns:
        fig, ax = plt.subplots(figsize=(10, 5))
        sns.histplot(feature_df["temperature"], bins=30, ax=ax, color="#f4a261")
        ax.set_title("Data Understanding: Weather Temperature Distribution")
        ax.set_xlabel("Temperature")
        fig.tight_layout()
        path = fig_dir / "data_understanding_weather_distribution.png"
        fig.savefig(path, dpi=300)
        plt.close(fig)
        paths.append(path)

    if "event_flag" in feature_df.columns:
        event_metric = "zone_incident_count" if "zone_incident_count" in feature_df.columns else "event_flag"
        event_hour = feature_df.groupby("hour", as_index=False)[event_metric].sum()
        fig, ax = plt.subplots(figsize=(10, 5))
        sns.barplot(data=event_hour, x="hour", y=event_metric, ax=ax, color="#6d597a")
        ax.set_title("Data Understanding: Event/Incident Frequency by Hour")
        ax.set_xlabel("Hour of day")
        ax.set_ylabel("Incident count" if event_metric == "zone_incident_count" else "Event rows")
        if float(event_hour[event_metric].sum()) == 0.0:
            ax.text(0.5, 0.5, "No mapped or citywide event records available", transform=ax.transAxes, ha="center", va="center")
        fig.tight_layout()
        path = fig_dir / "data_understanding_event_frequency_by_hour.png"
        fig.savefig(path, dpi=300)
        plt.close(fig)
        paths.append(path)
    return paths


def plot_data_cleaning(audit: dict, settings: Settings, clean_df: pd.DataFrame | None = None) -> list[Path]:
    fig_dir = _figure_dir(settings)
    paths: list[Path] = []
    row_counts = pd.DataFrame(
        [
            {"stage": "Before cleaning", "rows": int(audit.get("row_count_before_cleaning", audit.get("raw_rows", 0)))},
            {"stage": "After cleaning", "rows": int(audit.get("row_count_after_cleaning", audit.get("clean_rows", 0)))},
        ]
    )
    fig, ax = plt.subplots(figsize=(7, 5))
    sns.barplot(data=row_counts, x="stage", y="rows", ax=ax, palette=["#e76f51", "#2a9d8f"], hue="stage", legend=False)
    ax.set_title("Data Cleaning: Row Count Before and After")
    ax.set_xlabel("")
    fig.tight_layout()
    path = fig_dir / "data_cleaning_row_counts_before_after.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)

    outlier_items = audit.get("outliers_by_reason", {})
    if not outlier_items and int(audit.get("outlier_rows_removed", 0)) > 0:
        outlier_items = {"combined_outlier_rows_from_existing_audit": int(audit.get("outlier_rows_removed", 0))}
    outliers = pd.DataFrame([{"reason": reason, "rows_removed": count} for reason, count in outlier_items.items()])
    if not outliers.empty:
        fig, ax = plt.subplots(figsize=(10, 6))
        sns.barplot(data=outliers.sort_values("rows_removed"), x="rows_removed", y="reason", ax=ax, color="#b56576")
        ax.set_title("Data Cleaning: Outlier Counts by Reason")
        ax.set_xlabel("Rows removed")
        ax.set_ylabel("")
        fig.tight_layout()
        path = fig_dir / "data_cleaning_outlier_counts_by_reason.png"
        fig.savefig(path, dpi=300)
        plt.close(fig)
        paths.append(path)

    if clean_df is not None and not clean_df.empty:
        for column, filename, title in [
            ("trip_distance", "data_cleaning_cleaned_trip_distance_distribution.png", "Data Cleaning: Cleaned Trip Distance Distribution"),
            ("trip_duration_minutes", "data_cleaning_cleaned_trip_duration_distribution.png", "Data Cleaning: Cleaned Trip Duration Distribution"),
        ]:
            if column in clean_df.columns:
                fig, ax = plt.subplots(figsize=(10, 5))
                sns.histplot(clean_df[column], bins=40, ax=ax, color="#577590")
                ax.set_title(title)
                ax.set_xlabel(column)
                fig.tight_layout()
                path = fig_dir / filename
                fig.savefig(path, dpi=300)
                plt.close(fig)
                paths.append(path)
    return paths


def plot_weather_processing(raw_weather_df: pd.DataFrame | None, processed_weather_df: pd.DataFrame | None, settings: Settings) -> list[Path]:
    fig_dir = _figure_dir(settings)
    paths: list[Path] = []
    if raw_weather_df is not None and not raw_weather_df.empty:
        raw = raw_weather_df.copy()
        raw["timestamp"] = pd.to_datetime(raw["timestamp"], errors="coerce")
        numeric_cols = [column for column in ["temperature", "precipitation", "snowfall", "wind_speed", "humidity"] if column in raw.columns]
        if numeric_cols:
            missing = raw[numeric_cols].isna().sum().reset_index()
            missing.columns = ["column", "missing_before"]
            if processed_weather_df is not None and not processed_weather_df.empty:
                processed_missing = processed_weather_df[numeric_cols].isna().sum().reset_index()
                processed_missing.columns = ["column", "missing_after"]
                missing = missing.merge(processed_missing, on="column", how="left")
            write_dataframe(missing, _table_dir(settings) / "weather_missing_values_before_after.csv")
            fig, ax = plt.subplots(figsize=(10, 5))
            missing.set_index("column").plot(kind="bar", ax=ax)
            ax.set_title("Weather Missing Values Before and After Processing")
            ax.set_xlabel("")
            ax.set_ylabel("Missing values")
            fig.tight_layout()
            path = fig_dir / "weather_missing_values_before_after.png"
            fig.savefig(path, dpi=300)
            plt.close(fig)
            paths.append(path)

            fig, ax = plt.subplots(figsize=(12, 5))
            raw.set_index("timestamp")[numeric_cols[:3]].plot(ax=ax)
            ax.set_title("Weather Before Processing: Raw Hourly Series")
            ax.set_xlabel("Timestamp")
            fig.tight_layout()
            path = fig_dir / "weather_before_processing.png"
            fig.savefig(path, dpi=300)
            plt.close(fig)
            paths.append(path)

    if processed_weather_df is not None and not processed_weather_df.empty:
        processed = processed_weather_df.copy()
        processed["timestamp"] = pd.to_datetime(processed["timestamp"], errors="coerce")
        numeric_cols = [column for column in ["temperature", "precipitation", "snowfall", "wind_speed", "humidity"] if column in processed.columns]
        if numeric_cols:
            fig, ax = plt.subplots(figsize=(12, 5))
            processed.set_index("timestamp")[numeric_cols[:3]].plot(ax=ax)
            ax.set_title("Weather After Processing: Cleaned Hourly Series")
            ax.set_xlabel("Timestamp")
            fig.tight_layout()
            path = fig_dir / "weather_after_processing.png"
            fig.savefig(path, dpi=300)
            plt.close(fig)
            paths.append(path)

        if "weather_category" in processed.columns:
            availability = processed.assign(weather_available=1).groupby("weather_category", as_index=False)["weather_available"].sum()
            fig, ax = plt.subplots(figsize=(10, 5))
            sns.barplot(data=availability, x="weather_category", y="weather_available", ax=ax, color="#2a9d8f")
            ax.set_title("Weather After Processing: Processed Weather Availability")
            ax.set_xlabel("Weather category")
            ax.set_ylabel("Hourly records")
            ax.tick_params(axis="x", rotation=30)
            fig.tight_layout()
            path = fig_dir / "weather_processed_availability.png"
            fig.savefig(path, dpi=300)
            plt.close(fig)
            paths.append(path)
    return paths


def plot_event_integration(settings: Settings, event_df: pd.DataFrame | None, feature_df: pd.DataFrame | None) -> list[Path]:
    fig_dir = _figure_dir(settings)
    paths: list[Path] = []
    if event_df is None or event_df.empty:
        return paths

    events = event_df.copy()
    events["timestamp"] = pd.to_datetime(events["timestamp"], errors="coerce")
    events["hour"] = events["timestamp"].dt.hour
    for column in ["zone_incident_count", "citywide_incident_count", "event_intensity_score", "disruption_score"]:
        if column in events.columns:
            events[column] = pd.to_numeric(events[column], errors="coerce").fillna(0.0)

    hourly = events.groupby("hour", as_index=False)[["zone_incident_count", "citywide_incident_count"]].sum()
    fig, ax = plt.subplots(figsize=(10, 5))
    hourly.set_index("hour").plot(kind="bar", stacked=True, ax=ax, color=["#457b9d", "#e76f51"])
    ax.set_title("Event/Incident Frequency by Hour")
    ax.set_xlabel("Hour of day")
    ax.set_ylabel("Incident count")
    if float(hourly[["zone_incident_count", "citywide_incident_count"]].sum().sum()) == 0.0:
        ax.text(0.5, 0.5, "No event records were mapped or available for the selected period", transform=ax.transAxes, ha="center", va="center")
    fig.tight_layout()
    path = fig_dir / "event_incident_frequency_by_hour.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)

    zone_counts = events.groupby("zone_id", as_index=False)["zone_incident_count"].sum()
    zone_counts = zone_counts[zone_counts["zone_incident_count"] > 0].nlargest(20, "zone_incident_count")
    fig, ax = plt.subplots(figsize=(10, 6))
    if zone_counts.empty:
        ax.text(0.5, 0.5, "No zone-specific incident records were mapped", transform=ax.transAxes, ha="center", va="center")
        ax.set_axis_off()
    else:
        zone_counts["zone_id_label"] = zone_counts["zone_id"].astype(int).astype(str)
        sns.barplot(data=zone_counts, x="zone_incident_count", y="zone_id_label", ax=ax, color="#2a9d8f")
        ax.set_xlabel("Mapped incident count")
        ax.set_ylabel("Taxi zone ID")
    ax.set_title("Top Taxi Zones by Incident Count")
    fig.tight_layout()
    path = fig_dir / "event_top_zones_by_incident_count.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)

    timeline = events.groupby("timestamp", as_index=False)[["zone_incident_count", "citywide_incident_count"]].sum()
    fig, ax = plt.subplots(figsize=(12, 5))
    sns.lineplot(data=timeline, x="timestamp", y="zone_incident_count", ax=ax, label="Zone-specific incidents")
    sns.lineplot(data=timeline, x="timestamp", y="citywide_incident_count", ax=ax, label="Citywide fallback incidents")
    ax.set_title("Event/Incident Count Over Time")
    ax.set_xlabel("Timestamp")
    ax.set_ylabel("Incident count")
    ax.tick_params(axis="x", rotation=30)
    fig.tight_layout()
    path = fig_dir / "event_incident_count_over_time.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)

    summary_path = settings.path("artifacts_dir") / "metadata" / "event_integration_summary.json"
    if summary_path.exists():
        from src.utils.io import read_json

        summary = read_json(summary_path)
        mapping_counts = pd.DataFrame(
            [
                {"mapping_status": "Mapped to taxi zones", "records": int(summary.get("records_mapped_to_taxi_zones", 0))},
                {"mapping_status": "Citywide/unmapped fallback", "records": int(summary.get("records_not_mapped", 0))},
            ]
        )
        fig, ax = plt.subplots(figsize=(8, 5))
        sns.barplot(data=mapping_counts, x="mapping_status", y="records", ax=ax, palette=["#2a9d8f", "#e76f51"], hue="mapping_status", legend=False)
        ax.set_title("Mapped vs Unmapped Event Records")
        ax.set_xlabel("")
        ax.set_ylabel("Raw event records")
        ax.tick_params(axis="x", rotation=15)
        fig.tight_layout()
        path = fig_dir / "event_mapped_vs_unmapped_records.png"
        fig.savefig(path, dpi=300)
        plt.close(fig)
        paths.append(path)

    intensity = events[events["event_intensity_score"] > 0]
    fig, ax = plt.subplots(figsize=(10, 5))
    if intensity.empty:
        ax.text(0.5, 0.5, "No positive event intensity records available", transform=ax.transAxes, ha="center", va="center")
        ax.set_axis_off()
    else:
        sns.histplot(intensity["event_intensity_score"], bins=40, ax=ax, color="#6d597a")
        ax.set_xlabel("Event intensity score")
    ax.set_title("Event Intensity Distribution")
    fig.tight_layout()
    path = fig_dir / "event_intensity_distribution.png"
    fig.savefig(path, dpi=300)
    plt.close(fig)
    paths.append(path)
    return paths


def update_event_summary_with_final_dataset(settings: Settings, feature_df: pd.DataFrame) -> None:
    if feature_df.empty:
        return
    summary_path = settings.path("artifacts_dir") / "metadata" / "event_integration_summary.json"
    if summary_path.exists():
        from src.utils.io import read_json

        summary = read_json(summary_path)
    else:
        summary = {}
    if "event_flag" in feature_df.columns:
        summary["number_of_final_merged_rows"] = int(len(feature_df))
        summary["final_merged_rows_with_event_flag"] = int((feature_df["event_flag"] == 1).sum())
        summary["percentage_final_rows_event_flag_1"] = float((feature_df["event_flag"] == 1).mean() * 100)
    if "incident_flag" in feature_df.columns:
        summary["final_merged_rows_with_incident_flag"] = int((feature_df["incident_flag"] == 1).sum())
        summary["percentage_final_rows_incident_flag_1"] = float((feature_df["incident_flag"] == 1).mean() * 100)
    write_json(summary, summary_path)
    write_dataframe(pd.DataFrame([summary]), settings.path("reports_dir") / "tables" / "event_integration_summary.csv")


def generate_reporting_artifacts(settings: Settings) -> dict[str, object]:
    processed_dir = settings.path("processed_data_dir")
    external_dir = settings.path("external_data_dir")
    interim_dir = settings.path("interim_data_dir")
    datasets: dict[str, pd.DataFrame] = {}

    paths = {
        "Yellow Taxi Cleaned": interim_dir / "yellow_trip_cleaned.parquet",
        "Taxi Zone Lookup": external_dir / "taxi_zone_lookup.csv",
        "Weather Dataset": external_dir / "weather" / "weather_hourly.parquet",
        "Event Incident Dataset": external_dir / "events" / "event_features.parquet",
        "Final Merged Dataset": processed_dir / "zone_hour_features.parquet",
    }
    for name, path in paths.items():
        if path.exists():
            datasets[name] = read_dataframe(path)

    outputs: dict[str, object] = {"profiles": save_dataset_profiles(datasets, settings)}
    feature_df = datasets.get("Final Merged Dataset", pd.DataFrame())
    if not feature_df.empty:
        outputs["final_dataset"] = save_final_dataset_artifacts(feature_df, settings)
        update_event_summary_with_final_dataset(settings, feature_df)
        outputs["data_understanding_figures"] = [str(path) for path in plot_data_understanding(feature_df, settings)]

    event_df = datasets.get("Event Incident Dataset")
    outputs["event_figures"] = [str(path) for path in plot_event_integration(settings, event_df, feature_df)]

    audit_path = interim_dir / "data_audit.json"
    audit = {}
    if audit_path.exists():
        from src.utils.io import read_json

        audit = read_json(audit_path)
        outputs["cleaning_tables"] = save_cleaning_audit_tables(audit, settings)
        outputs["data_cleaning_figures"] = [
            str(path) for path in plot_data_cleaning(audit, settings, datasets.get("Yellow Taxi Cleaned"))
        ]

    raw_weather_candidates = sorted((external_dir / "weather").glob("weather_nyc_*.csv")) if (external_dir / "weather").exists() else []
    raw_weather = read_dataframe(raw_weather_candidates[-1]) if raw_weather_candidates else None
    processed_weather = datasets.get("Weather Dataset")
    outputs["weather_figures"] = [str(path) for path in plot_weather_processing(raw_weather, processed_weather, settings)]
    return outputs
