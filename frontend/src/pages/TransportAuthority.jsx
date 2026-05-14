import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw, Cloud, Gauge, MapPinned, ShieldAlert, AlertTriangle, Scale } from "lucide-react";
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
import AuthorityAlerts from "../components/AuthorityAlerts";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import SelectField from "../components/SelectField";
import GlassButton from "../components/GlassButton";
import DataTable from "../components/DataTable";
import TlcZoneMap from "../components/TlcZoneMap";
import {
  getDashboardSnapshot,
  getBoroughTrend,
  getCityTrend,
  getTimestamps,
  getModels,
  getTaxiZonesGeoJson,
  apiUrl,
  peekCachedApiUrl,
} from "../lib/api";
import { formatDecimal, formatNumber, formatRatio, isoToDisplay, pressureTierLabel } from "../lib/format";
import {
  buildAuthorityRegulatoryRail,
  buildAuthorityMonitoringRecommendations,
  incidentContextActive,
  summarizeIncidentContext,
} from "../lib/insights";
import { useStakeholderRole } from "../context/StakeholderRoleContext";
import { ROLE } from "../lib/roleAccess";

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

/** Borough-trend rows for exact snapshot time, or nearest timestamp at or before selected (sorted ascending). */
function boroughSliceAtTimestamp(rows, selectedTimestamp) {
  if (!rows?.length) {
    return { slice: [], resolvedTs: null, usedNearest: false };
  }
  if (!selectedTimestamp) {
    const stamps = [...new Set(rows.map((r) => r.timestamp).filter(Boolean))].sort((a, b) => tsMs(a) - tsMs(b));
    const last = stamps.at(-1);
    return { slice: last ? rows.filter((r) => r.timestamp === last) : [], resolvedTs: last ?? null, usedNearest: false };
  }
  const stamps = [...new Set(rows.map((r) => r.timestamp).filter(Boolean))].sort((a, b) => tsMs(a) - tsMs(b));
  const target = tsMs(selectedTimestamp);
  if (!Number.isFinite(target)) {
    const last = stamps.at(-1);
    return { slice: last ? rows.filter((r) => r.timestamp === last) : [], resolvedTs: last ?? null, usedNearest: true };
  }
  const exact = stamps.find((s) => tsMs(s) === target);
  if (exact) return { slice: rows.filter((r) => r.timestamp === exact), resolvedTs: exact, usedNearest: false };
  let chosen = null;
  for (let i = stamps.length - 1; i >= 0; i--) {
    if (tsMs(stamps[i]) <= target) {
      chosen = stamps[i];
      break;
    }
  }
  if (!chosen) chosen = stamps[0];
  return { slice: rows.filter((r) => r.timestamp === chosen), resolvedTs: chosen, usedNearest: true };
}

/** City-trend row for snapshot hour or nearest at/before. */
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

function latestBoroughSlice(rows) {
  const stamps = [...new Set(rows.map((r) => r.timestamp).filter(Boolean))].sort((a, b) => tsMs(a) - tsMs(b));
  const last = stamps.at(-1);
  if (!last) return [];
  return rows.filter((r) => r.timestamp === last);
}

function boroughAvgRatio(row) {
  return Number(row.average_pressure_ratio ?? row.avg_pressure_ratio ?? 0);
}

