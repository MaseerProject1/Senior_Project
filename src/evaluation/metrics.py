from __future__ import annotations

import math

import numpy as np
from sklearn.metrics import mean_absolute_error, r2_score


def rmse(y_true, y_pred) -> float:
    errors = np.asarray(y_true) - np.asarray(y_pred)
    return float(math.sqrt(np.mean(errors ** 2)))


def smape(y_true, y_pred) -> float:
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    denominator = np.abs(y_true) + np.abs(y_pred)
    denominator = np.where(denominator == 0, 1.0, denominator)
    return float(100.0 * np.mean(2.0 * np.abs(y_pred - y_true) / denominator))


def regression_metrics(y_true, y_pred) -> dict[str, float]:
    return {
        "mae": float(mean_absolute_error(y_true, y_pred)),
        "rmse": rmse(y_true, y_pred),
        "r2": float(r2_score(y_true, y_pred)),
        "smape": smape(y_true, y_pred),
    }
