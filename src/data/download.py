from __future__ import annotations

import calendar
from pathlib import Path
from urllib.request import urlretrieve

from src.config.settings import Settings
from src.utils.io import ensure_dir
from src.utils.logging_utils import get_logger


LOGGER = get_logger(__name__)
BASE_URL = "https://d37ci6vzurychx.cloudfront.net/trip-data"
ZONE_LOOKUP_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv"
ZONE_GEOMETRY_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip"


def month_range(start_month: str, end_month: str) -> list[str]:
    start_year, start_m = [int(part) for part in start_month.split("-")]
    end_year, end_m = [int(part) for part in end_month.split("-")]
    current_year, current_month = start_year, start_m
    values: list[str] = []
    while (current_year, current_month) <= (end_year, end_m):
        values.append(f"{current_year:04d}-{current_month:02d}")
        current_month += 1
        if current_month == 13:
            current_month = 1
            current_year += 1
    return values


def _download_file(url: str, destination: Path) -> Path:
    ensure_dir(destination.parent)
    if destination.exists():
        LOGGER.info("Using existing file: %s", destination)
        return destination
    LOGGER.info("Downloading %s", url)
    urlretrieve(url, destination)
    return destination


def download_zone_lookup(settings: Settings) -> Path:
    output_path = settings.path("external_data_dir") / "taxi_zone_lookup.csv"
    return _download_file(ZONE_LOOKUP_URL, output_path)


def download_zone_geometry(settings: Settings) -> Path:
    output_path = settings.path("external_data_dir") / "taxi_zones.zip"
    geometry_url = settings.data_cfg.get("zone_geometry_url", ZONE_GEOMETRY_URL)
    return _download_file(str(geometry_url), output_path)


def yellow_trip_url(month_value: str) -> str:
    return f"{BASE_URL}/yellow_tripdata_{month_value}.parquet"


def download_yellow_months(settings: Settings, start_month: str, end_month: str) -> list[Path]:
    downloaded: list[Path] = []
    for month_value in month_range(start_month, end_month):
        year_value = month_value.split("-")[0]
        month_name = calendar.month_name[int(month_value.split("-")[1])]
        destination = settings.path("raw_data_dir") / "yellow_taxi" / year_value / f"yellow_tripdata_{month_value}.parquet"
        LOGGER.info("Preparing month %s (%s)", month_value, month_name)
        downloaded.append(_download_file(yellow_trip_url(month_value), destination))
    return downloaded
