const API_BASE =
  import.meta.env.VITE_API_BASE !== undefined && import.meta.env.VITE_API_BASE !== ""
    ? String(import.meta.env.VITE_API_BASE).replace(/\/$/, "")
    : import.meta.env.DEV
      ? "/api"
      : "http://127.0.0.1:8000/api";

const FALLBACK_PATHS = {
  overview: "/data/overview.json",
  model_metrics: "/data/model_metrics.json",
  forecast_metrics: "/data/forecast_metrics.json",
  contextual_comparison: "/data/contextual_comparison.json",
  zone_pressure: "/data/zone_pressure.json",
  top_zones: "/data/top_zones.json",
  predictions_preview: "/data/predictions_preview.json",
  dataset_summary: "/data/dataset_summary.json",
  feature_dictionary: "/data/feature_dictionary.json",
  event_integration_summary: "/data/event_integration_summary.json",
  scenario_defaults: "/data/scenario_defaults.json",
  app_config: "/data/app_config.json",
};

function url(pathSuffix) {
  const s = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
  const base =
    API_BASE.endsWith("/api") ? API_BASE : `${String(API_BASE).replace(/\/$/, "")}/api`;
  return `${base}${s}`;
}

async function fetchJsonQuiet(input, opts) {
  try {
    const res = await fetch(input, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, data, status: res.status };
    return { ok: true, data, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

async function fetchStatic(path, fallback = null) {
  const { ok, data } = await fetchJsonQuiet(path);
  return ok ? data : fallback;
}

function computePressureRatio(row) {
  const pred =
    row.predicted_next_hour_pickups != null ? Number(row.predicted_next_hour_pickups) : null;
  const denom = Number(row.pickup_count_roll_mean_24);
  if (!Number.isFinite(pred) || !Number.isFinite(denom) || denom <= 0) {
    const r = row.pressure_ratio ?? row.observed_pressure_ratio;
    return Number.isFinite(Number(r)) ? Number(r) : null;
  }
  return pred / denom;
}

function buildSnapshotFallback({ timestamp = null } = {}) {
  return (async () => {
    const [zonePressure, overview] = await Promise.all([
      fetchStatic(FALLBACK_PATHS.zone_pressure, []),
      fetchStatic(FALLBACK_PATHS.overview, {}),
    ]);

    let rows = Array.isArray(zonePressure) ? [...zonePressure] : [];
    if (timestamp) {
      const match = rows.filter((r) => String(r.timestamp) === timestamp);
      if (match.length) rows = match;
    }
    if (!timestamp && rows.length) {
      const latest = [...new Set(rows.map((r) => r.timestamp).filter(Boolean))].sort().at(-1);
      if (latest) rows = rows.filter((r) => r.timestamp === latest);
    }

    rows = rows.map((r) => ({
      ...r,
      predicted_next_hour_pickups:
        r.predicted_next_hour_pickups ?? r.observed_next_hour_pickups ?? null,
      pressure_ratio:
        r.pressure_ratio != null ? r.pressure_ratio : computePressureRatio(r),
      pressure_label: r.pressure_label,
    }));

    const high_pressure_zone_count = rows.filter(
      (r) => Number(r.pressure_ratio ?? r.observed_pressure_ratio) >= 1.35
    ).length;
    const incidentRows = rows.filter((r) => Number(r.zone_incident_count) > 0 || Number(r.incident_flag) > 0);
    const preds = rows
      .map((r) => Number(r.predicted_next_hour_pickups))
      .filter(Number.isFinite);
    const total_predicted_next_hour_pickups =
      preds.reduce((a, b) => a + b, 0) || null;

    let maxZone = null;
    let maxR = -Infinity;
    for (const r of rows) {
      const rr = Number(r.pressure_ratio ?? r.observed_pressure_ratio);
      if (Number.isFinite(rr) && rr >= maxR) {
        maxR = rr;
        maxZone = {
          zone_id: r.zone_id,
          zone_name: r.zone_name,
          borough: r.borough,
          pressure_ratio: rr,
          pressure_label: r.pressure_label,
        };
      }
    }

    const first = rows[0] || {};
    const weather_status =
      first.weather_category != null ? String(first.weather_category) : "Dry Conditions";

    return {
      prediction_source: "static_fallback",
      model_name: overview.best_tabular_model ?? "Baseline",
      summary: {
        timestamp: first.timestamp ?? null,
        total_predicted_next_hour_pickups,
        high_pressure_zone_count,
        active_incident_rows: incidentRows.length,
        weather_status,
        max_pressure_zone: maxZone,
      },
      rows,
    };
  })();
}

function uniqTs(rows, limit = 200) {
  const s = new Set(rows.map((r) => String(r.timestamp)).filter(Boolean));
  const sorted = [...s].sort();
  if (limit == null || limit <= 0 || limit >= sorted.length) return sorted;
  return sorted.slice(-limit);
}

export async function getHealth() {
  const r = await fetchJsonQuiet(url("/health"));
  if (!r.ok) return { ok: false, data: r.data ?? null, status: r.status };
  return { ok: true, data: r.data ?? {}, status: 200 };
}

export async function getOverview() {
  const r = await fetchJsonQuiet(url("/overview"));
  if (r.ok && r.data && typeof r.data === "object")
    return { source: "api", data: r.data };
  const o = await fetchStatic(FALLBACK_PATHS.overview, {});
  const ds = await fetchStatic(FALLBACK_PATHS.dataset_summary, {});
  return {
    source: "static",
    data: {
      ...o,
      rows: ds.rows ?? o.rows,
      columns: ds.columns ?? o.columns,
      zones: ds.number_of_zones ?? o.zones,
      time_range_start: ds.time_range_start,
      time_range_end: ds.time_range_end,
    },
  };
}

export async function getZones() {
  const r = await fetchJsonQuiet(url("/zones"));
  if (r.ok && r.data?.rows) return { source: "api", rows: r.data.rows };
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  const m = new Map();
  if (Array.isArray(zp)) {
    for (const row of zp) {
      const id = Number(row.zone_id);
      if (!Number.isFinite(id)) continue;
      if (!m.has(id))
        m.set(id, {
          zone_id: id,
          zone_name: row.zone_name,
          borough: row.borough,
        });
    }
  }
  return {
    source: "static",
    rows: [...m.values()].sort(
      (a, b) => (a.borough || "").localeCompare(b.borough || "") || (a.zone_name || "").localeCompare(b.zone_name || "")
    ),
  };
}

/**
 * @param {number|null} zoneId
 * @param {{ maxTimestamps?: number }} [opts] Pass maxTimestamps: 0 or omit for all distinct timestamps from static JSON.
 */
export async function getTimestamps(zoneId = null, opts = {}) {
  const maxTs =
    opts.maxTimestamps !== undefined ? opts.maxTimestamps : 50000;
  const qp =
    zoneId != null ? `?zone_id=${encodeURIComponent(zoneId)}` : "";
  const r = await fetchJsonQuiet(`${url(`/timestamps${qp}`)}`);
  if (r.ok && Array.isArray(r.data?.rows))
    return { source: "api", rows: r.data.rows };
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  const scenario = await fetchStatic(FALLBACK_PATHS.scenario_defaults, {});
  if (!Array.isArray(zp)) {
    const fallbackTs = scenario?.timestamp ? [scenario.timestamp] : [];
    return { source: "static", rows: fallbackTs };
  }
  let rows = zp;
  if (zoneId != null)
    rows = zp.filter((x) => Number(x.zone_id) === Number(zoneId));
  const fromData = uniqTs(rows, maxTs <= 0 ? null : maxTs);
  if (scenario?.timestamp && !fromData.includes(String(scenario.timestamp)))
    return {
      source: "static",
      rows: [...fromData, scenario.timestamp].sort(),
    };
  return { source: "static", rows: fromData };
}

export async function getDashboardSnapshot({ timestamp = null, model = null } = {}) {
  const params = new URLSearchParams();
  if (timestamp) params.set("timestamp", timestamp);
  if (model) params.set("model", model);
  const q = params.toString() ? `?${params}` : "";
  const r = await fetchJsonQuiet(`${url(`/dashboard/snapshot${q}`)}`);
  if (r.ok && r.data?.rows) return { source: "api", data: r.data };
  return { source: "static", data: await buildSnapshotFallback({ timestamp }) };
}

export async function getCityTrend(hours = 168) {
  const r = await fetchJsonQuiet(url(`/city/trend?hours=${encodeURIComponent(hours)}`));
  if (r.ok && Array.isArray(r.data?.rows)) return { source: "api", rows: r.data.rows };
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { source: "static", rows: [] };
  const byTs = {};
  for (const row of zp) {
    const t = row.timestamp;
    if (!t) continue;
    if (!byTs[t])
      byTs[t] = {
        timestamp: t,
        total_pickups: 0,
        total_next_hour_target: 0,
        total_zone_incidents: 0,
        avg_pressure_ratio: 0,
        n: 0,
      };
    const b = byTs[t];
    b.total_pickups += Number(row.pickup_count) || 0;
    b.total_next_hour_target += Number(row.target_pickup_count_next_hour) || 0;
    b.total_zone_incidents += Number(row.zone_incident_count) || 0;
    const pr = computePressureRatio(row);
    if (Number.isFinite(pr)) {
      b.avg_pressure_ratio += pr;
      b.n += 1;
    }
  }
  let rows = Object.values(byTs).map((row) => ({
    timestamp: row.timestamp,
    total_pickups: row.total_pickups,
    total_next_hour_target: row.total_next_hour_target,
    total_zone_incidents: row.total_zone_incidents,
    avg_pressure_ratio: row.n ? row.avg_pressure_ratio / row.n : null,
    avg_temperature: null,
    total_precipitation: null,
  }));
  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  rows = rows.slice(-hours);
  return { source: "static", rows };
}

export async function getBoroughTrend(hours = 168) {
  const r = await fetchJsonQuiet(url(`/borough/trend?hours=${encodeURIComponent(hours)}`));
  if (r.ok && Array.isArray(r.data?.rows)) return { source: "api", rows: r.data.rows };
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { source: "static", rows: [] };
  const key = {};
  for (const row of zp) {
    const b = row.borough;
    const t = row.timestamp;
    if (!b || !t) continue;
    const k = `${t}__${b}`;
    if (!key[k])
      key[k] = {
        timestamp: t,
        borough: b,
        pickup_count: 0,
        target_pickup_count_next_hour: 0,
      };
    key[k].pickup_count += Number(row.pickup_count) || 0;
    key[k].target_pickup_count_next_hour += Number(row.target_pickup_count_next_hour) || 0;
  }
  let rows = Object.values(key).map((row) => ({
    timestamp: row.timestamp,
    borough: row.borough,
    pickup_count: row.pickup_count,
    target_pickup_count_next_hour: row.target_pickup_count_next_hour,
    avg_pressure_ratio:
      row.pickup_count > 0 ? row.target_pickup_count_next_hour / row.pickup_count : null,
  }));
  rows.sort((a, b) =>
    `${a.timestamp} ${a.borough}`.localeCompare(`${b.timestamp} ${b.borough}`)
  );
  rows = rows.slice(-Math.min(hours * 8, rows.length));
  return { source: "static", rows };
}

export async function getZoneHourHeatmap(hours = 24, topN = 15) {
  const r = await fetchJsonQuiet(
    url(
      `/heatmap/zone-hour?hours=${encodeURIComponent(hours)}&top_n=${encodeURIComponent(topN)}`
    )
  );
  if (r.ok && Array.isArray(r.data?.rows)) return { source: "api", rows: r.data.rows };
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { source: "static", rows: [] };
  const sorted = [...zp]
    .map((row) => ({
      ...row,
      pressure_ratio:
        row.pressure_ratio != null ? Number(row.pressure_ratio) : computePressureRatio(row),
      hour:
        row.hour ??
        (() => {
          const d = new Date(row.timestamp);
          return Number.isFinite(d.getTime()) ? d.getHours() : 0;
        })(),
    }))
    .filter((row) => Number.isFinite(Number(row.pressure_ratio)))
    .sort((a, b) => Number(b.pressure_ratio) - Number(a.pressure_ratio))
    .slice(0, topN * Math.max(hours, 1));
  return { source: "static", rows: sorted };
}

export async function getWeatherEventsTimeline(hours = 168) {
  const r = await fetchJsonQuiet(
    url(`/weather-events/timeline?hours=${encodeURIComponent(hours)}`)
  );
  if (r.ok && Array.isArray(r.data?.rows)) return { source: "api", rows: r.data.rows };
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { source: "static", rows: [] };
  const byTs = {};
  for (const row of zp) {
    const t = row.timestamp;
    if (!t) continue;
    if (!byTs[t]) {
      byTs[t] = {
        timestamp: t,
        temperature: [],
        precipitation: [],
        humidity: [],
        wind_speed: [],
        total_zone_incidents: [],
        avg_event_intensity_score: [],
        avg_disruption_score: [],
      };
    }
    const b = byTs[t];
    if (row.temperature != null) b.temperature.push(Number(row.temperature));
    if (row.precipitation != null) b.precipitation.push(Number(row.precipitation));
    if (row.humidity != null) b.humidity.push(Number(row.humidity));
    if (row.wind_speed != null) b.wind_speed.push(Number(row.wind_speed));
    b.total_zone_incidents.push(Number(row.zone_incident_count) || 0);
    b.avg_event_intensity_score.push(Number(row.event_intensity_score) || 0);
    b.avg_disruption_score.push(Number(row.disruption_score) || 0);
  }
  const avg = (a) =>
    a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  let rows = Object.values(byTs).map((block) => ({
    timestamp: block.timestamp,
    temperature: avg(block.temperature),
    precipitation:
      block.precipitation.length > 0
        ? block.precipitation.reduce((x, y) => x + y, 0)
        : null,
    humidity: avg(block.humidity),
    wind_speed: avg(block.wind_speed),
    total_zone_incidents:
      block.total_zone_incidents.length > 0
        ? block.total_zone_incidents.reduce((x, y) => x + y, 0)
        : null,
    citywide_incident_count: null,
    avg_event_intensity_score: avg(block.avg_event_intensity_score),
    avg_disruption_score: avg(block.avg_disruption_score),
    incident_flag_count: null,
  }));
  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  rows = rows.slice(-hours);
  return { source: "static", rows };
}

export async function getModelMetrics() {
  const r = await fetchJsonQuiet(url("/models/metrics"));
  if (r.ok && r.data?.model_metrics) return { source: "api", data: r.data };
  const [model_metrics, forecast_metrics, contextual_comparison, overview] = await Promise.all([
    fetchStatic(FALLBACK_PATHS.model_metrics, []),
    fetchStatic(FALLBACK_PATHS.forecast_metrics, []),
    fetchStatic(FALLBACK_PATHS.contextual_comparison, []),
    fetchStatic(FALLBACK_PATHS.overview, {}),
  ]);
  return {
    source: "static",
    data: {
      model_metrics,
      forecast_metrics,
      contextual_comparison,
      best_tabular_model:
        overview.best_tabular_model ?? "XGBoost",
      best_forecast_model:
        overview.best_forecast_model ?? "GRU",
    },
  };
}

export async function getModelPredictions({ model = null, limit = 1000 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (model) q.set("model", model);
  const r = await fetchJsonQuiet(`${url(`/models/predictions?${q}`)}`);
  if (r.ok && Array.isArray(r.data?.rows)) return { source: "api", rows: r.data.rows };
  const pv = await fetchStatic(FALLBACK_PATHS.predictions_preview, []);
  let rows = Array.isArray(pv) ? pv : [];
  if (model) rows = rows.filter((row) => (row.model_name || "") === model);
  rows = rows.slice(0, limit);
  return { source: "static", rows };
}

export async function runSimulation(payload) {
  const r = await fetchJsonQuiet(url("/simulation/run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const rawDetail = r.data?.detail ?? r.data?.error;
  const detail =
    rawDetail == null
      ? null
      : typeof rawDetail === "string"
        ? rawDetail
        : Array.isArray(rawDetail)
          ? rawDetail.map((item) => (typeof item?.msg === "string" ? item.msg : JSON.stringify(item))).join(" • ")
          : JSON.stringify(rawDetail);
  const msg = detail;

  if (r.ok && r.data && typeof r.data === "object" && rawDetail == null)
    return { source: "api", ok: true, data: r.data };

  return {
    source: "static",
    ok: false,
    message:
      msg ||
      "Simulation API unavailable. Start the FastAPI backend to run POST /api/simulation/run.",
    payload,
  };
}

export async function getDataInfo() {
  const r = await fetchJsonQuiet(url("/data-info"));
  if (r.ok && r.data) return { source: "api", data: r.data };
  const [dataset_summary, feature_dictionary, event_integration_summary] = await Promise.all([
    fetchStatic(FALLBACK_PATHS.dataset_summary, {}),
    fetchStatic(FALLBACK_PATHS.feature_dictionary, []),
    fetchStatic(FALLBACK_PATHS.event_integration_summary, []),
  ]);
  const overview = await fetchStatic(FALLBACK_PATHS.overview, {});
  return {
    source: "static",
    data: {
      dataset_summary,
      feature_dictionary,
      event_integration_summary,
      data_quality_summary: null,
      target_explanation: {
        target_column: overview.target ?? "target_pickup_count_next_hour",
        target_definition:
          overview.target_definition ??
          "Next-hour yellow taxi pickup count by NYC TLC taxi zone.",
        proxy_note: overview.proxy_note,
      },
      data_sources: overview.data_sources,
    },
  };
}

export async function getFigures() {
  const r = await fetchJsonQuiet(url("/figures"));
  if (r.ok && Array.isArray(r.data?.rows)) return { source: "api", rows: r.data.rows };
  return { source: "static", rows: [] };
}

export async function getZoneHistory(zoneId, hours = 168) {
  const r = await fetchJsonQuiet(
    url(`/zone/${encodeURIComponent(zoneId)}/history?hours=${encodeURIComponent(hours)}`)
  );
  if (r.ok && Array.isArray(r.data?.rows)) return { source: "api", rows: r.data.rows };
  const zp = await fetchStatic(FALLBACK_PATHS.zone_pressure, []);
  if (!Array.isArray(zp)) return { source: "static", rows: [] };
  const rows = zp
    .filter((row) => Number(row.zone_id) === Number(zoneId))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .slice(-hours)
    .map((row) => ({
      timestamp: row.timestamp,
      pickup_count: row.pickup_count,
      target_pickup_count_next_hour: row.target_pickup_count_next_hour,
      pickup_count_roll_mean_24: row.pickup_count_roll_mean_24,
      pressure_ratio: computePressureRatio(row),
      temperature: row.temperature,
      precipitation: row.precipitation,
      event_intensity_score: row.event_intensity_score,
      disruption_score: row.disruption_score,
      zone_incident_count: row.zone_incident_count,
      citywide_incident_count: row.citywide_incident_count,
    }));
  return { source: "static", rows };
}