function dominantPeakBoroughFromTrend(boroughRows) {
  const stamps = [...new Set(boroughRows.map((r) => r.timestamp).filter(Boolean))].sort().slice(-48);
  const votes = {};
  for (const t of stamps) {
    const slice = boroughRows.filter((r) => r.timestamp === t && !isUnknownBorough(r.borough));
    let best = null;
    let bestR = -Infinity;
    for (const r of slice) {
      const br = String(r.borough).trim();
      const ratio = boroughAvgRatio(r);
      if (!Number.isFinite(ratio)) continue;
      if (ratio > bestR) {
        bestR = ratio;
        best = br;
      }
    }
    if (best) votes[best] = (votes[best] || 0) + 1;
  }
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function countPressureThreshold(rows, mode) {
  if (mode === "high") return rows.filter((r) => Number(r.pressure_ratio) >= 1.35).length;
  if (mode === "elevated") return rows.filter((r) => Number(r.pressure_ratio) >= 1.15).length;
  return rows.filter((r) => Number.isFinite(Number(r.pressure_ratio))).length;
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

function peakBoroughStressFromSlice(slice) {
  let best = null;
  let bestR = -Infinity;
  for (const r of slice) {
    if (isUnknownBorough(r.borough)) continue;
    const br = String(r.borough).trim();
    const ratio = boroughAvgRatio(r);
    if (!Number.isFinite(ratio)) continue;
    if (ratio > bestR) {
      bestR = ratio;
      best = br;
    }
  }
  return best && Number.isFinite(bestR) ? { name: best, ratio: bestR } : null;
}

function regulatoryMonitoringPriority(high135Count, incidentCtxCount, zoneCount) {
  const n = Math.max(1, zoneCount);
  const hpShare = high135Count / n;
  if (high135Count >= 15 && incidentCtxCount >= 6) return "High";
  if (hpShare >= 0.12 && incidentCtxCount >= 4) return "High";
  if (high135Count >= 5 || incidentCtxCount >= 5) return "Elevated";
  if (high135Count >= 1 || incidentCtxCount >= 2) return "Moderate";
  return "Low";
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

/** Authority table: predicted pickups first, then pressure, then incident/disruption context. */
function tableSortAuthority(a, b) {
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

function monitoringNoteForRow(row, predThreshold) {
  if (incidentContextActive(row)) return "Review due to active incident context.";
  const r = Number(row.pressure_ratio ?? row.observed_pressure_ratio);
  if (Number.isFinite(r) && r >= 1.35) return "Monitor elevated demand pressure.";
  if (Number.isFinite(r) && r >= 1.15) return "Monitor elevated demand pressure.";
  const pred = Number(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour);
  if (Number.isFinite(pred) && Number.isFinite(predThreshold) && pred >= predThreshold) {
    return "High predicted pickup demand.";
  }
  return "Typical pressure; no immediate monitoring flag.";
}

function schematicCellClass(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return "bg-slate-100/90 border-slate-200 text-brand-muted";
  if (r >= 1.35) return "bg-gradient-to-br from-rose-400/95 to-brand-critical border-rose-500/35 text-white";
  if (r >= 1.15) return "bg-amber-200/95 border-amber-400/50 text-amber-950";
  if (r >= 0.85) return "bg-emerald-200/80 border-emerald-400/35 text-brand-text";
  return "bg-brand-mint/80 border-teal-200/60 text-brand-deep";
}

export default function TransportAuthority({ overview, refreshHealth, apiOnline }) {
  const stakeholder = useStakeholderRole();
  const showRegulatoryAlerts = stakeholder?.role === ROLE.TRANSPORT_AUTHORITY;

  const [timestamps, setTimestamps] = useState([]);
  const [models, setModels] = useState([]);
  const [timestamp, setTimestamp] = useState("");
  const [model, setModel] = useState("");
  const [boroughFilter, setBoroughFilter] = useState("all");
  const [mapMetric, setMapMetric] = useState("ratio");
  const [thresholdMode, setThresholdMode] = useState("elevated");
  const [snapshot, setSnapshot] = useState(null);
  const [boroughTrend, setBoroughTrend] = useState([]);
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
    const borPeek = peekCachedApiUrl(apiUrl(`borough/trend?${trendParams}`));
    if (borPeek?.ok && Array.isArray(borPeek.data?.rows)) {
      setBoroughTrend(borPeek.data.rows);
    }
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
      else console.warn(`${LOG} transport timestamps:`, tsRes.error);
      if (gm.ok === false) {
        console.warn(`${LOG} transport models:`, gm.error);
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
        const [sn, bor, ct] = await Promise.all([
          getDashboardSnapshot({
            timestamp: timestamp || undefined,
            model: modelArg,
            allowStaticFallback,
            forceRefresh,
          }),
          getBoroughTrend({ hours: 168, model: modelArg, allowStaticFallback, forceRefresh }),
          getCityTrend({ hours: 168, model: modelArg, allowStaticFallback, forceRefresh }),
        ]);
        setFetchErrors((prev) => {
          const n = { ...prev };
          const touch = (key, res) => {
            if (res.ok === false) {
              console.warn(`${LOG} transport [${key}]:`, res.error);
              n[key] = res.error || "Failed";
            } else delete n[key];
          };
          touch("snapshot", sn);
          touch("borough", bor);
          touch("city", ct);
          return n;
        });
        if (sn.ok !== false) setSnapshot(sn.data);
        if (bor.ok !== false) setBoroughTrend(bor.rows ?? []);
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

  /** API returns timestamps newest-first; default = latest. */
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
      fullRows
        .map((r) => Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour))
        .filter((x) => Number.isFinite(x) && x > 0)
        .sort((a, b) => a - b),
    [fullRows]
  );
  const predP85 = useMemo(() => {
    if (!predValues.length) return null;
    const idx = Math.min(predValues.length - 1, Math.floor(predValues.length * 0.85));
    return predValues[idx];
  }, [predValues]);

  const highPressure135Full = useMemo(
    () => fullRows.filter((r) => Number(r.pressure_ratio) >= 1.35).length,
    [fullRows]
  );
  const incidentContextRowsCount = useMemo(() => fullRows.filter((r) => incidentContextActive(r)).length, [fullRows]);

  const thresholdCountScope = useMemo(
    () => countPressureThreshold(rowsForBorough, thresholdMode === "all" ? "all" : thresholdMode === "high" ? "high" : "elevated"),
    [rowsForBorough, thresholdMode]
  );

  const peakBoroughAvg = useMemo(() => peakBoroughByAvgPressure(fullRows), [fullRows]);

  const selectedSnapshotTs = summary.timestamp || timestamp || null;

  const boroughTimeContext = useMemo(
    () => boroughSliceAtTimestamp(boroughTrend, selectedSnapshotTs),
    [boroughTrend, selectedSnapshotTs]
  );

  const peakBoroughStress = useMemo(
    () => peakBoroughStressFromSlice(boroughTimeContext.slice),
    [boroughTimeContext]
  );
  const boroughDominant = useMemo(() => dominantPeakBoroughFromTrend(boroughTrend), [boroughTrend]);

  const citywidePredicted = Number(summary.citywide_predicted_next_hour_pickups ?? 0);

  const monitoringPriority = useMemo(
    () => regulatoryMonitoringPriority(highPressure135Full, incidentContextRowsCount, fullRows.length),
    [highPressure135Full, incidentContextRowsCount, fullRows.length]
  );

  const boroughBars = useMemo(() => {
    const slice = boroughTimeContext.slice;
    return slice
      .filter((r) => !isUnknownBorough(r.borough))
      .map((r) => ({
        name: String(r.borough).trim(),
        ratio: boroughAvgRatio(r),
      }))
      .sort((a, b) => b.ratio - a.ratio);
  }, [boroughTimeContext]);

  const peakBarName = boroughBars.length ? boroughBars[0].name : null;

  const boroughChartFootnote = useMemo(() => {
    if (!boroughTimeContext.resolvedTs) return "Borough averages from trend export (no row for selected monitoring time).";
    const tsDisp = isoToDisplay(boroughTimeContext.resolvedTs, boroughTimeContext.resolvedTs);
    if (boroughTimeContext.usedNearest) {
      return `Using nearest borough-trend hour at or before selected monitoring time (${tsDisp}).`;
    }
    return `Borough averages for the selected snapshot hour (${tsDisp}).`;
  }, [boroughTimeContext]);

  const cityChartData = useMemo(
    () =>
      (cityTrend ?? []).map((r) => ({
        t: isoToDisplay(r.timestamp, ""),
        ts: r.timestamp,
        observed: Number(r.pickup_count_sum ?? 0),
        predicted: Number(r.predicted_next_hour_sum ?? 0),
        highPressureZones: Number(r.high_pressure_zones ?? 0),
        avgPressure: Number(r.average_pressure_ratio ?? 0),
      })),
    [cityTrend]
  );

  const cityAtTime = useMemo(
    () => cityRowAtTimestamp(cityTrend ?? [], selectedSnapshotTs),
    [cityTrend, selectedSnapshotTs]
  );

  const highPressureRegulatoryNote = useMemo(() => {
    const n = Number(cityAtTime.row?.high_pressure_zones ?? 0);
    const tsLabel = cityAtTime.resolvedTs
      ? isoToDisplay(cityAtTime.resolvedTs, cityAtTime.resolvedTs)
      : "the selected monitoring time";
    if (!cityAtTime.row) {
      return "Citywide high-pressure zone counts are not available for this monitoring window — check city trend data.";
    }
    const near = cityAtTime.usedNearest ? " (nearest available hour in the trend export)" : "";
    if (n === 0) {
      return `At ${tsLabel}${near}, no TLC zones exceeded the high-pressure monitoring threshold (pressure ratio ≥ 1.35×). This supports routine planning review unless other context signals change.`;
    }
    return `At ${tsLabel}${near}, ${formatNumber(n, 0)} TLC zone(s) exceeded the high-pressure monitoring threshold (pressure ratio ≥ 1.35×). Review these patterns alongside borough stress and incident context for oversight planning.`;
  }, [cityAtTime]);

  const sparklineHighPressure = useMemo(
    () =>
      (cityTrend ?? []).slice(-48).map((r, i) => ({
        i,
        hz: Number(r.high_pressure_zones ?? 0),
      })),
    [cityTrend]
  );

  /** Illustrative widgets: derived from current export / snapshot only. */
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

  const featureDisruptionByBorough = useMemo(() => {
    const m = new Map();
    for (const r of fullRows) {
      if (isUnknownBorough(r.borough)) continue;
      const b = String(r.borough).trim();
      const v = Number(r.disruption_score || 0) + (Number(r.event_flag) > 0 || Number(r.event_active) > 0 ? 0.5 : 0);
      m.set(b, (m.get(b) || 0) + v);
    }
    return [...m.entries()]
      .map(([name, value]) => ({ name, value: Math.round(value * 10) / 10 }))
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
    const meanSameHour =
      preds.length > 0 ? preds.reduce((a, b) => a + b, 0) / preds.length : null;
    const row = cityRowAtTimestamp(cityTrend, sel).row;
    const selectedPred = Number(row?.predicted_next_hour_sum);
    if (!Number.isFinite(selectedPred) && !Number.isFinite(meanSameHour)) return [];
    return [
      { label: "Selected hour", value: Number.isFinite(selectedPred) ? selectedPred : 0 },
      {
        label: "Same-hour mean (168h window)",
        value: Number.isFinite(meanSameHour) ? meanSameHour : 0,
      },
    ];
  }, [cityTrend, selectedSnapshotTs]);

  const featureBoroughPressureMini = useMemo(() => boroughBars.slice(0, 6), [boroughBars]);

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

  const weatherKpi = useMemo(() => {
    const w = summary.weather_status || fullRows.find((r) => r.weather_category)?.weather_category;
    const temps = fullRows.map((r) => Number(r.temperature)).filter(Number.isFinite);
    const avgT = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    if (w && Number.isFinite(avgT)) return `${w} (~${formatDecimal(avgT, 1)}°C)`;
    if (w) return String(w);
    if (Number.isFinite(avgT)) return `~${formatDecimal(avgT, 1)}°C`;
    return "—";
  }, [summary.weather_status, fullRows]);

  const insightRail = useMemo(
    () => buildAuthorityRegulatoryRail(rowsForBorough, summary, "ratio", peakBoroughStress),
    [rowsForBorough, summary, peakBoroughStress]
  );

  const recommendations = useMemo(
    () =>
      buildAuthorityMonitoringRecommendations({
        highPressureCount: highPressure135Full,
        incidentContextRows: incidentContextRowsCount,
        peakBoroughName: peakBoroughAvg?.name ?? null,
        boroughTrendDominant: boroughDominant,
        weatherPresent: Boolean(summary.weather_status || fullRows.some((r) => r.weather_category)),
      }),
    [highPressure135Full, incidentContextRowsCount, peakBoroughAvg, boroughDominant, summary.weather_status, fullRows]
  );

  const sortedTableRows = useMemo(
    () => [...rowsForBorough].sort(tableSortAuthority).map((row, i) => ({ ...row, _rank: i + 1 })),
    [rowsForBorough]
  );

  const mapSnapshotLoading = loading && !snapshot;

  const schematicZones = useMemo(() => {
    return [...fullRows]
      .filter((r) => r.zone_name || r.zone_id != null)
      .sort((a, b) => Number(b.pressure_ratio) - Number(a.pressure_ratio))
      .slice(0, 96);
  }, [fullRows]);

  const mapMetricLabel = MAP_METRIC_OPTIONS.find((o) => o.value === mapMetric)?.label ?? mapMetric;
  const mapBoroughLabel = boroughOptions.find((o) => o.value === boroughFilter)?.label ?? boroughFilter;
  const mapModelLabel = model || summary.model || "—";
  const mapTimestampLabel = timestamp ? isoToDisplay(timestamp, timestamp) : "—";

  const subtitle =
    "Citywide regulatory monitoring for demand pressure, borough stress, and incident context.";

  const showBlocking = apiOnline === null || (loading && snapshot == null);
  const sectionBusy = loading && snapshot != null;

  return (
    <div className="space-y-6">
      <PageHeader
        showTitleStatusDot
        title="Transport Authority View"
        subtitle={subtitle}
        footer={
          <>
            <p className="max-w-[56rem] text-sm leading-relaxed text-brand-text">
              This view helps transportation authorities monitor predicted pickup-demand pressure across NYC TLC zones, review
              borough-level stress, and use weather/incident context to support planning and oversight decisions.
            </p>
            <p className="text-xs font-medium text-brand-muted">
              Designed for regulatory monitoring and planning support, not direct driver dispatch.
            </p>
          </>
        }
      >
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
              label="Monitoring threshold"
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

      {!showBlocking && fetchErrors.snapshot ? (
        <p className="text-xs text-rose-600">Snapshot: {fetchErrors.snapshot}</p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          icon={Gauge}
          accent="teal"
          label="Citywide Predicted Demand"
          value={formatNumber(citywidePredicted, 0)}
          subtext="Predicted pickup-demand signal for the selected city snapshot."
        />
        <KpiCard
          icon={MapPinned}
          accent={thresholdMode === "high" ? "danger" : "warn"}
          label="High-Pressure Zones"
          value={formatNumber(thresholdCountScope, 0)}
          subtext={
            thresholdMode === "high"
              ? "Zones at or above 1.35× pressure ratio in the selected borough scope."
              : thresholdMode === "elevated"
                ? "Zones at or above 1.15× pressure ratio in the selected borough scope."
                : "All zones with a valid pressure ratio in the selected borough scope."
          }
        />
        <KpiCard
          icon={Scale}
          accent="neutral"
          label="Peak Borough"
          value={peakBoroughAvg?.name ?? "—"}
          subtext={
            peakBoroughAvg
              ? `Strongest relative demand pressure (~${formatDecimal(peakBoroughAvg.ratio, 2)}× avg ratio).`
              : "Borough with strongest relative demand pressure (snapshot average)."
          }
        />
        <KpiCard
          icon={AlertTriangle}
          accent={incidentContextRowsCount > 0 ? "warn" : "neutral"}
          label="Active Incident Context"
          value={formatNumber(incidentContextRowsCount, 0)}
          subtext="Zones or rows with event, incident, closure, or disruption indicators."
        />
        <KpiCard
          icon={Cloud}
          accent="neutral"
          label="Weather Context"
          value={weatherKpi}
          subtext="Weather signal associated with the selected snapshot."
        />
        <KpiCard
          icon={ShieldAlert}
          accent={monitoringPriority === "High" ? "danger" : monitoringPriority === "Elevated" ? "warn" : "neutral"}
          label="Regulatory Monitoring Priority"
          value={monitoringPriority}
          subtext="Summary priority for citywide monitoring."
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] xl:items-stretch">
        <section
          id="authority-zone-map"
          className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-brand-border bg-white shadow-card xl:min-h-[620px]"
        >
          <div className="flex flex-shrink-0 flex-col gap-3 border-b border-brand-border px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-brand-text">NYC TLC Zone Demand Pressure Map</h3>
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
            {sectionBusy ? (
              <div className="mb-3 h-24 flex-shrink-0 animate-pulse rounded-lg bg-brand-mint/40" />
            ) : null}
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
                  legendFooter="Warmer colors indicate stronger monitoring priority for the selected metric."
                />
              ) : geoLoading ? (
                <div className="flex h-[480px] items-center justify-center rounded-xl border border-dashed border-brand-border bg-brand-mint/20 text-sm font-medium text-brand-muted">
                  Loading TLC zone map…
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-brand-text">TLC zone geometry unavailable. Showing schematic demand panel.</p>
                  {geoError && apiOnline === true ? <p className="text-xs text-brand-muted">Detail: {geoError}</p> : null}
                  <div className="grid max-h-[min(420px,50vh)] auto-rows-fr grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-1 overflow-auto rounded-xl border border-brand-border bg-brand-bg/50 p-2">
                    {schematicZones.length === 0 ? (
                      <div className="col-span-full flex min-h-[160px] items-center justify-center text-sm text-brand-muted">
                        No zone rows for this selection.
                      </div>
                    ) : (
                      schematicZones.map((row, idx) => {
                        const ratio = row.pressure_ratio ?? row.observed_pressure_ratio;
                        const pred = row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour;
                        return (
                          <div
                            key={`${row.zone_id}-${idx}`}
                            className={`flex min-h-[52px] flex-col justify-center rounded border px-1.5 py-1 text-[10px] leading-tight ${schematicCellClass(ratio)}`}
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
            <h3 className="text-sm font-semibold text-brand-text">Regulatory Insights</h3>
            <p className="mt-1 text-[11px] leading-snug text-brand-muted">
              Demand-pressure and context signals for oversight — not passenger waiting-time measurements.
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
        title="Citywide Demand Pressure Trend"
        subtitle="Hourly citywide pickup-demand signal across the selected 168-hour monitoring window."
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
            !sectionBusy && <p className="text-sm text-brand-muted">No city trend rows for this window.</p>
          )}
        </div>
        <div className="mt-3 rounded-lg border border-brand-border bg-brand-mint/15 px-3 py-2.5 text-xs leading-relaxed text-brand-text">
          {highPressureRegulatoryNote}
        </div>
      </SectionCard>

      <SectionCard
        title="Borough Stress Comparison"
        subtitle="Average demand-pressure ratio by borough for the selected monitoring time (borough trend export)."
      >
        {fetchErrors.borough ? <p className="mb-2 text-xs text-rose-600">{fetchErrors.borough}</p> : null}
        <p className="mb-2 text-xs font-medium text-brand-muted">{boroughChartFootnote}</p>
        <p className="mb-3 text-xs text-brand-muted">
          Used to identify boroughs that may require closer monitoring or planning review.
        </p>
        {sectionBusy && !boroughBars.length ? <div className="h-56 animate-pulse rounded-lg bg-brand-mint/40" /> : null}
        <div className="h-72 w-full min-w-0">
          {boroughBars.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={boroughBars} layout="vertical" margin={{ left: 4, right: 16 }}>
                <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                <XAxis type="number" domain={[0, "auto"]} tickFormatter={(v) => `${formatDecimal(v, 2)}×`} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => formatDecimal(value, 2)} />
                <Bar dataKey="ratio" name="Avg pressure ratio" radius={[0, 6, 6, 0]}>
                  {boroughBars.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={entry.name === peakBarName ? "#B42318" : entry.ratio >= 1.15 ? "#F7B731" : "#00856f"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            !sectionBusy && <p className="text-sm text-brand-muted">No borough stress rows.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard
        id="authority-high-priority-zones"
        title="High-Priority TLC Zones"
        subtitle="Zones ranked by predicted pickups, then pressure ratio and incident/disruption context, for the selected snapshot."
      >
        <DataTable
          columns={[
            {
              key: "_rank",
              label: "Rank",
              render: (v) => String(v ?? "—"),
            },
            { key: "zone_name", label: "Zone", render: (v) => v ?? "—" },
            { key: "borough", label: "Borough", render: (v) => v ?? "—" },
            {
              key: "predicted_next_hour_pickups",
              label: "Predicted Pickups",
              render: (_, row) => formatNumber(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour, 0),
            },
            {
              key: "pressure_ratio",
              label: "Pressure Ratio",
              render: (v) => formatRatio(v),
            },
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
              label: "Monitoring Note",
              render: (_, row) => monitoringNoteForRow(row, predP85),
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
              title: "Demand Pressure",
              body: "Pressure Ratio compares predicted next-hour pickups with the recent 24-hour baseline for the same TLC zone. Higher values indicate stronger demand pressure relative to the zone's recent baseline.",
            },
            {
              title: "High-Pressure Zone",
              body: "A high-pressure zone has a pressure ratio of 1.35× or above, meaning predicted demand is substantially above its recent baseline.",
            },
            {
              title: "Incident Context",
              body: "Incident context summarizes event, collision, closure, or disruption signals that may affect demand patterns.",
            },
            {
              title: "Regulatory Use",
              body: "This page supports citywide monitoring and planning discussions. It does not control street operations and does not directly measure passenger waiting time.",
            },
          ].map((c) => (
            <div key={c.title} className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
              <h3 className="text-sm font-semibold text-brand-text">{c.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-brand-muted">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <SectionCard title="Monitoring Recommendations" subtitle="Planning-oriented prompts from the current signals.">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-brand-muted">
          {recommendations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </SectionCard>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-brand-text">Potential Live Regulatory Features</h2>
        <p className="max-w-[56rem] text-xs leading-relaxed text-brand-muted">
          Illustrative monitoring concepts using the current export as an available data indicator — not live feeds. Charts summarize snapshot or
          trend fields already on this page for layout review only.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Live incident intelligence</div>
            <p className="mt-1 text-[10px] text-brand-muted">Available data indicator · zone incident inputs by borough</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureIncidentByBorough.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureIncidentByBorough} margin={{ top: 4, right: 4, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 9 }} width={22} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#00856f" radius={[3, 3, 0, 0]} name="Incident-context count" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No incident-context indicator fields in this slice.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Live version would monitor collisions, closures, and events by zone for regulatory visibility.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Historical same-hour comparison</div>
            <p className="mt-1 text-[10px] text-brand-muted">Illustrative concept · citywide predicted sum vs same-hour mean</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureSameHourBars.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureSameHourBars} layout="vertical" margin={{ left: 4, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={(v) => formatNumber(v, 0)} />
                    <YAxis type="category" dataKey="label" width={120} tick={{ fontSize: 8 }} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" fill="#0f766e" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">Insufficient city trend rows for comparison.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              A live feed would compare the current hour with historical baselines for planning review.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Monitoring alerts</div>
            <p className="mt-1 text-[10px] text-brand-muted">Available data indicator · high-pressure zone count (recent hours)</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {sparklineHighPressure.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={sparklineHighPressure} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9 }} width={22} />
                    <Tooltip formatter={(v) => [formatNumber(v, 0), "Zones ≥1.35×"]} />
                    <Area type="monotone" dataKey="hz" stroke="#B42318" fill="#fecaca" strokeWidth={1.5} name="High-pressure zones" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No trend points for sparkline.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Alerts would flag repeated threshold breaches for oversight follow-up.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Service equity / spatial monitoring</div>
            <p className="mt-1 text-[10px] text-brand-muted">Available data indicator · borough avg pressure (selected hour)</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureBoroughPressureMini.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureBoroughPressureMini} margin={{ top: 4, right: 4, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 9 }} width={22} tickFormatter={(v) => `${v}`} />
                    <Tooltip formatter={(v) => formatDecimal(v, 2)} />
                    <Bar dataKey="ratio" fill="#F7B731" radius={[3, 3, 0, 0]} name="Avg ratio" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No borough averages for this hour.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Supports regulatory analysis of where sustained pressure concentrates across boroughs.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Weather risk monitoring</div>
            <p className="mt-1 text-[10px] text-brand-muted">Weather indicator · mean precip / scaled temperature signal</p>
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
                <p className="text-xs text-brand-muted">Weather fields sparse in this export.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              {weatherKpi !== "—" ? `Summary: ${weatherKpi}. ` : ""}
              Live risk views would add watches and visibility thresholds for planning coordination.
            </p>
          </div>

          <div className="flex flex-col rounded-xl border border-brand-border bg-white p-3 shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wide text-brand-primary">Congestion / context layer</div>
            <p className="mt-1 text-[10px] text-brand-muted">Context monitoring indicator · disruption-related score by borough</p>
            <div className="mt-2 h-[130px] w-full min-w-0">
              {featureDisruptionByBorough.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={featureDisruptionByBorough} margin={{ top: 4, right: 4, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E3EEE9" />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 9 }} width={22} />
                    <Tooltip formatter={(v) => formatDecimal(v, 1)} />
                    <Bar dataKey="value" fill="#94a3b8" radius={[3, 3, 0, 0]} name="Disruption indicator score" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-brand-muted">No disruption-monitoring indicator fields in this slice.</p>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-brand-muted">
              Without live congestion telemetry, disruption features provide contextual monitoring only.
            </p>
          </div>
        </div>
      </section>

      <AuthorityAlerts
        enabled={showRegulatoryAlerts}
        fullRows={fullRows}
        summary={summary}
        sortedTableRows={sortedTableRows}
        peakBoroughAvg={peakBoroughAvg}
        peakBoroughStress={peakBoroughStress}
      />
    </div>
  );
}
