from __future__ import annotations

import numpy as np
from sklearn.base import BaseEstimator, RegressorMixin


class SeasonalNaiveRegressor(BaseEstimator, RegressorMixin):
    def __init__(self, preferred_lag: str = "pickup_count_lag_24", fallback_lag: str = "pickup_count_lag_168"):
        self.preferred_lag = preferred_lag
        self.fallback_lag = fallback_lag

    def fit(self, X, y=None):
        self.global_mean_ = float(np.mean(y)) if y is not None else 0.0
        return self

    def predict(self, X):
        if self.preferred_lag in X:
            predictions = X[self.preferred_lag].to_numpy(dtype=float)
        elif self.fallback_lag in X:
            predictions = X[self.fallback_lag].to_numpy(dtype=float)
        else:
            predictions = np.full(len(X), self.global_mean_, dtype=float)
        predictions = np.where(np.isnan(predictions), self.global_mean_, predictions)
        return np.maximum(predictions, 0.0)
