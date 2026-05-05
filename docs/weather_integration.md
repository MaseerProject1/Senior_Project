# Weather Integration

## Module

- `src/data/weather.py`

## Responsibilities

- download real NYC weather history from the configured archive source
- cache raw hourly responses in `data/external/weather/`
- normalize timestamps to hourly resolution
- validate the weather schema
- fill missing values with interpolation plus fallback medians
- expose a stable hourly weather table for feature engineering

## Variables

- `temperature`
- `precipitation`
- `snowfall`
- `wind_speed`
- `humidity`
- `weather_category`

Derived binary weather features are added in feature engineering:

- `rain_indicator`
- `heavy_rain_indicator`
- `snowfall_indicator`

## Merge logic

- weather is downloaded for the full hourly range covered by the zone panel
- timestamps are normalized to hourly resolution
- the weather table is left-joined onto the modeling panel on `timestamp`
- because the weather signal is city-level, the same hourly weather row is repeated across zones

## Failure handling

- if weather download fails, cached files are missing, or the frame is too short for a real run, the pipeline falls back to neutral defaults
- the rest of the pipeline still runs
