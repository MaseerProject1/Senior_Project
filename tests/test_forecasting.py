from __future__ import annotations

import pandas as pd
import torch

from src.models.forecasting import build_forecast_sequences
from src.models.baselines import SeasonalNaiveRegressor
from src.models.gru_model import GRUForecaster
from src.models.lstm_model import LSTMForecaster
from src.models.temporal_cnn import TemporalCNNForecaster
from src.visualization.geospatial import safe_pressure_ratio


def build_panel() -> pd.DataFrame:
    timestamps = pd.date_range("2024-01-01 00:00:00", periods=100, freq="1h")
    rows = []
    for zone_id in [1, 2]:
        for idx, ts in enumerate(timestamps):
            rows.append(
                {
                    "timestamp": ts,
                    "zone_id": zone_id,
                    "pickup_count": (idx % 24) + zone_id,
                    "borough": "Manhattan",
                    "zone_name": f"Zone {zone_id}",
                    "service_zone": "Yellow Zone",
                }
            )
    return pd.DataFrame(rows)


def test_build_forecast_sequences_generates_multistep_targets():
    sequence_df = build_forecast_sequences(build_panel(), history_window=48, horizon=24)
    assert not sequence_df.empty
    sample = sequence_df.iloc[0]
    assert len(sample["input_window"]) == 48
    assert len(sample["target_window"]) == 24
    assert len(sample["benchmark_window"]) == 24


def test_safe_pressure_ratio_returns_nan_for_low_baseline():
    ratios = safe_pressure_ratio(predicted=[10.0, 5.0], baseline=[0.2, 2.0], min_denominator=1.0)
    assert pd.isna(ratios.iloc[0])
    assert ratios.iloc[1] == 2.5


def test_deep_models_forward_pass_shapes():
    batch = torch.randn(4, 48, 7)
    horizon = 24
    lstm = LSTMForecaster(input_size=7, hidden_size=16, num_layers=1, dropout=0.1, horizon=horizon)
    gru = GRUForecaster(input_size=7, hidden_size=16, num_layers=1, dropout=0.1, horizon=horizon)
    tcn = TemporalCNNForecaster(input_size=7, channels=16, kernel_size=3, horizon=horizon, dropout=0.1)
    assert lstm(batch).shape == (4, horizon)
    assert gru(batch).shape == (4, horizon)
    assert tcn(batch).shape == (4, horizon)


def test_seasonal_naive_uses_lag_feature():
    model = SeasonalNaiveRegressor()
    frame = pd.DataFrame({"pickup_count_lag_24": [3.0, 7.5], "pickup_count_lag_168": [1.0, 1.0]})
    model.fit(frame, pd.Series([2.0, 4.0]))
    predictions = model.predict(frame)
    assert predictions.tolist() == [3.0, 7.5]
