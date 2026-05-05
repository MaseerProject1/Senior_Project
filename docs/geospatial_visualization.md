# Geospatial Visualization

The dashboard heatmap uses the official TLC taxi-zone geometry zip downloaded during `python -m src.cli ingest`.

Implementation notes:

- Geometry loader: `src/visualization/geospatial.py`
- Zone polygons are joined on `zone_id`
- The dashboard can display three layers:
  - observed current demand
  - predicted next-hour demand
  - pressure ratio relative to the 24-hour rolling baseline

Pressure-ratio safeguards:

- If the 24-hour rolling baseline is below the configured denominator floor, the ratio is treated as unavailable rather than inflated.
- The map leaves those low-baseline ratios blank instead of showing misleadingly large values.

This design is more defensible for sparse or low-demand zones than dividing by a near-zero baseline.
