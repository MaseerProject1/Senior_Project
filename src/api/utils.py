from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd


def safe_number(value: Any) -> float | int | None:
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


def pressure_label(ratio: float | None) -> str:
    if ratio is None:
        return "Unavailable"
    if ratio >= 1.35:
        return "High Pressure"
    if ratio >= 1.0:
        return "Elevated Pressure"
    if ratio >= 0.75:
        return "Typical Pressure"
    return "Low Pressure"


def clean_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    if df is None or df.empty:
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
