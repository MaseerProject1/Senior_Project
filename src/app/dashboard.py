from __future__ import annotations

import sys
from pathlib import Path

# Ensure the project root is importable when running Streamlit from a subdirectory.
ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import pandas as pd
import streamlit as st

from src.app.components.forecast_view import render_next_24h_forecast_section
from src.app.components.heatmap import render_heatmap_section
from src.config.settings import load_settings
from src.features.engineering import ALL_FEATURES
from src.utils.io import load_model, read_dataframe, read_json
from src.visualization.geospatial import load_zone_geometries, safe_pressure_ratio


SETTINGS = load_settings()
ARTIFACTS_DIR = SETTINGS.path("artifacts_dir")
PROCESSED_DIR = SETTINGS.path("processed_data_dir")
FORECAST_CFG = SETTINGS.forecasting_model_cfg


@st.cache_data
def load_feature_frame() -> pd.DataFrame:
    return read_dataframe(PROCESSED_DIR / "zone_hour_features.parquet")


@st.cache_data
def load_panel_frame() -> pd.DataFrame:
    return read_dataframe(PROCESSED_DIR / "zone_hour_aggregates.parquet")


@st.cache_data
def load_metrics() -> pd.DataFrame:
    return read_dataframe(ARTIFACTS_DIR / "metrics" / "model_metrics.csv")


@st.cache_data
def load_forecast_metrics() -> pd.DataFrame:
    path = ARTIFACTS_DIR / "metrics" / "forecast_metrics.csv"
    if not path.exists():
        return pd.DataFrame()
    return read_dataframe(path)


@st.cache_data
def load_forecast_manifest() -> dict:
    path = ARTIFACTS_DIR / "metadata" / "forecast_manifest.json"
    if not path.exists():
        return {}
    return read_json(path)


@st.cache_data
def load_manifest() -> dict:
    path = ARTIFACTS_DIR / "metadata" / "training_manifest.json"
    if not path.exists():
        raise FileNotFoundError(
            "Training manifest is missing. Run `python -m src.cli prepare` and `python -m src.cli train` before opening the prediction dashboard."
        )
    return read_json(path)


@st.cache_data
def load_predictions() -> pd.DataFrame:
    return read_dataframe(ARTIFACTS_DIR / "predictions" / "test_predictions.parquet")


@st.cache_data
def load_contextual_comparison() -> pd.DataFrame:
    path = ARTIFACTS_DIR / "metrics" / "contextual_comparison.csv"
    if not path.exists():
        return pd.DataFrame()
    return read_dataframe(path)


@st.cache_resource
def load_best_model():
    manifest = load_manifest()
    safe_name = manifest["best_tabular_model"].lower().replace(" ", "_")
    return load_model(ARTIFACTS_DIR / "models" / f"{safe_name}.joblib")


@st.cache_resource
def load_zone_gdf():
    return load_zone_geometries(SETTINGS)


