import { isValidNumber, riskLabelFromRatio } from "./format";

export function getTopPressureZone(topZones = []) {
  if (!topZones.length) return null;
  return topZones[0];
}

export function buildInsights(data) {
  const top = getTopPressureZone(data?.topZones ?? []);
  const insights = [];

  if (top) {
    insights.push(
      `Highest pressure zone: ${top.zone_name} (${top.borough}) with ratio ${isValidNumber(top.pressure_ratio) ? Number(top.pressure_ratio).toFixed(2) : "N/A"}.`
    );
  }

  const incidentRows = (data?.zonePressure ?? []).filter((row) => Number(row?.incident_flag) === 1);
  if (incidentRows.length) {
    insights.push(`Incident context active in ${incidentRows.length} zone row(s). Recommended Monitoring is advised.`);
  }

  const weather = data?.zonePressure?.[0]?.weather_category;
  if (weather) {
    insights.push(`Current weather signal: ${weather}.`);
  }

  if (top?.pressure_ratio !== undefined) {
    insights.push(`Operational Priority level: ${riskLabelFromRatio(top.pressure_ratio)}.`);
  }

  if (!insights.length) {
    insights.push("No snapshot insights available. Verify exported dashboard JSON files.");
  }
  return insights;
}
