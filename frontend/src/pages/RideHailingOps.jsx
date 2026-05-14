import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCcw,
  Cloud,
  Gauge,
  MapPinned,
  ShieldAlert,
  AlertTriangle,
  BarChart3,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
  Legend,
  AreaChart,
  Area,
} from "recharts";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import SelectField from "../components/SelectField";
import GlassButton from "../components/GlassButton";
import DataTable from "../components/DataTable";
import TlcZoneMap from "../components/TlcZoneMap";
import {
  getDashboardSnapshot,
  getCityTrend,
  getTimestamps,
  getModels,
  getTaxiZonesGeoJson,
  apiUrl,
  peekCachedApiUrl,
} from "../lib/api";
import {
  formatDecimal,
  formatNumber,
  formatRatio,
  isoToDisplay,
  pressureTierLabel,
} from "../lib/format";
import {
  buildCompanyOperationalInsightRail,
  buildCompanyOperationalSuggestions,
  incidentContextActive,
  summarizeIncidentContext,
} from "../lib/insights";

const LOG = "[MASEER]";

const MAP_METRIC_OPTIONS = [
  { value: "ratio", label: "Pressure Ratio" },
  { value: "pickups", label: "Predicted Pickups" },
  { value: "incident", label: "Incident Context" },
];

const THRESHOLD_OPTIONS = [
  { value: "elevated", label: "Elevated and High (≥1.15×)" },
  { value: "high", label: "High only (≥1.35×)" },
  { value: "all", label: "All pressure levels" },
];

const BASE_BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];

function isUnknownBorough(b) {
  const s = String(b ?? "").trim().toLowerCase();
  return !s || s === "unknown" || s === "n/a" || s === "—" || s === "-";
}

function tsMs(t) {
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.getTime() : NaN;
}

function cityRowAtTimestamp(cityRows, selectedTimestamp) {
  if (!cityRows?.length) return { row: null, resolvedTs: null, usedNearest: false };
  if (!selectedTimestamp) {
    const last = cityRows[cityRows.length - 1];
    return { row: last ?? null, resolvedTs: last?.timestamp ?? null, usedNearest: false };
  }
  const target = tsMs(selectedTimestamp);
  if (!Number.isFinite(target)) {
    const last = cityRows[cityRows.length - 1];
    return { row: last ?? null, resolvedTs: last?.timestamp ?? null, usedNearest: true };
  }
  const byTs = [...cityRows].sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));
  const exact = byTs.find((r) => tsMs(r.timestamp) === target);
  if (exact) return { row: exact, resolvedTs: exact.timestamp, usedNearest: false };
  let chosen = null;
  for (let i = byTs.length - 1; i >= 0; i--) {
    if (tsMs(byTs[i].timestamp) <= target) {
      chosen = byTs[i];
      break;
    }
  }
  if (!chosen) chosen = byTs[0];
  return { row: chosen, resolvedTs: chosen.timestamp, usedNearest: true };
}

function countPressureThreshold(rows, mode) {
  if (mode === "high") return rows.filter((r) => Number(r.pressure_ratio) >= 1.35).length;
  if (mode === "elevated") return rows.filter((r) => Number(r.pressure_ratio) >= 1.15).length;
  return rows.filter((r) => Number.isFinite(Number(r.pressure_ratio))).length;
}

function rowMeetsSelectedPressureThreshold(row, thresholdMode) {
  const r = Number(row.pressure_ratio);
  if (thresholdMode === "high") return Number.isFinite(r) && r >= 1.35;
  if (thresholdMode === "elevated") return Number.isFinite(r) && r >= 1.15;
  return Number.isFinite(r);
}

function incidentDisruptionScore(row) {
  if (!row) return 0;
  return (
    Number(row.zone_incident_count || 0) +
    (Number(row.incident_flag) > 0 ? 2 : 0) +
    (Number(row.road_closure_flag) > 0 ? 1.5 : 0) +
    Number(row.disruption_score || 0) +
    (Number(row.event_active) > 0 || Number(row.event_flag) > 0 ? 1 : 0)
  );
}

function tableSortCompany(a, b) {
  const pa = Number(a.predicted_next_hour_pickups ?? a.target_pickup_count_next_hour ?? 0);
  const pb = Number(b.predicted_next_hour_pickups ?? b.target_pickup_count_next_hour ?? 0);
  if (pb !== pa) return pb - pa;
  const ra = Number(a.pressure_ratio ?? a.observed_pressure_ratio ?? 0);
  const rb = Number(b.pressure_ratio ?? b.observed_pressure_ratio ?? 0);
  const fa = Number.isFinite(ra);
  const fb = Number.isFinite(rb);
  if (fa && fb && rb !== ra) return rb - ra;
  if (fa !== fb) return fb ? 1 : fa ? -1 : 0;
  const ia = incidentDisruptionScore(a);
  const ib = incidentDisruptionScore(b);
  if (ib !== ia) return ib - ia;
  return String(a.zone_name ?? "").localeCompare(String(b.zone_name ?? ""));
}

function companyPlanningNoteForRow(row, predP85) {
  if (incidentContextActive(row)) return "Consider incident/weather context.";
  const r = Number(row.pressure_ratio ?? row.observed_pressure_ratio);
  if (Number.isFinite(r) && r >= 1.35) return "Monitor elevated demand pressure.";
  if (Number.isFinite(r) && r >= 1.15) return "Monitor elevated demand pressure.";
  const pred = Number(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour);
  if (Number.isFinite(pred) && Number.isFinite(predP85) && predP85 != null && pred >= predP85) {
    return "Review coverage around high predicted demand.";
  }
  return "Typical pressure for selected snapshot.";
}

function companyOperationalReviewPriority(high135, elevated115, incidentCtx, zoneCount) {
  const n = Math.max(1, zoneCount);
  const hpShare = high135 / n;
  const elShare = elevated115 / n;
  if (high135 >= 15 && incidentCtx >= 6) return "High";
  if (hpShare >= 0.12 && incidentCtx >= 4) return "High";
  if (high135 >= 5 || incidentCtx >= 5) return "Elevated";
  if (high135 >= 1 || incidentCtx >= 2 || elShare >= 0.35) return "Moderate";
  return "Low";
}

