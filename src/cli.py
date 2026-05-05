from __future__ import annotations

import argparse
import pandas as pd

from src.config.settings import load_settings
from src.data.download import download_yellow_months, download_zone_geometry, download_zone_lookup
from src.data.preprocess import prepare_datasets
from src.data.reporting import generate_reporting_artifacts, save_final_dataset_artifacts
from src.features.engineering import build_feature_dataset, save_feature_dataset
from src.features.engineering import ALL_FEATURES
from src.models.forecasting import train_and_save_24h_forecaster
from src.models.training import save_training_outputs, train_model_comparison
from src.utils.io import load_model, read_dataframe, read_json, write_dataframe, write_json
from src.utils.logging_utils import get_logger
from src.utils.randomness import set_global_seed
from src.visualization.geospatial import build_heatmap_frame, load_zone_geometries, save_static_heatmap_figure
from src.visualization.plots import (
    plot_contextual_comparison,
    plot_contextual_feature_importance,
    plot_demand_vs_events,
    plot_demand_vs_weather,
    plot_feature_importance_from_pipeline,
    plot_forecast_example,
    plot_forecast_horizon_rmse,
    plot_hourly_demand,
    plot_model_comparison,
    plot_prediction_scatter,
    plot_zone_context_sensitivity,
    plot_zone_heatmap,
)


LOGGER = get_logger(__name__)


def print_model_performance_summary(metrics_df: pd.DataFrame, comparison_df: pd.DataFrame | None = None) -> None:
    summary = metrics_df.copy()
    display_columns = ["model_name", "test_mae", "test_rmse", "test_r2", "cv_rmse_mean", "cv_rmse_std"]
    available_columns = [column for column in display_columns if column in summary.columns]
    summary = summary[available_columns].copy()
    print("\nMODEL PERFORMANCE SUMMARY")
    print("-------------------------")
    print(f"{'Model':<20} {'MAE':>8} {'RMSE':>8} {'R2':>8}")
    for _, row in metrics_df.iterrows():
        mae = row.get("test_mae", float("nan"))
        rmse = row.get("test_rmse", float("nan"))
        r2 = row.get("test_r2", float("nan"))
        cv_mean = row.get("cv_rmse_mean", float("nan"))
        cv_std = row.get("cv_rmse_std", float("nan"))
        print(f"{row['model_name']:<20} {mae:>8.3f} {rmse:>8.3f} {r2:>8.3f}")
        print(f"{'':<20} validation RMSE {row.get('validation_rmse', float('nan')):>8.3f} | CV RMSE {cv_mean:>7.3f} +/- {cv_std:>6.3f}")
    best_model = metrics_df.sort_values(["cv_rmse_mean", "test_rmse"]).iloc[0]["model_name"]
    print(f"\nBest Model: {best_model}")
    if comparison_df is not None and not comparison_df.empty:
        improved = comparison_df[comparison_df["improved_with_context"]]
        print("\nCONTEXTUAL DATA IMPACT")
        print("----------------------")
        for _, row in comparison_df.sort_values("rmse_delta").iterrows():
            direction = "improved" if row["rmse_delta"] < 0 else "worsened"
            print(f"{row['model_name']:<20} RMSE delta {row['rmse_delta']:>8.3f} ({direction})")
        print(f"\nModels improved with context: {len(improved)}/{len(comparison_df)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NYC TLC yellow taxi demand-pressure forecasting pipeline")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest_parser = subparsers.add_parser("ingest", help="Download official TLC data")
    ingest_parser.add_argument("--start-month", default=None, help="Start month in YYYY-MM format")
    ingest_parser.add_argument("--end-month", default=None, help="End month in YYYY-MM format")

    subparsers.add_parser("prepare", help="Clean raw data and engineer model-ready features")
    subparsers.add_parser("train", help="Train tabular and sequence models")
    subparsers.add_parser("evaluate", help="Generate evaluation figures and summary metadata")
    return parser.parse_args()


def prepare_command(settings):
    outputs = prepare_datasets(settings)
    feature_df = build_feature_dataset(outputs["panel_df"], settings)
    save_feature_dataset(feature_df, settings)
    save_final_dataset_artifacts(feature_df, settings)
    generate_reporting_artifacts(settings)
    LOGGER.info("Prepared feature dataset with %s rows", len(feature_df))


def train_command(settings):
    set_global_seed(settings.random_state)
    feature_df = read_dataframe(settings.path("processed_data_dir") / "zone_hour_features.parquet")
    panel_df = read_dataframe(settings.path("processed_data_dir") / "zone_hour_aggregates.parquet")
    comparison_outputs = train_model_comparison(feature_df, settings)
    saved = save_training_outputs(comparison_outputs, settings)
    forecast_outputs = None
    try:
        forecast_outputs = train_and_save_24h_forecaster(panel_df, settings)
    except Exception as exc:  # pragma: no cover
        LOGGER.warning("24-hour forecast training skipped: %s", exc)
    summary = {
        "best_contextual_model": saved["best_model_name"],
        "best_tabular_model": saved["best_tabular_model"],
        "eight_model_comparison_complete": True,
        "forecast_24h_trained": forecast_outputs is not None,
        "best_forecast_model": forecast_outputs["best_forecast_model"] if forecast_outputs is not None else None,
    }
    write_json(summary, settings.path("artifacts_dir") / "metadata" / "run_summary.json")


