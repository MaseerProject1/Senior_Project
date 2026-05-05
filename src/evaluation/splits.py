from __future__ import annotations

import pandas as pd


def time_based_split(df: pd.DataFrame, timestamp_col: str, train_fraction: float, validation_fraction: float) -> dict[str, pd.DataFrame]:
    unique_times = pd.Series(sorted(pd.to_datetime(df[timestamp_col]).unique()))
    n_times = len(unique_times)
    train_end = max(1, int(n_times * train_fraction))
    validation_end = max(train_end + 1, int(n_times * (train_fraction + validation_fraction)))

    train_times = set(unique_times.iloc[:train_end])
    validation_times = set(unique_times.iloc[train_end:validation_end])
    test_times = set(unique_times.iloc[validation_end:])

    return {
        "train": df[df[timestamp_col].isin(train_times)].copy(),
        "validation": df[df[timestamp_col].isin(validation_times)].copy(),
        "test": df[df[timestamp_col].isin(test_times)].copy(),
    }