def format_pressure_ratio(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"{float(value):.2f}x"


def demand_pressure_label(ratio: float | None) -> str:
    if ratio is None or pd.isna(ratio):
        return "Baseline too low for a stable ratio"
    if ratio >= 1.35:
        return "High pressure"
    if ratio >= 1.0:
        return "Elevated pressure"
    if ratio >= 0.75:
        return "Typical pressure"
    return "Low pressure"


def _display_existing_figure(path: Path, caption: str) -> None:
    if path.exists():
        st.image(str(path), caption=caption, use_container_width=True)


def render_dataset_information_page() -> None:
    st.title("New York Dataset Information")
    st.caption("New York is the only active dataset in this implementation. The system uses official NYC TLC yellow taxi records, TLC taxi-zone metadata, weather data, and event/incident context.")

    st.subheader("Dataset Sources")
    st.markdown(
        """
        - **Yellow Trip Data:** Official NYC Taxi and Limousine Commission (TLC) trip records. The raw records include pickup/dropoff datetimes, pickup/dropoff location IDs, passenger count, trip distance, fare amount, total amount, and other trip-level fields.
        - **Taxi Zone Lookup:** Official TLC lookup table that maps `LocationID` values to borough, zone name, and service zone/category.
        - **Weather Data:** Hourly New York City weather context retrieved from Open-Meteo and normalized to the project hourly timeline.
        - **Event/Incident Data:** Local event windows, road closures, and NYC collision/incident records are converted into hourly event indicators and intensity features.
        """
    )

    st.subheader("Taxi Zone Lookup Fields")
    st.markdown(
        """
        - **Borough / Boro:** The NYC borough where the taxi zone is located, such as Manhattan, Brooklyn, Queens, Bronx, Staten Island, or EWR.
        - **Zone:** The official TLC taxi zone name used to describe the pickup/dropoff area.
        - **service_zone:** The TLC service area/category for the zone. Values such as `Yellow Zone` and `Boro Zone` classify how TLC groups taxi service areas; `Yellow Zone` is not a separate dataset.
        """
    )

    st.subheader("Modeling Dataset")
    st.write(
        "The project aggregates raw trip-level Yellow Trip Data into hourly taxi-zone records. These records are merged with taxi-zone lookup fields, hourly weather features, event/incident features, calendar features, lag/rolling demand features, and the target variable."
    )
    st.write("Target variable: `target_pickup_count_next_hour`, the next-hour yellow taxi pickup count for each TLC taxi zone.")

    summary_path = ARTIFACTS_DIR / "metadata" / "final_merged_dataset_summary.json"
    dictionary_path = PROCESSED_DIR / "final_merged_dataset_dictionary.csv"
    if summary_path.exists():
        summary = read_json(summary_path)
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Rows", f"{summary.get('rows', 0):,}")
        c2.metric("Columns", f"{summary.get('columns', 0):,}")
        c3.metric("Zones", f"{summary.get('number_of_zones', 0):,}")
        c4.metric("Target", summary.get("target_column", "N/A"))
        st.write(f"Time range: {summary.get('time_range_start')} to {summary.get('time_range_end')}")
    else:
        st.info("Final merged dataset summary is not available yet. Run `python -m src.cli prepare` or `python -m src.cli evaluate` to generate it.")

    if dictionary_path.exists():
        st.subheader("Selected Columns Used in the Final Modeling Dataset")
        st.dataframe(read_dataframe(dictionary_path), use_container_width=True)

    table_dir = SETTINGS.path("reports_dir") / "tables"
    dataset_summary = table_dir / "eda_dataset_summary.csv"
    missing_values = table_dir / "eda_missing_values.csv"
    if dataset_summary.exists():
        st.subheader("Comparison-Ready Dataset Summary")
        st.dataframe(read_dataframe(dataset_summary), use_container_width=True)
    if missing_values.exists():
        st.subheader("Missing Values Summary")
        st.dataframe(read_dataframe(missing_values).head(300), use_container_width=True)

    st.subheader("Event/Incident Data Integration")
    st.write(
        "NYC collision/incident records are mapped to TLC taxi zones using latitude/longitude coordinates and the official TLC taxi-zone polygons. Records without usable coordinates, or records that do not fall inside a taxi-zone polygon, are aggregated by hour as citywide fallback incident signals and merged to every active zone for the same timestamp."
    )
    event_summary_table = table_dir / "event_integration_summary.csv"
    if event_summary_table.exists():
        st.dataframe(read_dataframe(event_summary_table), use_container_width=True)
    else:
        st.info("Event integration summary is not available yet. Run `python -m src.cli prepare` or `python -m src.cli evaluate`.")

    st.subheader("Data Understanding Figures")
    fig_dir = SETTINGS.path("reports_dir") / "figures"
    figure_grid = st.columns(2)
    figures = [
        ("data_understanding_hourly_pickup_pattern.png", "Average hourly pickup pattern"),
        ("data_understanding_pickup_distribution.png", "Pickup distribution"),
        ("data_understanding_top_zones_by_pickups.png", "Top zones by pickup count"),
        ("data_understanding_weather_distribution.png", "Weather distribution"),
        ("event_incident_frequency_by_hour.png", "Event/incident frequency by hour"),
        ("event_top_zones_by_incident_count.png", "Top taxi zones by incident count"),
        ("event_incident_count_over_time.png", "Event/incident count over time"),
        ("event_mapped_vs_unmapped_records.png", "Mapped vs unmapped event records"),
        ("event_intensity_distribution.png", "Event intensity distribution"),
        ("zone_hour_heatmap.png", "Zone-hour demand heatmap"),
    ]
    for idx, (filename, caption) in enumerate(figures):
        with figure_grid[idx % 2]:
            _display_existing_figure(fig_dir / filename, caption)

    st.subheader("Data Cleaning and Weather Processing Figures")
    weather_missing_table = table_dir / "weather_missing_values_before_after.csv"
    if weather_missing_table.exists():
        weather_missing_df = read_dataframe(weather_missing_table)
        st.dataframe(weather_missing_df, use_container_width=True)
        missing_cols = [column for column in ["missing_before", "missing_after"] if column in weather_missing_df.columns]
        if missing_cols and float(weather_missing_df[missing_cols].fillna(0).sum().sum()) == 0.0:
            st.success("No missing values were detected in the selected weather variables before or after preprocessing.")
    cleaning_grid = st.columns(2)
    cleaning_figures = [
        ("data_cleaning_row_counts_before_after.png", "Before/after row counts"),
        ("data_cleaning_outlier_counts_by_reason.png", "Outlier counts by reason"),
        ("data_cleaning_cleaned_trip_distance_distribution.png", "Cleaned trip distance"),
        ("data_cleaning_cleaned_trip_duration_distribution.png", "Cleaned trip duration"),
        ("weather_before_processing.png", "Weather before preprocessing"),
        ("weather_after_processing.png", "Weather after preprocessing"),
        ("weather_missing_values_before_after.png", "Weather missing values before/after"),
        ("weather_processed_availability.png", "Processed weather availability"),
    ]
    for idx, (filename, caption) in enumerate(cleaning_figures):
        with cleaning_grid[idx % 2]:
            _display_existing_figure(fig_dir / filename, caption)


def render_prediction_dashboard() -> None:
    st.title("NYC Taxi Demand Pressure Dashboard")
    st.caption("The project predicts demand-pressure proxies from official NYC TLC yellow taxi data. The system does not claim that TLC publishes a direct passenger wait-time label.")

    try:
        manifest = load_manifest()
        feature_df = load_feature_frame()
        panel_df = load_panel_frame()
        metrics_df = load_metrics()
        forecast_metrics_df = load_forecast_metrics()
        forecast_manifest = load_forecast_manifest()
        predictions_df = load_predictions()
        contextual_comparison_df = load_contextual_comparison()
        best_model = load_best_model()
    except FileNotFoundError as exc:
        st.error(str(exc))
        st.code("python -m src.cli prepare\npython -m src.cli train\npython -m src.cli evaluate", language="powershell")
        return
    try:
        zone_gdf = load_zone_gdf()
    except FileNotFoundError:
        st.error("Taxi-zone geometry is missing. Run `python -m src.cli ingest` again to download the official TLC zone shapefile.")
        return

    sidebar = st.sidebar
    sidebar.header("Controls")
    zone_options = panel_df[["zone_id", "zone_name", "borough"]].drop_duplicates().sort_values(["borough", "zone_name"])
    zone_labels = zone_options.apply(lambda row: f"{int(row['zone_id'])} | {row['zone_name']} | {row['borough']}", axis=1).tolist()
    selected_label = sidebar.selectbox("Taxi zone", zone_labels, index=0)
    selected_zone_id = int(selected_label.split("|")[0].strip())
    zone_panel_df = panel_df[panel_df["zone_id"] == selected_zone_id].sort_values("timestamp")
    zone_feature_df = feature_df[feature_df["zone_id"] == selected_zone_id].sort_values("timestamp")
    timestamp_options = zone_panel_df["timestamp"].astype(str).tolist()
    selected_timestamp = pd.Timestamp(sidebar.selectbox("Reference timestamp", timestamp_options, index=max(0, len(timestamp_options) - 25)))

    selected_feature_row = (
        feature_df[(feature_df["zone_id"] == selected_zone_id) & (pd.to_datetime(feature_df["timestamp"]) == selected_timestamp)]
        .sort_values("timestamp")
        .tail(1)
    )
    if selected_feature_row.empty:
        st.error("The selected timestamp does not have a model-ready feature row. Choose a later timestamp.")
        return
    selected_feature_row = selected_feature_row.iloc[0]
    model_input = pd.DataFrame([selected_feature_row[ALL_FEATURES]])
    predicted_pickups = float(best_model.predict(model_input)[0])
    pressure_ratio = safe_pressure_ratio(
        predicted=pd.Series([predicted_pickups]),
        baseline=pd.Series([selected_feature_row["pickup_count_roll_mean_24"]]),
        min_denominator=float(FORECAST_CFG["baseline_min_denominator"]),
    ).iloc[0]

    top_left, top_right = st.columns([1, 1])
    with top_left:
        st.subheader("Current Zone Forecast")
        st.metric("Best next-hour model", manifest["best_tabular_model"])
        st.metric("Predicted next-hour pickups", f"{predicted_pickups:.2f}")
        st.metric("Pressure ratio vs 24h baseline", format_pressure_ratio(pressure_ratio))
        st.write(demand_pressure_label(pressure_ratio))
        if pd.isna(pressure_ratio):
            st.caption("The 24-hour rolling baseline is too close to zero for a stable ratio, so the app displays `N/A` instead of an inflated value.")
    with top_right:
        st.subheader("Context")
        st.write(f"Zone: {selected_feature_row['zone_name']} ({selected_feature_row['borough']})")
        st.write(f"Observed pickups in selected hour: {float(selected_feature_row['pickup_count']):.0f}")
        st.write(f"24h rolling mean: {float(selected_feature_row['pickup_count_roll_mean_24']):.2f}")
        st.write(f"Observed next-hour pickups in dataset: {float(selected_feature_row['target_pickup_count_next_hour']):.2f}")
        st.write(f"Temperature: {float(selected_feature_row.get('temperature', 0.0)):.1f}")
        st.write(f"Precipitation: {float(selected_feature_row.get('precipitation', 0.0)):.2f}")
        st.write(f"Event intensity score: {float(selected_feature_row.get('event_intensity_score', 0.0)):.2f}")
        st.write(f"Disruption score: {float(selected_feature_row.get('disruption_score', 0.0)):.2f}")

    st.subheader("Recent Zone History")
    recent_history = zone_panel_df[pd.to_datetime(zone_panel_df["timestamp"]) <= selected_timestamp].tail(72).copy()
    st.line_chart(recent_history.set_index("timestamp")[["pickup_count"]])

    weather_panel, event_panel = st.columns(2)
    with weather_panel:
        st.subheader("Weather Impact Panel")
        weather_cols = [column for column in ["temperature", "precipitation", "snowfall", "wind_speed", "humidity"] if column in zone_feature_df.columns]
        if weather_cols:
            st.line_chart(zone_feature_df.tail(72).set_index("timestamp")[weather_cols])
        st.caption(f"Weather category: {selected_feature_row.get('weather_category', 'unknown')}")
    with event_panel:
        st.subheader("Event Impact Panel")
        event_cols = [
            column
            for column in ["zone_incident_count", "citywide_incident_count", "event_intensity_score", "disruption_score", "incident_flag", "road_closure_flag"]
            if column in zone_feature_df.columns
        ]
        if event_cols:
            st.line_chart(zone_feature_df.tail(72).set_index("timestamp")[event_cols])
        st.caption(
            f"Event active: {int(selected_feature_row.get('event_active', 0))} | "
            f"Incident flag: {int(selected_feature_row.get('incident_flag', 0))} | "
            f"Mapping quality: {selected_feature_row.get('event_mapping_quality', 'none')}"
        )

    st.subheader("Demand vs Weather")
    weather_chart = zone_feature_df.tail(168).set_index("timestamp")[["pickup_count", "temperature", "precipitation"]]
    st.line_chart(weather_chart)

    st.subheader("Demand vs Event Timeline")
    event_chart_cols = [column for column in ["pickup_count", "zone_incident_count", "citywide_incident_count", "event_intensity_score", "disruption_score"] if column in zone_feature_df.columns]
    event_chart = zone_feature_df.tail(168).set_index("timestamp")[event_chart_cols]
    st.line_chart(event_chart)

    render_heatmap_section(
        feature_df=feature_df,
        zone_gdf=zone_gdf,
        model=best_model,
        min_denominator=float(FORECAST_CFG["baseline_min_denominator"]),
    )

    render_next_24h_forecast_section(
        panel_df=panel_df,
        artifacts_dir=ARTIFACTS_DIR,
        selected_zone_id=selected_zone_id,
        selected_timestamp=selected_timestamp,
    )

    st.subheader("Model Comparison")
    st.dataframe(metrics_df, use_container_width=True)
    if not contextual_comparison_df.empty:
        st.subheader("Before vs After Contextual Data")
        st.dataframe(contextual_comparison_df, use_container_width=True)
    if not forecast_metrics_df.empty:
        st.subheader("24-Hour Forecast Comparison")
        if forecast_manifest.get("best_forecast_model"):
            st.caption(f"Best deep temporal forecaster: {forecast_manifest['best_forecast_model']}")
        st.dataframe(forecast_metrics_df, use_container_width=True)

    st.subheader("Saved Next-Hour Test Predictions")
    st.dataframe(predictions_df.head(200), use_container_width=True)


def main() -> None:
    st.set_page_config(page_title="NYC Taxi Demand Pressure Dashboard", layout="wide")
    page = st.sidebar.radio("Page", ["Forecast Dashboard", "New York Dataset Information"])
    if page == "New York Dataset Information":
        render_dataset_information_page()
        return
    render_prediction_dashboard()


if __name__ == "__main__":
    main()
