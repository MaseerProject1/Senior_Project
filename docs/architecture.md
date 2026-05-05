# Architecture

The project is organized as a reproducible local ML system:

- `src/data/` downloads official TLC files, validates schema, cleans raw trips, aggregates them to zone-hour level, and optionally enriches the pipeline with weather and event context.
- `src/features/` converts the zone-hour panel into a supervised forecasting table with lags, rolling statistics, spatial metadata, calendar features, weather signals, event signals, and contextual interactions.
- `src/models/` trains the final eight-model comparison suite: Seasonal Naive, Ridge Regression, Random Forest, Gradient Boosting, XGBoost, LSTM, GRU, and Temporal CNN.
- `src/models/forecasting.py` plus `src/models/sequence_dataset.py`, `src/models/lstm_model.py`, `src/models/gru_model.py`, `src/models/temporal_cnn.py`, and `src/models/deep_training.py` implement a reusable deep temporal forecasting stack for 24-hour zone-level forecasting.
- `src/evaluation/` handles leakage-safe time splits and metrics.
- `src/visualization/` produces publication-ready figures and geospatial map support.
- `src/app/` exposes a Streamlit dashboard with single-zone forecast context, an NYC demand heatmap, and a next-24-hours forecast view.

The core modeling frame is a **next-hour zone-level pickup forecast**:

- Observation at time `t`: zone-hour features through hour `t`
- Target: pickup count in hour `t+1`
- Forecasting unit: `(zone_id, timestamp)`
- Evaluation: time-aware train, validation, and test split on ordered hourly timestamps plus rolling `TimeSeriesSplit` cross-validation for stable model comparison

This framing avoids the fabricated waiting-time label used in the earlier synthetic project while staying close to the operational question of demand-driven service pressure.
