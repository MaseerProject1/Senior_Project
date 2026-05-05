# Next 24 Hours Forecasting

The repository now includes a deep temporal forecasting stack for zone-level hourly demand.

## Forecast target

- Forecast horizon: 24 hours
- Unit: hourly yellow-taxi pickup count
- Spatial unit: TLC taxi zone

## Models

- `LSTM 24H Forecaster`
- `GRU 24H Forecaster`
- `Temporal CNN 24H Forecaster`

Why they were added:

- LSTM captures longer-range temporal dependence through gated recurrent memory.
- GRU offers a lighter gated recurrent alternative that can train faster with fewer parameters.
- Temporal CNN provides a convolutional sequence model that can detect local temporal patterns without recurrence.

All three are trained as direct multi-output forecasters rather than recursive one-step rollouts.

## Validation strategy

The project uses rolling time-series cross-validation through `TimeSeriesSplit` for model comparison. Fold-wise next-hour metrics are summarized as mean and standard deviation and written into the main comparison table.

This is implemented in:

- `src/models/training.py` for tabular models
- `src/models/deep_training.py` for LSTM, GRU, and Temporal CNN

## Inputs

Each sequence uses the previous 48 hourly observations for a zone with:

- pickup count
- cyclical hour-of-day features
- cyclical day-of-week features
- weekend indicator
- holiday indicator

## Benchmark

The baseline benchmark copies the previous 24 observed hourly pickup counts forward by one day. This is a strong seasonal naive benchmark for hourly urban demand.

## Relation To Existing Models

The project now evaluates the deep temporal models in two ways:

- full 24-hour forecasting metrics in `forecast_metrics.csv`
- first-step next-hour metrics included in the same eight-model comparison framework used by Seasonal Naive, Ridge Regression, Random Forest, Gradient Boosting, and XGBoost

## Artifacts

- `artifacts/models/lstm_24h_forecaster.pt`
- `artifacts/models/gru_24h_forecaster.pt`
- `artifacts/models/temporal_cnn_24h_forecaster.pt`
- `artifacts/metrics/forecast_metrics.csv`
- `artifacts/metrics/forecast_horizon_metrics.csv`
- `artifacts/predictions/forecast_test_predictions.parquet`

## Limitations

- The LSTM is global across zones and relies on history rather than explicit zone embeddings.
- The separate 24-hour forecaster remains more limited than the main contextual next-hour comparison and may not consume the full contextual feature set used in the eight-model study.
- Forecast quality for very sparse zones can remain limited despite the guarded baseline logic in the dashboard.
