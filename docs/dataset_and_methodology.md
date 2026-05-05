# Dataset And Methodology

## Core dataset

The core repository still uses official NYC TLC yellow taxi trip records aggregated to an hourly taxi-zone panel. The canonical model-ready table is:

- `data/processed/zone_hour_features.parquet`

Each row represents one taxi zone at one hourly timestamp after cleaning, zone lookup enrichment, panel completion, lag creation, and optional contextual joins.

## Waiting-time proxy

Direct passenger waiting time is not published in the TLC yellow taxi trip data. Because of that, the project does not claim to predict an observed wait-time label.

The supervised target is:

- `target_pickup_count_next_hour`

Definition:

- next-hour observed pickup count for the same taxi zone

Why this proxy is used:

- next-hour pickup concentration is a practical pressure signal
- higher short-term pickup demand is consistent with periods where waiting pressure may rise
- the dashboard pressure ratio normalizes predicted next-hour pickups by the prior 24-hour average to avoid comparing raw counts across very different zones

Operational ratio used in the dashboard:

- `PredictedNextHourPickups / Rolling24HourAveragePickups`

This remains a demand-pressure proxy, not a direct wait-time observation.

## Contextual data integration

The feature table now supports optional exogenous context:

- weather joined on hourly `timestamp`
- events and incidents joined on hourly `timestamp` and `zone_id` when zone mapping is available

Weather can influence the waiting-pressure proxy through reduced mobility comfort, storm-driven mode shifts, and congestion effects. Events and incidents can influence the same proxy by creating localized demand spikes or reducing roadway throughput.

## Model-comparison design

The final academic comparison is restricted to exactly these eight models:

1. Seasonal Naive
2. Ridge Regression
3. Random Forest
4. Gradient Boosting
5. XGBoost
6. LSTM
7. GRU
8. Temporal CNN

All eight models are trained from the same underlying feature-table version and the same target definition. Sequence models use rolling windows derived from the same feature table rather than a separate dataset.

## Validation policy

The repository uses time-series-safe evaluation only:

- chronological train/validation/test split
- `TimeSeriesSplit` cross-validation on the combined train and validation period
- no random shuffling
- no future leakage into earlier folds

Reported metrics:

- MAE
- RMSE
- R²

Fold mean and fold standard deviation are saved for comparable models.

## Contextual ablation

The repository saves two directly comparable experiment sets:

- base feature set without contextual weather/event features
- contextual feature set with weather, event, and interaction features

This allows before/after measurement of whether contextual data improved predictive performance for each of the eight models.
