# Data Sources

## Taxi data

- NYC TLC trip record portal: https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page
- Taxi zone lookup: https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv
- Taxi zone geometry: https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip

## Weather data

- Source used by the repository: Open-Meteo historical archive API
- Configured endpoint: `https://archive-api.open-meteo.com/v1/archive`
- Geography: city-level NYC proxy using configured latitude/longitude in `src/config/project.toml`
- Variables requested: temperature, precipitation, snowfall, wind speed, relative humidity, weather code

Raw weather files are cached under:

- `data/external/weather/`

## Event and incident data

- Default remote incident source: NYC Open Data collision feed configured in `src/config/project.toml`
- Optional local event calendars: `data/external/events/major_events.csv`
- Optional local closure calendars: `data/external/events/road_closures.csv`

Raw and derived event files are stored under:

- `data/external/events/`

## Coverage limitations

- weather is city-level, then broadcast to each zone by timestamp
- incidents are zone-level only when coordinates can be mapped to taxi zones
- major events and closures are zone-level only when the optional local files include `zone_id`
- citywide events and incidents are broadcast by hour across the active zone panel
