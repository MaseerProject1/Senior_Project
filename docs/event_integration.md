# Event Integration

## Module

- `src/data/events.py`

## Responsibilities

- ingest incident and event context
- cache raw incident downloads in `data/external/events/`
- normalize event timestamps to hourly resolution
- map incidents to taxi zones when geometry and coordinates are available
- generate optional zone-hour contextual features

## Feature outputs

- `event_active`
- `event_flag`
- `event_intensity`
- `event_intensity_score`
- `incident_flag`
- `accident_flag`
- `road_disruption_flag`
- `road_closure_flag`
- `disruption_score`

## Supported inputs

- remote NYC collision feed for accident and disruption context
- optional local `major_events.csv`
- optional local `road_closures.csv`

Recommended local event file fields:

- `start_time`
- `end_time`
- `zone_id` optional
- `event_intensity` or `closure_severity` optional

## Merge logic

- event features are aligned to hourly timestamps
- zone-specific records merge on `timestamp` and `zone_id`
- citywide records merge on `timestamp` and are broadcast across active zones

## Limitations

- major concerts and sports schedules are not guaranteed unless the local calendar files are populated
- incident-to-zone mapping depends on available coordinates and taxi-zone geometry
- event coverage can therefore be mixed city-level and zone-level
