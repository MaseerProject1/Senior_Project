# NYC Taxi Demand Pressure Forecasting Capstone

This repository uses real, documented NYC Taxi and Limousine Commission (TLC) yellow taxi trip records plus official TLC taxi zone metadata. New York is the only active dataset for the practical system.

The system predicts **next-hour pickup demand by taxi zone**. This is the project's operational proxy for ride-hailing or taxi waiting pressure.

Why this target is defensible:

- TLC yellow taxi data does **not** contain a direct passenger wait-time label.
- Pickup demand intensity is directly observable from official trip records.
- Higher short-term zone-level pickup demand generally implies greater service pressure and a higher likelihood of longer effective waiting or pickup search time, especially when supply is not directly observed.
- The repository never claims that NYC TLC publishes a true wait-time field.

## Official data sources

- TLC Trip Record Data portal: https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page
- Yellow Taxi data dictionary: https://home4.nyc.gov/assets/tlc/downloads/pdf/data_dictionary_trip_records_yellow.pdf
- Taxi zone lookup table: https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv
- Taxi zone geometry: https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip

## Reproducible local workflow

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# من هتل تبد   تشغلي  الاوامر ا
.venv\Scripts\Activate.ps1
python -m src.cli ingest --start-month 2024-01 --end-month 2024-03
python -m src.cli prepare
python -m src.cli train
python -m src.cli evaluate
streamlit run src/app/dashboard.py
```

## Repository layout

- `data/raw/` downloaded monthly TLC parquet files
- `data/external/` official metadata such as the taxi zone lookup
- `data/external/taxi_zones.zip` official TLC taxi-zone geometry used for the NYC heatmap
- `data/interim/` cleaned trip-level data and audit summaries
- `data/processed/` zone-hour aggregates and model-ready features
- `src/` modular package for config, data, features, models, evaluation, visualisation, and app code
- `tests/` lightweight unit tests
- `docs/` architecture, methodology, and runbook
- `reports/` generated tables and figures
- `artifacts/` trained models, metrics, predictions, and metadata

## Notes

- Final target: `target_pickup_count_next_hour`
- Unit: number of yellow-taxi pickups in the next hourly window for a TLC taxi zone
- The dashboard also derives a demand pressure score relative to the recent 24-hour baseline
- The dashboard now includes an interactive NYC zone heatmap and a next-24-hours deep forecast view with LSTM, GRU, and Temporal CNN options
- The final academic comparison includes Seasonal Naive, Ridge Regression, Random Forest, Gradient Boosting, XGBoost, LSTM, GRU, and Temporal CNN
- New York TLC Yellow Trip Data is the only active taxi dataset used by the code, dashboard, and model artifacts
- Training metadata is saved under `artifacts/metadata/training_manifest.json` during training and loaded by the dashboard instead of being regenerated at app startup

## Demand Pressure Formula

The dashboard pressure indicator uses:

```text
DemandPressureRatio = PredictedNextHourPickups / Rolling24HourAveragePickups
```

with a guarded denominator threshold to avoid misleading ratios in very low-demand zones.

This is a proxy measure because the TLC yellow taxi dataset does not contain a direct passenger waiting-time field.
