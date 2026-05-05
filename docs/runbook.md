# Runbook

From the repository root:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m src.cli ingest --start-month 2024-01 --end-month 2024-03
python -m src.cli prepare
python -m src.cli train
python -m src.cli evaluate
streamlit run src/app/dashboard.py
```

`python -m src.cli evaluate` prints the model performance summary in the terminal before the dashboard is launched, including MAE, RMSE, R², cross-validation mean and standard deviation, and the best model name.

Useful generated assets:

- `data/interim/data_audit.json`
- `data/processed/zone_hour_aggregates.parquet`
- `data/processed/zone_hour_features.parquet`
- `artifacts/metrics/model_metrics.csv`
- `artifacts/metrics/forecast_metrics.csv`
- `artifacts/metrics/forecast_horizon_metrics.csv`
- `artifacts/predictions/test_predictions.parquet`
- `artifacts/predictions/forecast_test_predictions.parquet`
- `reports/figures/*.png`
