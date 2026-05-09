"""Helpers shared across the MASEER FastAPI service layer.

These utilities focus on safely converting heterogeneous pandas / numpy values
into JSON-friendly primitives, computing the project's pressure-ratio proxy,
and locating data files across multiple candidate paths.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Numeric / dataframe helpers
# ---------------------------------------------------------------------------


def safe_number(value: Any) -> float | int | None:
    """Coerce arbitrary scalar values into a JSON-friendly primitive.

    The function returns:
        - ``None`` for ``NaN``, ``None`` and non-finite values
        - ``int`` for integer-typed values (including numpy integers)
        - ``float`` for finite floats
        - ISO string for ``pd.Timestamp``
        - the original value as last resort
    """

    if value is None:
        return None
    if isinstance(value, (np.integer, int)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, (np.floating, float)):
        candidate = float(value)
        if not math.isfinite(candidate):
            return None
        return candidate
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


def safe_ratio(numerator: Any, denominator: Any) -> float | None:
    """Compute ``numerator / denominator`` returning ``None`` when invalid.

    The denominator must be strictly positive and finite for a ratio to be
    returned.  Otherwise ``None`` flows downstream as the *Unavailable*
    pressure label.
    """

    n = safe_number(numerator)
    d = safe_number(denominator)
    if n is None or d is None:
        return None
    try:
        n_f = float(n)
        d_f = float(d)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n_f) or not math.isfinite(d_f) or d_f <= 0:
        return None
    out = n_f / d_f
    if not math.isfinite(out):
        return None
    return out


def compute_pressure_ratio(predicted: Any, baseline_24h: Any) -> float | None:
    """Demand-pressure proxy used by the dashboard.

    ``pressure_ratio = predicted_next_hour_pickups / pickup_count_roll_mean_24``
    """

    return safe_ratio(predicted, baseline_24h)


def pressure_label(ratio: float | None) -> str:
    """Project-canonical demand-pressure bucket for a pressure ratio."""

    if ratio is None:
        return "Unavailable"
    try:
        value = float(ratio)
    except (TypeError, ValueError):
        return "Unavailable"
    if not math.isfinite(value):
        return "Unavailable"
    if value >= 1.35:
        return "High"
    if value >= 1.15:
        return "Elevated"
    if value >= 0.8:
        return "Typical"
    return "Low"


def clean_records(df: pd.DataFrame | None) -> list[dict[str, Any]]:
    """Convert a DataFrame to a list of JSON-safe dicts."""

    if df is None or len(df) == 0:
        return []
    out: list[dict[str, Any]] = []
    for row in df.to_dict(orient="records"):
        record: dict[str, Any] = {}
        for key, value in row.items():
            if isinstance(value, pd.Timestamp):
                record[key] = value.isoformat()
            else:
                record[key] = safe_number(value)
        out.append(record)
    return out


def iso(value: Any) -> str | None:
    """Return an ISO-8601 timestamp string or ``None``."""

    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, str):
        return value
    try:
        return pd.Timestamp(value).isoformat()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# File discovery helpers
# ---------------------------------------------------------------------------


def find_existing_file(candidates: Iterable[str | Path]) -> Path | None:
    """Return the first ``Path`` from ``candidates`` that exists on disk."""

    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        try:
            if path.exists() and path.is_file():
                return path
        except OSError:
            continue
    return None


# ---------------------------------------------------------------------------
# Model name normalisation
# ---------------------------------------------------------------------------


_CANONICAL_MODELS: dict[str, str] = {
    "xgboost": "XGBoost",
    "xgb": "XGBoost",
    "randomforest": "Random Forest",
    "random_forest": "Random Forest",
    "rf": "Random Forest",
    "gradientboosting": "Gradient Boosting",
    "gradient_boosting": "Gradient Boosting",
    "gbm": "Gradient Boosting",
    "ridgeregression": "Ridge Regression",
    "ridge_regression": "Ridge Regression",
    "ridge": "Ridge Regression",
    "linearregression": "Linear Regression",
    "linear_regression": "Linear Regression",
    "seasonalnaive": "Seasonal Naive",
    "seasonal_naive": "Seasonal Naive",
    "naive": "Seasonal Naive",
    "lstm": "LSTM",
    "lstm24hforecaster": "LSTM",
    "gru": "GRU",
    "gru24hforecaster": "GRU",
    "temporalcnn": "Temporal CNN",
    "temporal_cnn": "Temporal CNN",
    "temporalcnn24hforecaster": "Temporal CNN",
    "tcn": "Temporal CNN",
    "previous24hoursnaive": "Seasonal Naive",
}


def normalize_model_name(name: Any) -> str | None:
    """Map various model strings to canonical labels used across the API."""

    if name is None:
        return None
    text = str(name).strip()
    if not text:
        return None
    cleaned = re.sub(r"[\s_\-]+", "", text.lower())
    if cleaned in _CANONICAL_MODELS:
        return _CANONICAL_MODELS[cleaned]
    # Strip "24hforecaster" suffix and try again.
    stripped = cleaned.replace("24hforecaster", "")
    if stripped in _CANONICAL_MODELS:
        return _CANONICAL_MODELS[stripped]
    # Otherwise return Title Cased version (preserving acronyms when possible)
    if cleaned in {"lstm", "gru", "tcn"}:
        return cleaned.upper()
    return text  # unknown, keep original


def canonical_model_order() -> list[str]:
    """Default ordering used when several models are present."""

    return [
        "XGBoost",
        "Random Forest",
        "Gradient Boosting",
        "Ridge Regression",
        "Linear Regression",
        "Seasonal Naive",
        "LSTM",
        "GRU",
        "Temporal CNN",
    ]
