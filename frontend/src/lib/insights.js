import { formatDecimal, formatNumber, formatRatio, isValidNumber, pressureLabel } from "./format";

export function getTopPressureRow(rows = []) {
  let best = null;
  let bestR = -Infinity;
  for (const row of rows) {
    const r = Number(row.pressure_ratio ?? row.observed_pressure_ratio);
    if (Number.isFinite(r) && r >= bestR) {
      bestR = r;
      best = row;
    }
  }
  return best;
}

export function buildInsights(snapshot) {
  const rows = snapshot?.rows ?? snapshot?.zonePressure ?? [];
  const summary = snapshot?.summary ?? {};
  const items = [];

  const top = getTopPressureRow(rows);
  if (top) {
    items.push({
      title: "Highest demand-pressure zone",
      body: `${top.zone_name} (${top.borough}) • pressure ratio ${formatRatio(top.pressure_ratio ?? top.observed_pressure_ratio)} — ${pressureLabel(Number(top.pressure_ratio ?? top.observed_pressure_ratio))}`,
    });
  }

  const incidentZones = rows.filter(
    (row) =>
      Number(row.zone_incident_count) > 0 ||
      Number(row.citywide_incident_count) > 0 ||
      Number(row.incident_flag) > 0
  ).length;

  items.push({
    title: "Incident & disruption context",
    body:
      incidentZones > 0
        ? `Signals appear in ${incidentZones} zone snapshot row(s). Recommended Monitoring relative to disruptions and street closures.`
        : "Light incident/disruption footprint in this hour bucket based on consolidated features.",
  });

  const weather =
    summary.weather_status ||
    rows.find((r) => r.weather_category)?.weather_category ||
    null;
  const temp = rows[0]?.temperature;
  items.push({
    title: "Weather signal",
    body: weather
      ? `${typeof weather === "string" ? weather : "Composite status"}${isValidNumber(temp) ? ` • ~${formatDecimal(temp, 1)}°C` : ""}`
      : "Weather fields not present in this export slice.",
  });

  const total = summary.total_predicted_next_hour_pickups;
  items.push({
    title: "Operational priority",
    body: isValidNumber(total)
      ? `Citywide predicted next-hour pickups ≈ ${formatNumber(total, 0)} (waiting-pressure proxy). Review Supply Coverage where ratios stay elevated.`
      : "Citywide pickup total unavailable for this slice — check API connection or static export.",
  });

  if (!items.length) {
    items.push({
      title: "Awaiting data",
      body: "Load a snapshot with zone rows to populate AI-style insights.",
    });
  }

  return items;
}

/** Four concise cards for the Main Dashboard right rail (evaluator-friendly copy). */
export function buildDashboardInsightFourCards(snapshot, filteredRows = []) {
  const rows = filteredRows.length ? filteredRows : snapshot?.rows ?? [];
  const summary = snapshot?.summary ?? {};

  const top = getTopPressureRow(rows);
  const card1 =
    top != null
      ? {
          title: "Highest demand-pressure zone",
          body: `${top.zone_name} (${top.borough}) has the highest pressure ratio at ${formatRatio(top.pressure_ratio ?? top.observed_pressure_ratio)} (${pressureLabel(Number(top.pressure_ratio ?? top.observed_pressure_ratio))}).`,
        }
      : {
          title: "Highest demand-pressure zone",
          body: "No pressure ratios available for this filtered view — widen borough scope or verify snapshot exports.",
        };

  const incidentRows = rows.filter(
    (row) =>
      Number(row.zone_incident_count) > 0 ||
      Number(row.citywide_incident_count) > 0 ||
      Number(row.incident_flag) > 0 ||
      Number(row.event_flag) > 0 ||
      Number(row.event_active) > 0 ||
      Number(row.road_closure_flag) > 0 ||
      Number(row.disruption_score) > 0
  ).length;

  const card2 = {
    title: "Incident and disruption context",
    body:
      incidentRows > 0
        ? `${incidentRows} zone row(s) show incident or disruption-related signals (flags, counts, or disruption score). Use external DOT/NYPD feeds for authoritative incident status.`
        : "No elevated incident or disruption indicators in this filtered slice — conditions appear comparatively calm in the engineered features.",
  };

  const weather =
    summary.weather_status ||
    rows.find((r) => r.weather_category)?.weather_category ||
    null;
  const temps = rows.map((r) => Number(r.temperature)).filter(Number.isFinite);
  const avgTemp =
    temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : null;

  const card3 = {
    title: "Weather signal",
    body:
      weather || isValidNumber(avgTemp)
        ? `${weather ? String(weather) : "Composite weather fields"}${isValidNumber(avgTemp) ? ` • mean temperature ~${formatDecimal(avgTemp, 1)}°C across zones in view` : ""}`
        : "Weather categories are not populated for this export hour — check weather merge in the training pipeline.",
  };

  const card4 = {
    title: "Recommended monitoring",
    body:
      "Monitor high-pressure zones and align operational review with TLC pickup demand signals and contextual incident features. This dashboard does not observe passenger queue minutes or live driver availability.",
  };

  return [card1, card2, card3, card4];
}