function peakBoroughByAvgPressure(rows) {
  const by = {};
  for (const r of rows) {
    if (isUnknownBorough(r.borough)) continue;
    const b = String(r.borough).trim();
    const pr = Number(r.pressure_ratio ?? r.observed_pressure_ratio);
    if (!Number.isFinite(pr)) continue;
    if (!by[b]) by[b] = { sum: 0, n: 0 };
    by[b].sum += pr;
    by[b].n += 1;
  }
  let bestName = null;
  let bestAvg = -Infinity;
  for (const [b, agg] of Object.entries(by)) {
    const { sum, n } = agg;
    if (!n) continue;
    const avg = sum / n;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestName = b;
    }
  }
  return bestName && Number.isFinite(bestAvg) ? { name: bestName, ratio: bestAvg } : null;
}

function peakBoroughByPredictedSum(rows) {
  const by = {};
  for (const r of rows) {
    if (isUnknownBorough(r.borough)) continue;
    const b = String(r.borough).trim();
    const p = Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour);
    if (!Number.isFinite(p)) continue;
    by[b] = (by[b] || 0) + p;
  }
  let best = null;
  let bestV = -Infinity;
  for (const [b, v] of Object.entries(by)) {
    if (v > bestV) {
      bestV = v;
      best = b;
    }
  }
  return best ? { name: best, sum: bestV } : null;
}

function boroughDemandConcentration(rows) {
  let total = 0;
  const by = {};
  for (const r of rows) {
    if (isUnknownBorough(r.borough)) continue;
    const b = String(r.borough).trim();
    const p = Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour);
    if (!Number.isFinite(p) || p <= 0) continue;
    by[b] = (by[b] || 0) + p;
    total += p;
  }
  if (!total) return null;
  let best = null;
  let bestV = -1;
  for (const [b, v] of Object.entries(by)) {
    if (v > bestV) {
      bestV = v;
      best = b;
    }
  }
  return best ? { name: best, share: bestV / total } : null;
}

function schematicCellClass(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return "bg-slate-100/90 border-slate-200 text-brand-muted";
  if (r >= 1.35) return "bg-gradient-to-br from-rose-400/95 to-brand-critical border-rose-500/35 text-white";
  if (r >= 1.15) return "bg-amber-200/95 border-amber-400/50 text-amber-950";
  if (r >= 0.85) return "bg-emerald-200/80 border-emerald-400/35 text-brand-text";
  return "bg-brand-mint/80 border-teal-200/60 text-brand-deep";
}

