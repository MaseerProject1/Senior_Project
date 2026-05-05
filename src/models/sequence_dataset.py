from __future__ import annotations

import numpy as np
import pandas as pd
import torch
from pandas.tseries.holiday import USFederalHolidayCalendar
from torch.utils.data import Dataset


FORECAST_INPUT_FEATURES = [
    "pickup_count",
    "hour_sin",
    "hour_cos",
    "day_of_week_sin",
    "day_of_week_cos",
    "is_weekend",
    "is_holiday",
]


class MultiHorizonDataset(Dataset):
    def __init__(self, inputs: np.ndarray, targets: np.ndarray):
        self.inputs = torch.tensor(inputs, dtype=torch.float32)
        self.targets = torch.tensor(targets, dtype=torch.float32)

    def __len__(self) -> int:
        return len(self.targets)

    def __getitem__(self, index: int):
        return self.inputs[index], self.targets[index]


def add_time_features(panel_df: pd.DataFrame) -> pd.DataFrame:
    enriched = panel_df.sort_values(["zone_id", "timestamp"]).copy()
    timestamps = pd.to_datetime(enriched["timestamp"])
    enriched["hour"] = timestamps.dt.hour
    enriched["day_of_week"] = timestamps.dt.dayofweek
    enriched["is_weekend"] = (enriched["day_of_week"] >= 5).astype(int)
    enriched["hour_sin"] = np.sin(2 * np.pi * enriched["hour"] / 24)
    enriched["hour_cos"] = np.cos(2 * np.pi * enriched["hour"] / 24)
    enriched["day_of_week_sin"] = np.sin(2 * np.pi * enriched["day_of_week"] / 7)
    enriched["day_of_week_cos"] = np.cos(2 * np.pi * enriched["day_of_week"] / 7)
    calendar = USFederalHolidayCalendar()
    holiday_set = calendar.holidays(start=timestamps.min().normalize(), end=timestamps.max().normalize())
    enriched["is_holiday"] = timestamps.dt.normalize().isin(holiday_set).astype(int)
    return enriched


def build_forecast_sequences(panel_df: pd.DataFrame, history_window: int, horizon: int) -> pd.DataFrame:
    enriched = add_time_features(panel_df)
    records: list[dict] = []
    for zone_id, zone_df in enriched.groupby("zone_id"):
        zone_df = zone_df.sort_values("timestamp").reset_index(drop=True)
        values = zone_df[FORECAST_INPUT_FEATURES].to_numpy(dtype=float)
        target_values = zone_df["pickup_count"].to_numpy(dtype=float)
        timestamps = pd.to_datetime(zone_df["timestamp"]).tolist()
        max_anchor = len(zone_df) - horizon
        for anchor_idx in range(history_window - 1, max_anchor):
            start_idx = anchor_idx - history_window + 1
            input_window = values[start_idx : anchor_idx + 1]
            target_window = target_values[anchor_idx + 1 : anchor_idx + 1 + horizon]
            benchmark_window = target_values[anchor_idx - horizon + 1 : anchor_idx + 1]
            if len(target_window) != horizon or len(benchmark_window) != horizon:
                continue
            records.append(
                {
                    "zone_id": int(zone_id),
                    "anchor_timestamp": timestamps[anchor_idx],
                    "target_start_timestamp": timestamps[anchor_idx + 1],
                    "input_window": input_window,
                    "target_window": target_window,
                    "benchmark_window": benchmark_window,
                }
            )
    return pd.DataFrame(records)


def split_forecast_sequences(sequence_df: pd.DataFrame, train_fraction: float, validation_fraction: float) -> dict[str, pd.DataFrame]:
    unique_times = pd.Series(sorted(pd.to_datetime(sequence_df["anchor_timestamp"]).unique()))
    n_times = len(unique_times)
    train_end = max(1, int(n_times * train_fraction))
    validation_end = max(train_end + 1, int(n_times * (train_fraction + validation_fraction)))
    train_times = set(unique_times.iloc[:train_end])
    validation_times = set(unique_times.iloc[train_end:validation_end])
    test_times = set(unique_times.iloc[validation_end:])
    return {
        "train": sequence_df[sequence_df["anchor_timestamp"].isin(train_times)].copy(),
        "validation": sequence_df[sequence_df["anchor_timestamp"].isin(validation_times)].copy(),
        "test": sequence_df[sequence_df["anchor_timestamp"].isin(test_times)].copy(),
    }


def downsample_sequence_frame(sequence_df: pd.DataFrame, max_sequences: int) -> pd.DataFrame:
    if max_sequences <= 0 or len(sequence_df) <= max_sequences:
        return sequence_df
    unique_times = pd.Series(sorted(pd.to_datetime(sequence_df["anchor_timestamp"]).unique()))
    zone_count = max(int(sequence_df["zone_id"].nunique()), 1)
    keep_count = max(2, int(max_sequences / zone_count))
    sampled_times = unique_times.iloc[np.linspace(0, len(unique_times) - 1, num=min(keep_count, len(unique_times)), dtype=int)]
    sampled = sequence_df[sequence_df["anchor_timestamp"].isin(set(sampled_times))].copy()
    return sampled.sort_values(["anchor_timestamp", "zone_id"]).reset_index(drop=True)


def stack_windows(frame: pd.DataFrame, column_name: str) -> np.ndarray:
    return np.stack(frame[column_name].to_list()).astype(np.float32)


def build_live_forecast_input(zone_history_df: pd.DataFrame, history_window: int) -> np.ndarray:
    enriched = add_time_features(zone_history_df)
    if len(enriched) < history_window:
        raise ValueError(f"At least {history_window} hourly observations are required to generate a forecast.")
    return enriched.sort_values("timestamp").tail(history_window)[FORECAST_INPUT_FEATURES].to_numpy(dtype=np.float32)


def naive_previous_horizon_forecast(zone_history_df: pd.DataFrame, horizon: int) -> pd.DataFrame:
    sorted_history = zone_history_df.sort_values("timestamp").copy()
    if len(sorted_history) < horizon:
        raise ValueError(f"At least {horizon} hourly observations are required to generate the naive forecast.")
    last_timestamp = pd.to_datetime(sorted_history["timestamp"]).max()
    prediction = sorted_history["pickup_count"].tail(horizon).to_numpy(dtype=float)
    forecast_timestamps = [last_timestamp + pd.Timedelta(hours=step) for step in range(1, horizon + 1)]
    return pd.DataFrame(
        {
            "forecast_timestamp": forecast_timestamps,
            "predicted_pickup_count": prediction,
            "horizon_step": np.arange(1, horizon + 1),
        }
    )