def evaluate_command(settings):
    set_global_seed(settings.random_state)
    feature_df = read_dataframe(settings.path("processed_data_dir") / "zone_hour_features.parquet")
    generate_reporting_artifacts(settings)
    metrics_df = read_dataframe(settings.path("artifacts_dir") / "metrics" / "model_metrics.csv")
    contextual_comparison_df = read_dataframe(settings.path("artifacts_dir") / "metrics" / "contextual_comparison.csv")
    predictions_df = read_dataframe(settings.path("artifacts_dir") / "predictions" / "test_predictions.parquet")
    figures_dir = settings.path("reports_dir") / "figures"
    best_model_name = metrics_df.sort_values("cv_rmse_mean").iloc[0]["model_name"]
    plot_model_comparison(metrics_df, figures_dir)
    plot_contextual_comparison(contextual_comparison_df, figures_dir)
    plot_hourly_demand(feature_df, figures_dir)
    plot_demand_vs_weather(feature_df, figures_dir)
    plot_demand_vs_events(feature_df, figures_dir)
    plot_zone_heatmap(feature_df, figures_dir)
    plot_prediction_scatter(predictions_df, figures_dir, best_model_name)
    best_tree_candidates = ["XGBoost", "Random Forest", "Gradient Boosting"]
    for tree_model_name in best_tree_candidates:
        safe_name = tree_model_name.lower().replace(" ", "_")
        model_path = settings.path("artifacts_dir") / "models" / f"{safe_name}.joblib"
        if model_path.exists():
            plot_feature_importance_from_pipeline(model_path, figures_dir)
            plot_contextual_feature_importance(
                model_path,
                figures_dir,
                weather_features=["temperature", "precipitation", "snowfall", "wind_speed", "humidity", "rain_indicator", "heavy_rain_indicator", "snowfall_indicator"],
                event_features=["event_flag", "accident_flag", "road_closure_flag", "event_intensity_score", "disruption_score"],
            )
            break
    base_predictions_path = settings.path("artifacts_dir") / "predictions" / "test_predictions_base.parquet"
    if base_predictions_path.exists():
        base_predictions_df = read_dataframe(base_predictions_path)
        plot_zone_context_sensitivity(base_predictions_df, predictions_df, figures_dir)

    try:
        zone_gdf = load_zone_geometries(settings)
        best_model_manifest = read_json(settings.path("artifacts_dir") / "metadata" / "training_manifest.json")
        best_model_path = settings.path("artifacts_dir") / "models" / f"{best_model_manifest['best_tabular_model'].lower().replace(' ', '_')}.joblib"
        best_model = load_model(best_model_path)
        selected_timestamp = pd.to_datetime(feature_df["timestamp"]).sort_values().iloc[-2]
        snapshot = feature_df[pd.to_datetime(feature_df["timestamp"]) == selected_timestamp].sort_values("zone_id").reset_index(drop=True)
        predicted = pd.Series(best_model.predict(snapshot[ALL_FEATURES]), index=snapshot.index)
        heatmap_df = build_heatmap_frame(feature_df, selected_timestamp, predicted, min_denominator=float(settings.forecasting_model_cfg["baseline_min_denominator"]))
        save_static_heatmap_figure(heatmap_df, zone_gdf, figures_dir / "nyc_demand_heatmap.png", mode="Predicted next-hour demand")
    except Exception as exc:  # pragma: no cover
        LOGGER.warning("Static NYC heatmap figure skipped: %s", exc)

    forecast_horizon_path = settings.path("artifacts_dir") / "metrics" / "forecast_horizon_metrics.csv"
    forecast_predictions_path = settings.path("artifacts_dir") / "predictions" / "forecast_test_predictions.parquet"
    if forecast_horizon_path.exists() and forecast_predictions_path.exists():
        forecast_horizon_df = read_dataframe(forecast_horizon_path)
        forecast_predictions_df = read_dataframe(forecast_predictions_path)
        plot_forecast_horizon_rmse(forecast_horizon_df, figures_dir)
        forecast_metrics_df = read_dataframe(settings.path("artifacts_dir") / "metrics" / "forecast_metrics.csv")
        best_forecast_model = forecast_metrics_df[forecast_metrics_df["model_name"] != "Previous 24 Hours Naive"].sort_values("rmse").iloc[0]["model_name"]
        plot_forecast_example(forecast_predictions_df, figures_dir, best_forecast_model)
    print_model_performance_summary(metrics_df, contextual_comparison_df)
    LOGGER.info("Evaluation figures written to %s", figures_dir)


def main() -> None:
    settings = load_settings()
    args = parse_args()
    if args.command == "ingest":
        download_zone_lookup(settings)
        download_zone_geometry(settings)
        download_yellow_months(settings, args.start_month or settings.data_cfg["default_start_month"], args.end_month or settings.data_cfg["default_end_month"])
        return
    if args.command == "prepare":
        prepare_command(settings)
        return
    if args.command == "train":
        train_command(settings)
        return
    if args.command == "evaluate":
        evaluate_command(settings)
        return


if __name__ == "__main__":
    main()