export default function RideHailingOps({ overview, refreshHealth, apiOnline }) {
  const [timestamps, setTimestamps] = useState([]);
  const [models, setModels] = useState([]);
  const [timestamp, setTimestamp] = useState("");
  const [model, setModel] = useState("");
  const [boroughFilter, setBoroughFilter] = useState("all");
  const [mapMetric, setMapMetric] = useState("ratio");
  const [thresholdMode, setThresholdMode] = useState("elevated");
  const [snapshot, setSnapshot] = useState(null);
  const [cityTrend, setCityTrend] = useState([]);
  const [geoJson, setGeoJson] = useState(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchErrors, setFetchErrors] = useState({});
  const snapshotRef = useRef(null);

  const allowStaticFallback = apiOnline !== true;

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useLayoutEffect(() => {
    if (apiOnline === null) return;
    const modelArg = model || undefined;
    const snapParams = new URLSearchParams();
    if (timestamp) snapParams.set("timestamp", timestamp);
    if (modelArg) snapParams.set("model", modelArg);
    const sq = snapParams.toString() ? `?${snapParams}` : "";
    const snPeek = peekCachedApiUrl(apiUrl(`dashboard/snapshot${sq}`));
    if (snPeek?.ok && snPeek.data && Array.isArray(snPeek.data.rows)) {
      setSnapshot(snPeek.data);
    }
    const trendParams = new URLSearchParams();
    trendParams.set("hours", "168");
    if (modelArg) trendParams.set("model", modelArg);
    const ctPeek = peekCachedApiUrl(apiUrl(`city/trend?${trendParams}`));
    if (ctPeek?.ok && Array.isArray(ctPeek.data?.rows)) {
      setCityTrend(ctPeek.data.rows);
    }
  }, [apiOnline, timestamp, model]);

  useEffect(() => {
    if (apiOnline === null) return;
    let cancel = false;
    (async () => {
      const geoHit = peekCachedApiUrl(apiUrl("map/taxi-zones"));
      if (geoHit?.ok && geoHit.data?.features?.length) {
        if (!cancel) {
          setGeoJson(geoHit.data);
          setGeoError(null);
          setGeoLoading(false);
        }
        return;
      }
      if (!cancel) setGeoLoading(true);
      const r = await getTaxiZonesGeoJson({ allowStaticFallback });
      if (cancel) return;
      if (r.ok && r.data?.features?.length) {
        setGeoJson(r.data);
        setGeoError(null);
      } else {
        setGeoJson(null);
        setGeoError(r.error || "GeoJSON unavailable");
      }
      setGeoLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [apiOnline, allowStaticFallback]);

  useEffect(() => {
    if (apiOnline === null) return;
    (async () => {
      const [tsRes, gm] = await Promise.all([
        getTimestamps({ allowStaticFallback }),
        getModels({ allowStaticFallback }),
      ]);
      if (tsRes.ok !== false) setTimestamps(tsRes.rows ?? []);
      else console.warn(`${LOG} ops timestamps:`, tsRes.error);
      if (gm.ok === false) {
        console.warn(`${LOG} ops models:`, gm.error);
        const fb = overview?.best_tabular_model;
        if (fb) {
          setModels([String(fb)]);
          setModel((p) => p || String(fb));
        }
        return;
      }
      const opts = (gm.models ?? []).map(String);
      setModels(opts);
      setModel((prev) => {
        if (prev && opts.includes(prev)) return prev;
        if (opts.includes("XGBoost")) return "XGBoost";
        const def = gm.default_model ? String(gm.default_model) : "";
        if (def && opts.includes(def)) return def;
        return opts[0] ? String(opts[0]) : "";
      });
    })();
  }, [overview?.best_tabular_model, apiOnline, allowStaticFallback]);

  const load = useCallback(
    async ({ forceRefresh = false } = {}) => {
      if (apiOnline === null) return;
      if (!snapshotRef.current && !forceRefresh) setLoading(true);
      const modelArg = model || undefined;
      try {
        const [sn, ct] = await Promise.all([
          getDashboardSnapshot({
            timestamp: timestamp || undefined,
            model: modelArg,
            allowStaticFallback,
            forceRefresh,
          }),
          getCityTrend({ hours: 168, model: modelArg, allowStaticFallback, forceRefresh }),
        ]);
        setFetchErrors((prev) => {
          const n = { ...prev };
          const touch = (key, res) => {
            if (res.ok === false) {
              console.warn(`${LOG} ops [${key}]:`, res.error);
              n[key] = res.error || "Failed";
            } else delete n[key];
          };
          touch("snapshot", sn);
          touch("city", ct);
          return n;
        });
        if (sn.ok !== false) setSnapshot(sn.data);
        if (ct.ok !== false) setCityTrend(ct.rows ?? []);
      } finally {
        setLoading(false);
      }
    },
    [timestamp, model, apiOnline, allowStaticFallback]
  );

  useEffect(() => {
    load();
  }, [load]);

  const defaultTs = timestamps.length ? timestamps[0] : "";
  useEffect(() => {
    if (!timestamp && defaultTs) setTimestamp(defaultTs);
  }, [defaultTs, timestamp]);

  useEffect(() => {
    if (!timestamp || !timestamps.length) return;
    if (!timestamps.includes(timestamp)) setTimestamp(defaultTs || timestamps[0] || "");
  }, [timestamps, timestamp, defaultTs]);

  const fullRows = snapshot?.rows ?? [];
  const summary = snapshot?.summary ?? {};

  const boroughOptions = useMemo(() => {
    const fromData = new Set();
    for (const r of fullRows) {
      const b = r.borough;
      if (!isUnknownBorough(b)) fromData.add(String(b).trim());
    }
    const extra = [...fromData].filter((b) => !BASE_BOROUGHS.includes(b));
    const hasEwr = extra.some((b) => b.toUpperCase().includes("EWR")) || [...fromData].some((b) => b.toUpperCase().includes("EWR"));
    const ewrOnly = extra.filter((b) => b.toUpperCase().includes("EWR"));
    const rest = extra.filter((b) => !b.toUpperCase().includes("EWR"));
    const opts = [{ value: "all", label: "All NYC" }];
    for (const b of BASE_BOROUGHS) opts.push({ value: b, label: b });
    if (hasEwr && ewrOnly.length) {
      for (const b of ewrOnly) opts.push({ value: b, label: b });
    }
    for (const b of rest.sort()) opts.push({ value: b, label: b });
    return opts;
  }, [fullRows]);

  const rowsForBorough = useMemo(() => {
    if (!boroughFilter || boroughFilter === "all") return fullRows;
    return fullRows.filter((r) => String(r.borough ?? "").toLowerCase() === boroughFilter.toLowerCase());
  }, [fullRows, boroughFilter]);

  const predValues = useMemo(
    () =>
      rowsForBorough
        .map((r) => Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour))
        .filter((x) => Number.isFinite(x) && x > 0)
        .sort((a, b) => a - b),
    [rowsForBorough]
  );
  const predP85 = useMemo(() => {
    if (!predValues.length) return null;
    const idx = Math.min(predValues.length - 1, Math.floor(predValues.length * 0.85));
    return predValues[idx];
  }, [predValues]);

  const predictedSumScope = useMemo(
    () =>
      rowsForBorough.reduce(
        (acc, r) => acc + Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour ?? 0),
        0
      ),
    [rowsForBorough]
  );

  const avgPressureScope = useMemo(() => {
    const vals = rowsForBorough.map((r) => Number(r.pressure_ratio)).filter(Number.isFinite);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [rowsForBorough]);

  const thresholdCountScope = useMemo(
    () =>
      countPressureThreshold(
        rowsForBorough,
        thresholdMode === "all" ? "all" : thresholdMode === "high" ? "high" : "elevated"
      ),
    [rowsForBorough, thresholdMode]
  );

  const elevated115Full = useMemo(
    () => fullRows.filter((r) => Number(r.pressure_ratio) >= 1.15).length,
    [fullRows]
  );
  const high135Full = useMemo(() => fullRows.filter((r) => Number(r.pressure_ratio) >= 1.35).length, [fullRows]);
  const incidentContextRowsCount = useMemo(() => fullRows.filter((r) => incidentContextActive(r)).length, [fullRows]);

  const peakBoroughPred = useMemo(() => peakBoroughByPredictedSum(fullRows), [fullRows]);
  const peakBoroughAvg = useMemo(() => peakBoroughByAvgPressure(fullRows), [fullRows]);
  const topDemandBoroughDisplay = useMemo(() => {
    if (peakBoroughPred?.name) return peakBoroughPred.name;
    if (peakBoroughAvg?.name) return peakBoroughAvg.name;
    return "—";
  }, [peakBoroughPred, peakBoroughAvg]);

  const boroughConcentration = useMemo(() => boroughDemandConcentration(rowsForBorough), [rowsForBorough]);

  const weatherKpi = useMemo(() => {
    const w = summary.weather_status || fullRows.find((r) => r.weather_category)?.weather_category;
    const temps = fullRows.map((r) => Number(r.temperature)).filter(Number.isFinite);
    const avgT = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    if (w && Number.isFinite(avgT)) return `${w} (~${formatDecimal(avgT, 1)}°C)`;
    if (w) return String(w);
    if (Number.isFinite(avgT)) return `~${formatDecimal(avgT, 1)}°C`;
    return "—";
  }, [summary.weather_status, fullRows]);

  const monitoringPriority = useMemo(
    () =>
      companyOperationalReviewPriority(
        high135Full,
        elevated115Full,
        incidentContextRowsCount,
        fullRows.length
      ),
    [high135Full, elevated115Full, incidentContextRowsCount, fullRows.length]
  );

  const selectedSnapshotTs = summary.timestamp || timestamp || null;

  const cityAtTime = useMemo(
    () => cityRowAtTimestamp(cityTrend ?? [], selectedSnapshotTs),
    [cityTrend, selectedSnapshotTs]
  );

  const cityChartData = useMemo(
    () =>
      (cityTrend ?? []).map((r) => ({
        t: isoToDisplay(r.timestamp, ""),
        ts: r.timestamp,
        observed: Number(r.pickup_count_sum ?? 0),
        predicted: Number(r.predicted_next_hour_sum ?? 0),
        highPressureZones: Number(r.high_pressure_zones ?? 0),
      })),
    [cityTrend]
  );

  const highPressureHourNote = useMemo(() => {
    const n = Number(cityAtTime.row?.high_pressure_zones ?? 0);
    const tsLabel = cityAtTime.resolvedTs
      ? isoToDisplay(cityAtTime.resolvedTs, cityAtTime.resolvedTs)
      : "selected time";
    if (!cityAtTime.row) return "High-pressure zone count not available for this window.";
    const near = cityAtTime.usedNearest ? " (nearest trend hour)" : "";
    return `At ${tsLabel}${near}, about ${formatNumber(n, 0)} zone(s) met the high Pressure Ratio band (≥1.35×) in the city trend export.`;
  }, [cityAtTime]);

  const insightRail = useMemo(
    () => buildCompanyOperationalInsightRail(rowsForBorough, summary, boroughConcentration),
    [rowsForBorough, summary, boroughConcentration]
  );

  const hasHighPredictedZone = useMemo(
    () =>
      rowsForBorough.some((r) => {
        const p = Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour);
        return Number.isFinite(p) && Number.isFinite(predP85) && predP85 != null && p >= predP85;
      }),
    [rowsForBorough, predP85]
  );

  const planningSuggestions = useMemo(
    () =>
      buildCompanyOperationalSuggestions({
        hasHighPredictedZone,
        avgPressureRatio: avgPressureScope ?? NaN,
        elevatedPressureZones: elevated115Full,
        highPressureZones: high135Full,
        incidentContextRows: incidentContextRowsCount,
        dominantBoroughName: boroughConcentration?.name ?? null,
        boroughConcentrationShare: boroughConcentration?.share ?? NaN,
      }),
    [
      hasHighPredictedZone,
      avgPressureScope,
      elevated115Full,
      high135Full,
      incidentContextRowsCount,
      boroughConcentration,
    ]
  );

  const sortedTableRows = useMemo(
    () => [...rowsForBorough].sort(tableSortCompany).map((row, i) => ({ ...row, _rank: i + 1 })),
    [rowsForBorough]
  );

  const highPressureZonesByBoroughChart = useMemo(() => {
    const m = new Map();
    for (const row of rowsForBorough) {
      if (!rowMeetsSelectedPressureThreshold(row, thresholdMode)) continue;
      const b = String(row.borough ?? "").trim();
      if (!b || isUnknownBorough(b)) continue;
      m.set(b, (m.get(b) || 0) + 1);
    }
    const order = boroughOptions.filter((o) => o.value !== "all").map((o) => o.value);
    const seen = new Set();
    const out = [];
    for (const name of order) {
      if (m.has(name)) {
        out.push({ name, count: m.get(name) });
        seen.add(name);
      }
    }
    for (const [name, count] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!seen.has(name)) out.push({ name, count });
    }
    return out;
  }, [rowsForBorough, thresholdMode, boroughOptions]);

  const topPredictedPickupZonesChart = useMemo(
    () =>
      [...rowsForBorough]
        .filter((r) =>
          Number.isFinite(Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour))
        )
        .sort(
          (a, b) =>
            Number(b.predicted_next_hour_pickups ?? b.target_pickup_count_next_hour) -
            Number(a.predicted_next_hour_pickups ?? a.target_pickup_count_next_hour)
        )
        .slice(0, 10)
        .map((r) => ({
          label: String(r.zone_name ?? r.zone_id ?? "—").slice(0, 24),
          pickups: Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour),
        })),
    [rowsForBorough]
  );

  const schematicZones = useMemo(
    () =>
      [...fullRows]
        .filter((r) => r.zone_name || r.zone_id != null)
        .sort((a, b) => Number(b.pressure_ratio) - Number(a.pressure_ratio))
        .slice(0, 96),
    [fullRows]
  );

  const sparklineHighPressure = useMemo(
    () =>
      (cityTrend ?? []).slice(-48).map((r, i) => ({
        i,
        hz: Number(r.high_pressure_zones ?? 0),
      })),
    [cityTrend]
  );

  const featureIncidentByBorough = useMemo(() => {
    const m = new Map();
    for (const r of fullRows) {
      if (isUnknownBorough(r.borough)) continue;
      const b = String(r.borough).trim();
      const v =
        Number(r.zone_incident_count || 0) +
        (Number(r.incident_flag) > 0 ? 1 : 0) +
        (Number(r.road_closure_flag) > 0 ? 1 : 0);
      m.set(b, (m.get(b) || 0) + v);
    }
    return [...m.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [fullRows]);

  const featureSameHourBars = useMemo(() => {
    const sel = selectedSnapshotTs;
    if (!cityTrend?.length || !sel) return [];
    const hour = new Date(sel).getHours();
    const preds = cityTrend
      .filter((r) => Number.isFinite(tsMs(r.timestamp)) && new Date(r.timestamp).getHours() === hour)
      .map((r) => Number(r.predicted_next_hour_sum))
      .filter(Number.isFinite);
    const meanSameHour = preds.length > 0 ? preds.reduce((a, b) => a + b, 0) / preds.length : null;
    const row = cityRowAtTimestamp(cityTrend, sel).row;
    const selectedPred = Number(row?.predicted_next_hour_sum);
    if (!Number.isFinite(selectedPred) && !Number.isFinite(meanSameHour)) return [];
    return [
      { label: "Selected hour", value: Number.isFinite(selectedPred) ? selectedPred : 0 },
      { label: "Same-hour mean (168h)", value: Number.isFinite(meanSameHour) ? meanSameHour : 0 },
    ];
  }, [cityTrend, selectedSnapshotTs]);

  const featureSurgeBars = useMemo(() => {
    const tail = (cityTrend ?? []).slice(-24);
    return tail.map((r, i) => ({
      i,
      pred: Number(r.predicted_next_hour_sum ?? 0),
    }));
  }, [cityTrend]);

  const featureWatchlist = useMemo(() => {
    return [...rowsForBorough]
      .filter((r) => Number.isFinite(Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour)))
      .sort(
        (a, b) =>
          Number(b.predicted_next_hour_pickups ?? b.target_pickup_count_next_hour) -
          Number(a.predicted_next_hour_pickups ?? a.target_pickup_count_next_hour)
      )
      .slice(0, 6)
      .map((r) => ({
        name: String(r.zone_name ?? r.zone_id).slice(0, 14),
        value: Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour),
      }));
  }, [rowsForBorough]);

  const featureBoroughPred = useMemo(() => {
    const m = new Map();
    for (const r of fullRows) {
      if (isUnknownBorough(r.borough)) continue;
      const b = String(r.borough).trim();
      const p = Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour);
      if (!Number.isFinite(p)) continue;
      m.set(b, (m.get(b) || 0) + p);
    }
    return [...m.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [fullRows]);

  const featureBoroughPressureMini = useMemo(() => {
    const by = {};
    for (const r of fullRows) {
      if (isUnknownBorough(r.borough)) continue;
      const b = String(r.borough).trim();
      const pr = Number(r.pressure_ratio);
      if (!Number.isFinite(pr)) continue;
      if (!by[b]) by[b] = { sum: 0, n: 0 };
      by[b].sum += pr;
      by[b].n += 1;
    }
    return Object.entries(by)
      .map(([name, agg]) => ({ name, ratio: agg.sum / agg.n }))
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 6);
  }, [fullRows]);

  const featureWeatherBars = useMemo(() => {
    const prec = fullRows.map((r) => Number(r.precipitation)).filter(Number.isFinite);
    const avgP = prec.length ? prec.reduce((a, b) => a + b, 0) / prec.length : null;
    const temps = fullRows.map((r) => Number(r.temperature)).filter(Number.isFinite);
    const avgT = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    const out = [];
    if (Number.isFinite(avgP)) out.push({ name: "Avg precip.", value: Math.max(0, avgP) });
    if (Number.isFinite(avgT)) out.push({ name: "Avg temp (°C)", value: Math.max(0, avgT + 20) });
    return out;
  }, [fullRows]);

  const mapMetricLabel = MAP_METRIC_OPTIONS.find((o) => o.value === mapMetric)?.label ?? mapMetric;
  const mapBoroughLabel = boroughOptions.find((o) => o.value === boroughFilter)?.label ?? boroughFilter;
  const mapModelLabel = model || summary.model || "—";
  const mapTimestampLabel = timestamp ? isoToDisplay(timestamp, timestamp) : "—";

  const showBlocking = apiOnline === null || (loading && snapshot == null);
  const sectionBusy = loading && snapshot != null;
  const mapSnapshotLoading = loading && !snapshot;

  const headerSubtitle =
    "Company-facing operational view for predicted pickup demand, zone pressure, and context-aware planning.";

  const headerFooter = (
    <>
      <p className="max-w-[56rem] text-sm leading-relaxed text-brand-text">
        This view helps ride-hailing companies review predicted pickup-demand patterns across TLC zones, identify areas with
        elevated demand pressure, and use incident/weather context to support operational planning. It does not use live driver
        availability or directly measure passenger waiting time.
      </p>
      <p className="text-xs font-medium text-brand-muted">
        Demand monitoring and coverage review only — not direct dispatch or supply controls.
      </p>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader showTitleStatusDot title="Ride-Hailing Companies View" subtitle={headerSubtitle} footer={headerFooter}>
        <div className="[&_button]:px-2.5 [&_button]:py-1.5 [&_button]:text-xs">
          <GlassButton
            variant="secondary"
            onClick={() => {
              refreshHealth?.({ forceRefresh: true });
              load({ forceRefresh: true });
            }}
          >
            <RefreshCcw size={14} strokeWidth={1.75} />
            Update view
          </GlassButton>
        </div>
      </PageHeader>

      <div className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <SelectField
            label="Snapshot time"
            value={timestamp}
            onChange={setTimestamp}
            options={(timestamps ?? []).map((t) => ({ value: t, label: isoToDisplay(t, t) }))}
            placeholder={timestamps.length ? "Select time" : "Loading…"}
          />
          {models.length ? (
            <SelectField label="Model" value={model} onChange={setModel} options={models.map((m) => ({ value: m, label: m }))} />
          ) : (
            <div className="text-xs text-brand-muted">Model list loading…</div>
          )}
          <SelectField label="Borough" value={boroughFilter} onChange={setBoroughFilter} options={boroughOptions} />
          <SelectField
            label="Pressure threshold"
            value={thresholdMode}
            onChange={setThresholdMode}
            options={THRESHOLD_OPTIONS}
          />
        </div>
      </div>

      {showBlocking ? (
        <div className="rounded-xl border border-brand-border bg-white px-4 py-3 text-sm text-brand-muted shadow-card">
          <div className="h-4 w-48 animate-pulse rounded bg-brand-mint/60" />
        </div>
      ) : null}

      {!showBlocking && (fetchErrors.snapshot || fetchErrors.city) ? (
        <div className="space-y-1 text-xs text-rose-600">
          {fetchErrors.snapshot ? <p>Snapshot: {fetchErrors.snapshot}</p> : null}
          {fetchErrors.city ? <p>City trend: {fetchErrors.city}</p> : null}
        </div>
      ) : null}

      {sectionBusy ? <p className="text-xs font-semibold text-brand-muted">Updating…</p> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          icon={BarChart3}
          accent="teal"
          label="Predicted Pickup Demand"
          value={formatNumber(predictedSumScope, 0)}
          subtext="Predicted pickup-demand indicator for the selected operational view."
        />
        <KpiCard
          icon={Gauge}
          accent={thresholdMode === "high" ? "danger" : "warn"}
          label="Elevated Pressure Zones"
          value={formatNumber(thresholdCountScope, 0)}
          subtext={
            thresholdMode === "high" || thresholdMode === "elevated"
              ? "Zones where predicted demand is above the recent zone baseline."
              : "All zones with a valid Pressure Ratio in the selected scope."
          }
        />
        <KpiCard
          icon={MapPinned}
          accent="neutral"
          label="Top Demand Borough"
          value={topDemandBoroughDisplay}
          subtext="Borough requiring closer operational review."
        />
        <KpiCard
          icon={AlertTriangle}
          accent={incidentContextRowsCount > 0 ? "warn" : "neutral"}
          label="Incident / Event Context"
          value={formatNumber(incidentContextRowsCount, 0)}
          subtext="Context indicators that may affect pickup-demand patterns."
        />
        <KpiCard
          icon={Cloud}
          accent="neutral"
          label="Weather Context"
          value={weatherKpi}
          subtext="Weather condition associated with the selected snapshot."
        />
        <KpiCard
          icon={ShieldAlert}
          accent={monitoringPriority === "High" ? "danger" : monitoringPriority === "Elevated" ? "warn" : "neutral"}
          label="Operational Review Priority"
          value={monitoringPriority}
          subtext="Summary indicator for operational monitoring."
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] xl:items-stretch">
        <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-brand-border bg-white shadow-card xl:min-h-[620px]">
          <div className="flex flex-shrink-0 flex-col gap-3 border-b border-brand-border px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-brand-text">Operational Demand Map</h3>
              <p className="mt-1 text-xs leading-relaxed text-brand-muted">
                Zone colors show predicted pickup demand, pressure ratio, or incident-context indicator for the selected snapshot.
              </p>
              <p className="mt-1.5 text-xs leading-snug text-brand-text">
                Map view: {mapMetricLabel} • {mapBoroughLabel} • {mapModelLabel} • {mapTimestampLabel}
              </p>
              <p className="mt-1 text-[11px] text-brand-muted">Changing Map Metric updates zone colors only.</p>
            </div>
            <div className="shrink-0 rounded-lg border border-brand-border/80 bg-brand-mint/15 px-3 py-2 sm:w-[min(100%,220px)]">
              <SelectField label="Map metric" value={mapMetric} onChange={setMapMetric} options={MAP_METRIC_OPTIONS} />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-4">
            {sectionBusy ? <div className="mb-3 h-24 flex-shrink-0 animate-pulse rounded-lg bg-brand-mint/40" /> : null}
            {fetchErrors.snapshot ? (
              <p className="mb-3 flex-shrink-0 text-xs text-rose-600">Could not load snapshot for this selection.</p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto">
              {geoJson?.features?.length ? (
                <TlcZoneMap
                  geojson={geoJson}
                  rows={fullRows}
                  mapMetric={mapMetric}
                  loading={geoLoading || mapSnapshotLoading}
                  highlightBorough={boroughFilter === "all" ? null : boroughFilter}
                  legendFooter="Use the map to review where predicted demand or demand pressure is concentrated before making operational planning decisions."
                />
              ) : geoLoading ? (
                <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed border-brand-border bg-brand-mint/20 text-sm font-medium text-brand-muted">
                  Loading TLC zone map…
                </div>
              ) : (
                <div className="space-y-3">
                  {geoError && apiOnline === true ? <p className="text-xs text-brand-muted">Detail: {geoError}</p> : null}
                  <TlcZoneMap geojson={null} rows={fullRows} mapMetric={mapMetric} loading={false} />
                  <div className="grid max-h-[min(320px,45vh)] auto-rows-fr grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-1 overflow-auto rounded-xl border border-brand-border bg-brand-bg/50 p-2">
                    {schematicZones.length === 0 ? (
                      <div className="col-span-full flex min-h-[120px] items-center justify-center text-sm text-brand-muted">
                        No zone rows for this selection.
                      </div>
                    ) : (
                      schematicZones.map((row, idx) => {
                        const ratio = row.pressure_ratio ?? row.observed_pressure_ratio;
                        const pred = row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour;
                        return (
                          <div
                            key={`${row.zone_id}-${idx}`}
                            className={`flex min-h-[48px] flex-col justify-center rounded border px-1.5 py-1 text-[10px] leading-tight ${schematicCellClass(ratio)}`}
                            title={`${row.zone_name ?? ""} · ${formatRatio(ratio)}`}
                          >
                            <div className="truncate font-semibold">{row.zone_name ?? row.zone_id}</div>
                            <div className="opacity-90">{formatRatio(ratio)}</div>
                            <div className="opacity-90">{formatNumber(pred, 0)} pred.</div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col gap-3 xl:min-h-[620px]">
          <div className="flex-shrink-0 rounded-xl border border-brand-border bg-gradient-to-br from-brand-mint/40 to-white px-4 py-3 shadow-card">
            <h3 className="text-sm font-semibold text-brand-text">Company Operational Insights</h3>
            <p className="mt-1 text-[11px] leading-snug text-brand-muted">
              Company-side demand monitoring — not passenger waiting-time measurement or live coverage telemetry.
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex flex-col gap-3 pb-1">
              {insightRail.map((card, idx) => (
                <div
                  key={`${card.title}-${idx}`}
                  className="rounded-xl border border-brand-border bg-white p-4 shadow-card transition-shadow hover:shadow-soft"
                >
                  <div className="text-[11px] font-bold uppercase tracking-wide text-brand-primary">{card.title}</div>
                  <p className="mt-2 text-[13px] leading-relaxed text-brand-muted">{card.body}</p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <SectionCard
        title="Pickup Demand Trend"
        subtitle="Hourly observed and predicted pickup-demand indicators across the selected monitoring window."
      >
        {fetchErrors.city ? <p className="mb-2 text-xs text-rose-600">{fetchErrors.city}</p> : null}
        {sectionBusy && !cityChartData.length ? <div className="mb-2 h-40 animate-pulse rounded-lg bg-brand-mint/40" /> : null}
        <div className="h-80 w-full min-w-0">
          {cityChartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cityChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatNumber(v, 0)} />
                <Tooltip
                  formatter={(value, name) => [formatNumber(value, 0), name]}
                  labelFormatter={(l) => l}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="observed" name="Observed pickups" stroke="#0f766e" dot={false} strokeWidth={2} />
                <Line
                  type="monotone"
                  dataKey="predicted"
                  name="Predicted next-hour pickups"
                  stroke="#B42318"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            !sectionBusy && <p className="text-sm text-brand-muted">No city trend rows for this 168-hour window.</p>
          )}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-brand-border bg-brand-mint/15 px-3 py-2 text-xs leading-relaxed text-brand-text">
            {highPressureHourNote}
          </div>
          <div className="rounded-lg border border-brand-border bg-white px-3 py-2 text-xs text-brand-muted">
            Current export indicator: trend series length {formatNumber(cityChartData.length, 0)} hour(s). Chart uses the full
            168-hour request window when data is available.
          </div>
        </div>
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard
          title="High-Pressure Zones by Borough"
          subtitle="Counts zones exceeding the selected demand-pressure threshold."
        >
          <p className="mb-2 text-xs text-brand-muted">
            For operational planning and coverage review: monitor how demand-pressure counts concentrate by borough for the
            selected snapshot and threshold.
          </p>
          <div className="h-64 w-full min-w-0">
            {highPressureZonesByBoroughChart.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={highPressureZonesByBoroughChart} margin={{ top: 8, right: 8, left: 0, bottom: 52 }}>
                  <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-22} textAnchor="end" height={52} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip formatter={(v) => [formatNumber(v, 0), "Zones"]} />
                  <Bar dataKey="count" fill="#00856f" radius={[4, 4, 0, 0]} name="Zone count" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-brand-muted">No zones match the selected threshold in this view.</p>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Top Predicted Pickup Zones"
          subtitle="Highest predicted pickup-demand indicators for company-side review."
        >
          <p className="mb-2 text-xs text-brand-muted">
            Zone prioritization from the current export — use alongside the priority table for monitoring and operational review.
          </p>
          <div className="h-64 w-full min-w-0">
            {topPredictedPickupZonesChart.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topPredictedPickupZonesChart} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => formatNumber(v, 0)} />
                  <YAxis type="category" dataKey="label" width={108} tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v) => [formatNumber(v, 0), "Predicted pickups"]} />
                  <Bar dataKey="pickups" fill="#0f766e" radius={[0, 4, 4, 0]} name="Predicted next hour" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-brand-muted">No predicted pickup values in this view.</p>
            )}
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Operational Priority Zones"
        subtitle="Zones ranked for company-side demand review using predicted pickups, pressure ratio, and context indicators."
      >
        <DataTable
          columns={[
            { key: "_rank", label: "Rank", render: (v) => String(v ?? "—") },
            { key: "zone_name", label: "Zone", render: (v) => v ?? "—" },
            { key: "borough", label: "Borough", render: (v) => v ?? "—" },
            {
              key: "predicted_next_hour_pickups",
              label: "Predicted Pickups",
              render: (_, row) => formatNumber(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour, 0),
            },
            { key: "pressure_ratio", label: "Pressure Ratio", render: (v) => formatRatio(v) },
            {
              key: "pressure_label",
              label: "Pressure Label",
              render: (_, row) => row.pressure_label ?? pressureTierLabel(Number(row.pressure_ratio)),
            },
            {
              key: "_inc",
              label: "Incident Context",
              render: (_, row) => summarizeIncidentContext(row),
            },
            {
              key: "_note",
              label: "Planning Note",
              render: (_, row) => companyPlanningNoteForRow(row, predP85),
            },
          ]}
          rows={sortedTableRows}
          maxRows={24}
        />
      </SectionCard>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-brand-text">How to Read This View</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            {
              title: "Predicted Pickups",
              body: "Predicted next-hour TLC pickup demand for the selected zone and timestamp.",
            },
            {
              title: "Pressure Ratio",
              body: "Pressure Ratio compares predicted next-hour pickups with the recent 24-hour baseline for the same TLC zone.",
            },
            {
              title: "Demand-Pressure Indicator",
              body: "An indirect indicator showing whether predicted demand is higher than usual for that zone.",
            },
            {
              title: "Context Indicators",
              body: "Weather, incident, event, or disruption indicators that help interpret demand patterns.",
            },
          ].map((c) => (
            <div key={c.title} className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
              <h3 className="text-sm font-semibold text-brand-text">{c.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-brand-muted">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <SectionCard title="Operational Planning Suggestions" subtitle="Dynamic prompts from current export indicators.">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-brand-muted">
          {planningSuggestions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </SectionCard>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-brand-text">Potential Live Company Operations Features</h2>
        <p className="max-w-[56rem] text-xs leading-relaxed text-brand-muted">
          Illustrative operational concepts using the current export as an available data indicator — not live feeds. Charts
          summarize fields already on this page. This is a future operational concept layer, not part of the current exported
          dataset beyond pickup, weather, and incident-context features.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Live Demand Surge Monitoring</div>
            <p className="mt-1 text-[10px] text-brand-muted">Illustrative concept · recent predicted pickups (city trend)</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureSurgeBars.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={featureSurgeBars} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9 }} width={28} tickFormatter={(v) => formatNumber(v, 0)} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Area type="monotone" dataKey="pred" stroke="#00856f" fill="#99f6e4" strokeWidth={1.2} name="Predicted sum" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No trend points.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Live operational data could highlight zones with rising pickup-demand indicators.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Same-Hour Demand Comparison</div>
            <p className="mt-1 text-[10px] text-brand-muted">Current export indicator · selected hour vs same-hour mean</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureSameHourBars.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureSameHourBars} layout="vertical" margin={{ left: 4, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={(v) => formatNumber(v, 0)} />
                    <YAxis type="category" dataKey="label" width={118} tick={{ fontSize: 8 }} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#0f766e" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">Insufficient rows for comparison.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Compare current demand with similar historical hours for planning review.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Zone Watchlist</div>
            <p className="mt-1 text-[10px] text-brand-muted">Available data indicator · top zones by predicted pickups</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureWatchlist.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureWatchlist} layout="vertical" margin={{ left: 4, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis type="number" tick={{ fontSize: 9 }} />
                    <YAxis type="category" dataKey="name" width={72} tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#F7B731" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No zone predictions in scope.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Prioritize review of zones with high predicted pickup demand.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Context-Aware Operations</div>
            <p className="mt-1 text-[10px] text-brand-muted">Current export indicator · context counts by borough</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureIncidentByBorough.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureIncidentByBorough} margin={{ top: 4, right: 4, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 9 }} width={22} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#00856f" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No context fields in slice.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Incident and weather indicators help interpret abnormal demand patterns.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Repeated Pressure Patterns</div>
            <p className="mt-1 text-[10px] text-brand-muted">Available data indicator · high-pressure zone count (recent hours)</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {sparklineHighPressure.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={sparklineHighPressure} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9 }} width={22} />
                    <Tooltip formatter={(v) => [formatNumber(v, 0), "Zones ≥1.35×"]} />
                    <Area type="monotone" dataKey="hz" stroke="#B42318" fill="#fecaca" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No trend points.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Repeated elevated pressure can guide operational monitoring across similar windows.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Borough Demand Balance</div>
            <p className="mt-1 text-[10px] text-brand-muted">Current export indicator · predicted pickups by borough</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureBoroughPred.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureBoroughPred} margin={{ top: 4, right: 4, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 9 }} width={28} tickFormatter={(v) => formatNumber(v, 0)} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#14b8a6" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No borough totals.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Compare demand concentration across boroughs for broader coverage review.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Weather snapshot strip</div>
            <p className="mt-1 text-[10px] text-brand-muted">Not live feed · mean precip / scaled temperature from export</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureWeatherBars.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureWeatherBars} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                    <YAxis tick={{ fontSize: 9 }} width={28} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#38bdf8" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">Weather fields sparse.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              {weatherKpi !== "—" ? `Summary: ${weatherKpi}. ` : ""}
              Weather context supports interpretation of pickup-demand indicators in this export.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Avg Pressure by Borough</div>
            <p className="mt-1 text-[10px] text-brand-muted">Illustrative concept · snapshot mean Pressure Ratio</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureBoroughPressureMini.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureBoroughPressureMini} margin={{ top: 4, right: 4, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 9 }} width={22} tickFormatter={(v) => `${formatDecimal(v, 1)}×`} />
                    <Tooltip formatter={(v) => formatDecimal(v, 2)} />
                    <Bar dataKey="ratio" fill="#F7B731" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No averages.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Borough averages help compare relative demand-pressure indicators for planning review.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Supply-Demand Coverage Review</div>
            <p className="mt-1 text-[10px] text-brand-muted">Future concept · chart shows demand side only (current export)</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureBoroughPred.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureBoroughPred} margin={{ top: 4, right: 4, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0} angle={-25} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 9 }} width={26} tickFormatter={(v) => formatNumber(v, 0)} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#94a3b8" radius={[3, 3, 0, 0]} name="Predicted pickups (export)" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No borough totals in export for this view.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              With real-time company supply data, this view could compare predicted pickup demand with available coverage by zone
              for supply-demand visibility. This is a future operational concept, not part of the current exported dataset.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Driver Availability Layer</div>
            <p className="mt-1 text-[10px] text-brand-muted">Future concept · illustrative mini-map of demand only</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureWatchlist.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureWatchlist.map((d, i) => ({ ...d, shade: i }))} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" hide />
                    <YAxis tick={{ fontSize: 9 }} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                      {featureWatchlist.map((_, i) => (
                        <Cell key={i} fill={i % 2 === 0 ? "#cbd5e1" : "#e2e8f0"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No zones to illustrate.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Future company integration could add live driver availability indicators to support coverage review. If real-time
              company operations data becomes available, this layer could pair with predicted demand for operational planning.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Repositioning Opportunity Indicator</div>
            <p className="mt-1 text-[10px] text-brand-muted">Future concept · demand slope vs flat illustrative baseline</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureSurgeBars.length > 4 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={featureSurgeBars.map((d, i) => ({
                      i,
                      demand: d.pred,
                      baseline: featureSurgeBars[0]?.pred * 0.95 || 0,
                    }))}
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9 }} width={28} tickFormatter={(v) => formatNumber(v, 0)} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Line type="monotone" dataKey="demand" stroke="#B42318" dot={false} strokeWidth={2} name="Demand indicator" />
                    <Line type="monotone" dataKey="baseline" stroke="#94a3b8" dot={false} strokeDasharray="4 4" name="Illustrative baseline" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">Need more trend hours.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              If live operations data is available, the system could highlight windows where demand is rising faster than an
              illustrative static baseline — for coverage review only, not dispatch actions.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
