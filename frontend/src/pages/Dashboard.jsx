import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCcw,
  CloudSun,
  Gauge,
  Flame,
  TriangleAlert,
  MapPin,
  Cpu,
  Users,
  Info,
  RotateCcw,
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import ZoneDemandCanvas from "../components/ZoneDemandCanvas";
import ZoneHourHeatMatrix from "../components/ZoneHourHeatMatrix";
import SelectField from "../components/SelectField";
import GlassButton from "../components/GlassButton";
import DataTable from "../components/DataTable";
import DashboardSkeleton from "../components/DashboardSkeleton";
import brandLogo from "../assets/Maseer_logo.jpg.jpg";
import {
  getDashboardSnapshot,
  getCityTrend,
  getBoroughTrend,
  getZoneHourHeatmap,
  getWeatherEventsTimeline,
  getTimestamps,
  getModelMetrics,
} from "../lib/api";
import { formatDecimal, formatNumber, isoToDisplay, pressureLabel, formatRatio } from "../lib/format";
import { buildDashboardInsightFourCards } from "../lib/insights";

const LOG = "[MASEER]";

const PROJECT_BLURB =
  "MASEER is an AI-driven dashboard that forecasts next-hour taxi demand pressure across NYC TLC taxi zones using taxi trip records, weather, and event/incident context. The system supports monitoring, model comparison, and scenario analysis using demand-pressure proxies.";

const TEAM = [
  "Ghala Adel Alharbi",
  "Anhar Mohammed Alansari",
  "Rahaf Saleh Aldhahri",
  "Remas Fawaz Almaliki",
  "Arwa Ahmed Alghamdi",
];

const BOROUGH_PRESETS = [
  { value: "all", label: "All NYC" },
  { value: "Manhattan", label: "Manhattan" },
  { value: "Brooklyn", label: "Brooklyn" },
  { value: "Queens", label: "Queens" },
  { value: "Bronx", label: "Bronx" },
  { value: "Staten Island", label: "Staten Island" },
  { value: "EWR", label: "EWR" },
];

const PRESSURE_VIEWS = [
  { value: "ratio", label: "Pressure ratio" },
  { value: "pickups", label: "Predicted pickups" },
  { value: "incident", label: "Incident context" },
];

const MODEL_PRIORITY = [
  "XGBoost",
  "Random Forest",
  "Gradient Boosting",
  "Ridge Regression",
  "Seasonal Naive",
  "LSTM",
  "GRU",
  "Temporal CNN",
];

function rowIncidentContext(row) {
  if (!row) return false;
  if (Number(row.incident_flag) > 0) return true;
  if (Number(row.event_flag) > 0 || Number(row.event_active) > 0) return true;
  if (Number(row.road_closure_flag) > 0) return true;
  if (Number(row.zone_incident_count) > 0) return true;
  if (Number(row.citywide_incident_count) > 0) return true;
  const d = Number(row.disruption_score);
  if (Number.isFinite(d) && d > 0) return true;
  return false;
}

function mergeModelOptions(mmPack, overview) {
  const tabular = (mmPack?.model_metrics ?? []).map((m) => m.model_name).filter(Boolean);
  const forecast = (mmPack?.forecast_metrics ?? []).map((m) => m.model_name).filter(Boolean);
  const pool = [...new Set([...tabular, ...forecast, overview?.best_tabular_model].filter(Boolean))];
  const ordered = [
    ...MODEL_PRIORITY.filter((n) => pool.includes(n)),
    ...pool.filter((n) => !MODEL_PRIORITY.includes(n)),
  ];
  return ordered;
}

export default function Dashboard({ overview, refreshHealth, apiOnline }) {
  const [timestamps, setTimestamps] = useState([]);
  const [models, setModels] = useState([]);
  const [timestamp, setTimestamp] = useState("");
  const [model, setModel] = useState("");
  const [borough, setBorough] = useState("all");
  const [pressureView, setPressureView] = useState("ratio");
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState(null);
  const [city, setCity] = useState([]);
  const [boroughTrend, setBoroughTrend] = useState([]);
  const [heat, setHeat] = useState([]);
  const [wxLine, setWxLine] = useState([]);
  const [fetchErrors, setFetchErrors] = useState({});

  const allowStaticFallback = apiOnline !== true;

  useEffect(() => {
    if (apiOnline === null) return;
    let cancel = false;
    (async () => {
      const tsRes = await getTimestamps(null, { maxTimestamps: 0, allowStaticFallback });
      if (cancel) return;
      if (tsRes.ok === false) {
        console.warn(`${LOG} timestamps list failed:`, tsRes.error ?? "");
        return;
      }
      setTimestamps(tsRes.rows ?? []);
    })();
    return () => {
      cancel = true;
    };
  }, [apiOnline, allowStaticFallback]);

  useEffect(() => {
    if (apiOnline === null) return;
    let cancel = false;
    (async () => {
      const mm = await getModelMetrics({ allowStaticFallback });
      if (cancel) return;
      if (mm.ok === false) {
        console.warn(`${LOG} model metrics failed (model list):`, mm.error ?? "");
        return;
      }
      const opts = mergeModelOptions(mm.data, overview);
      setModels(opts);
      setModel((prev) => prev || String(opts[0] || ""));
    })();
    return () => {
      cancel = true;
    };
  }, [overview?.best_tabular_model, apiOnline, allowStaticFallback]);

  const loadBoard = useCallback(async () => {
    if (apiOnline === null) return;
    setLoading(true);
    try {
      const [snapRes, ct, bor, hm, wx] = await Promise.all([
        getDashboardSnapshot({
          timestamp: timestamp || undefined,
          model: model || undefined,
          allowStaticFallback,
        }),
        getCityTrend({ hours: 168, allowStaticFallback }),
        getBoroughTrend({ hours: 168, allowStaticFallback }),
        getZoneHourHeatmap({ hours: 24, topN: 22, allowStaticFallback }),
        getWeatherEventsTimeline({ hours: 168, allowStaticFallback }),
      ]);

      setFetchErrors((prev) => {
        const n = { ...prev };
        const touch = (key, res) => {
          if (res.ok === false) {
            console.warn(`${LOG} dashboard panel failed [${key}]:`, res.error ?? "");
            n[key] = res.error || "Request failed";
          } else delete n[key];
        };
        touch("snapshot", snapRes);
        touch("city", ct);
        touch("borough", bor);
        touch("heatmap", hm);
        touch("weather", wx);
        return n;
      });

      if (snapRes.ok !== false) setSnapshot(snapRes.data);
      if (ct.ok !== false) setCity(ct.rows ?? []);
      if (bor.ok !== false) setBoroughTrend(bor.rows ?? []);
      if (hm.ok !== false) setHeat(hm.rows ?? []);
      if (wx.ok !== false) setWxLine(wx.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [timestamp, model, apiOnline, allowStaticFallback]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  const showBlocking = loading || apiOnline === null;

  const defaultTs = timestamps.length ? timestamps[timestamps.length - 1] : "";
  useEffect(() => {
    if (!timestamp && defaultTs) setTimestamp(defaultTs);
  }, [defaultTs, timestamp]);

  const rawRows = snapshot?.rows ?? [];

  const boroughOptions = useMemo(() => {
    const found = [...new Set(rawRows.map((r) => r.borough).filter(Boolean))];
    const opts = [{ value: "all", label: "All NYC" }];
    const presetVals = BOROUGH_PRESETS.slice(1).map((b) => b.value);
    for (const b of presetVals) {
      const hit = found.some((f) => String(f).toLowerCase() === b.toLowerCase());
      opts.push({
        value: b,
        label: hit ? b : `${b} (no rows in slice)`,
      });
    }
    for (const f of found.sort()) {
      if (!presetVals.some((p) => p.toLowerCase() === String(f).toLowerCase()))
        opts.push({ value: f, label: String(f) });
    }
    return opts;
  }, [rawRows]);

  const filteredRows = useMemo(() => {
    if (borough === "all") return rawRows;
    return rawRows.filter((r) => String(r.borough).toLowerCase() === borough.toLowerCase());
  }, [rawRows, borough]);

  const insightCards = useMemo(
    () => buildDashboardInsightFourCards(snapshot, filteredRows),
    [snapshot, filteredRows]
  );

  const totalPredicted = useMemo(() => {
    const s = snapshot?.summary?.total_predicted_next_hour_pickups;
    if (borough === "all" && Number.isFinite(Number(s))) return Number(s);
    let sum = 0;
    let n = 0;
    for (const r of filteredRows) {
      const v = Number(
        r.predicted_next_hour_pickups ??
          r.target_pickup_count_next_hour ??
          r.observed_next_hour_pickups
      );
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    return n ? sum : null;
  }, [snapshot, filteredRows, borough]);

  const highPressureCount = useMemo(
    () =>
      filteredRows.filter((r) => Number(r.pressure_ratio ?? r.observed_pressure_ratio) >= 1.35).length,
    [filteredRows]
  );

  const incidentContextCount = useMemo(
    () => filteredRows.filter((r) => rowIncidentContext(r)).length,
    [filteredRows]
  );

  const weatherHeadline = useMemo(() => {
    const cats = filteredRows.map((r) => r.weather_category).filter(Boolean);
    if (!cats.length)
      return snapshot?.summary?.weather_status ?? overview?.subtitle?.slice(0, 24) ?? "—";
    const counts = {};
    for (const c of cats) counts[c] = (counts[c] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? String(cats[0]);
  }, [filteredRows, snapshot, overview]);

  const weatherTemps = useMemo(() => {
    const t = filteredRows.map((r) => Number(r.temperature)).filter(Number.isFinite);
    if (!t.length) return null;
    return t.reduce((a, b) => a + b, 0) / t.length;
  }, [filteredRows]);

  const peakBorough = useMemo(() => {
    const by = {};
    for (const r of filteredRows) {
      const b = r.borough || "—";
      if (!by[b]) by[b] = { ratios: [], preds: [] };
      const pr = Number(r.pressure_ratio ?? r.observed_pressure_ratio);
      if (Number.isFinite(pr)) by[b].ratios.push(pr);
      const p = Number(r.predicted_next_hour_pickups ?? r.target_pickup_count_next_hour);
      if (Number.isFinite(p)) by[b].preds.push(p);
    }
    let best = null;
    let bestScore = -Infinity;
    for (const [name, v] of Object.entries(by)) {
      const avgR = v.ratios.length ? v.ratios.reduce((a, x) => a + x, 0) / v.ratios.length : null;
      const sumP = v.preds.reduce((a, x) => a + x, 0);
      const score = avgR != null ? avgR : sumP > 0 ? sumP / 1000 : -1;
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    return best;
  }, [filteredRows]);

  const cityChart = useMemo(() => {
    return (city ?? []).slice(-168).map((r) => ({
      t: isoToDisplay(r.timestamp, ""),
      raw: r.timestamp,
      demand: Number(r.total_next_hour_target ?? r.total_pickups ?? null),
      pickups: Number(r.total_pickups ?? null),
      incidents: Number(r.total_zone_incidents ?? 0),
    }));
  }, [city]);

  const trend24 = useMemo(() => cityChart.slice(-24), [cityChart]);

  const incidentSpark = useMemo(() => {
    return (wxLine ?? []).slice(-48).map((r) => ({
      t: isoToDisplay(r.timestamp, ""),
      inc: Number(r.total_zone_incidents ?? 0),
    }));
  }, [wxLine]);

  const boroughBars = useMemo(() => {
    const ts = snapshot?.summary?.timestamp;
    let slice = boroughTrend.filter((r) => !ts || String(r.timestamp) === String(ts));
    if (!slice.length && filteredRows.length) {
      const m = {};
      for (const row of filteredRows) {
        const b = row.borough || "—";
        if (!m[b]) m[b] = { sumR: 0, n: 0, pred: 0 };
        const pr = Number(row.pressure_ratio ?? row.observed_pressure_ratio);
        if (Number.isFinite(pr)) {
          m[b].sumR += pr;
          m[b].n++;
        }
        const p = Number(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour);
        if (Number.isFinite(p)) m[b].pred += p;
      }
      return Object.entries(m).map(([name, v]) => ({
        name,
        ratio: v.n ? v.sumR / v.n : 0,
        pred: v.pred,
      }));
    }
    const agg = {};
    for (const r of slice) {
      const b = r.borough || "—";
      if (!agg[b]) agg[b] = { sum: 0, n: 0, pred: 0 };
      const pr = Number(r.avg_pressure_ratio);
      if (Number.isFinite(pr)) {
        agg[b].sum += pr;
        agg[b].n++;
      }
      agg[b].pred += Number(r.target_pickup_count_next_hour ?? r.pickup_count ?? 0);
    }
    return Object.entries(agg).map(([name, v]) => ({
      name,
      ratio: v.n ? v.sum / v.n : 0,
      pred: v.pred,
    }));
  }, [boroughTrend, snapshot, filteredRows]);

  const heatFiltered = useMemo(() => {
    if (borough === "all") return heat;
    const allowed = new Set(filteredRows.map((r) => String(r.zone_id)));
    return heat.filter((h) => allowed.has(String(h.zone_id)));
  }, [heat, borough, filteredRows]);

  const tablePressure = useMemo(() => {
    return [...filteredRows]
      .filter((r) => r.zone_name || r.zone_id != null)
      .sort((a, b) => Number(b.pressure_ratio ?? 0) - Number(a.pressure_ratio ?? 0))
      .slice(0, 25);
  }, [filteredRows]);

  const tablePickup = useMemo(() => {
    return [...filteredRows]
      .filter((r) => r.zone_name || r.zone_id != null)
      .sort(
        (a, b) =>
          Number(b.predicted_next_hour_pickups ?? b.target_pickup_count_next_hour ?? 0) -
          Number(a.predicted_next_hour_pickups ?? a.target_pickup_count_next_hour ?? 0)
      )
      .slice(0, 25);
  }, [filteredRows]);

  const resetFilters = () => {
    setBorough("all");
    setPressureView("ratio");
    if (defaultTs) setTimestamp(defaultTs);
    const first = models[0];
    if (first) setModel(String(first));
  };

  const modelNote =
    snapshot?.prediction_source === "model_prediction"
      ? "Hold-out predictions joined to features."
      : snapshot?.prediction_source === "observed_target_proxy"
        ? "Using observed next-hour pickups where model scores are unavailable."
        : "Mixed / static export alignment.";

  const cityChartThin = trend24.filter((r) => Number.isFinite(r.demand) || Number.isFinite(r.pickups));

  return (
    <div className="space-y-6 pb-4">
      {/* Hero */}
      <section className="overflow-hidden rounded-2xl border border-brand-border bg-white shadow-soft">
        <div className="grid gap-6 p-6 lg:grid-cols-[1fr_280px] lg:items-start">
          <div>
            <div className="flex flex-wrap items-start gap-4">
              <img
                src={brandLogo}
                alt="MASEER"
                className="h-16 w-16 shrink-0 rounded-xl object-cover shadow-md ring-2 ring-brand-mint/80"
              />
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-primary">
                  Main Dashboard
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-brand-text sm:text-[1.75rem]">
                  NYC Taxi Demand Pressure Forecasting
                </h1>
                <p className="mt-3 max-w-[46rem] text-sm leading-relaxed text-brand-muted">{PROJECT_BLURB}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-brand-border bg-gradient-to-br from-brand-mint/50 to-white p-4 shadow-inner">
            <div className="flex items-center gap-2 text-brand-primary">
              <Users size={18} strokeWidth={1.85} />
              <span className="text-xs font-bold uppercase tracking-wide">Team MASEER — Data Science Students</span>
            </div>
            <ul className="mt-3 space-y-1.5 text-[13px] leading-snug text-brand-text">
              {TEAM.map((name) => (
                <li key={name} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand-primary/70" />
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Controls */}
      <section className="rounded-2xl border border-brand-border bg-white px-4 py-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wide text-brand-muted">Global controls</h2>
          <span className="text-[11px] text-brand-muted">
            Snapshot: {isoToDisplay(snapshot?.summary?.timestamp ?? timestamp, "—")} • Target:{" "}
            <code className="rounded bg-brand-bg px-1 font-mono text-[10px] text-brand-text">
              target_pickup_count_next_hour
            </code>
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Snapshot time"
            value={timestamp}
            onChange={setTimestamp}
            options={timestamps.map((t) => ({ value: t, label: isoToDisplay(t, t) }))}
          />
          <SelectField
            label="Model"
            value={model}
            onChange={setModel}
            options={models.map((m) => ({ value: m, label: m }))}
            placeholder="Select model"
          />
          <SelectField label="Borough" value={borough} onChange={setBorough} options={boroughOptions} />
          <SelectField
            label="Pressure view"
            value={pressureView}
            onChange={setPressureView}
            options={PRESSURE_VIEWS}
          />
          <GlassButton
            variant="primary"
            onClick={() => {
              refreshHealth?.();
              loadBoard();
            }}
          >
            <RefreshCcw size={16} strokeWidth={1.75} />
            Refresh
          </GlassButton>
          <GlassButton onClick={resetFilters}>
            <RotateCcw size={16} strokeWidth={1.75} />
            Reset filters
          </GlassButton>
        </div>
      </section>

      {showBlocking ? (
        <div className="space-y-3">
          <p className="text-center text-xs font-medium text-brand-muted">Loading dashboard data…</p>
          <DashboardSkeleton />
        </div>
      ) : null}

      {!showBlocking ? (
        <>
          {/* KPI row */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <KpiCard
              icon={Gauge}
              accent="teal"
              label="Predicted Next-Hour Pickups"
              value={totalPredicted != null ? formatNumber(totalPredicted, 0) : "N/A"}
              subtext="Citywide sum for current filters (proxy pickups)"
            />
            <KpiCard
              icon={Flame}
              accent="danger"
              label="High-Pressure Zones"
              value={formatNumber(highPressureCount, 0)}
              subtext="Zones with pressure ratio ≥ 1.35"
            />
            <KpiCard
              icon={TriangleAlert}
              accent="warn"
              label="Active Incident Context"
              value={formatNumber(incidentContextCount, 0)}
              subtext="Rows with incident/event/closure/disruption signals"
            />
            <KpiCard
              icon={CloudSun}
              accent="mint"
              label="Weather Snapshot"
              value={typeof weatherHeadline === "string" ? weatherHeadline : "—"}
              subtext={
                weatherTemps != null
                  ? `Mean ~${formatDecimal(weatherTemps, 1)}°C in view`
                  : "Category aggregated from zone rows"
              }
            />
            <KpiCard
              icon={MapPin}
              accent="neutral"
              label="Peak Borough (this view)"
              value={peakBorough ?? "N/A"}
              subtext="By avg pressure ratio, else pickup mass"
            />
            <KpiCard
              icon={Cpu}
              accent="teal"
              label="Selected Model"
              value={model || snapshot?.model_name || "—"}
              subtext={modelNote}
            />
          </div>

          {/* Terminology strip */}
          <div className="flex gap-3 rounded-xl border border-brand-border bg-gradient-to-r from-brand-mint/30 via-white to-brand-bg px-4 py-3 shadow-sm">
            <Info className="mt-0.5 shrink-0 text-brand-primary" size={18} />
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-brand-primary">
                What does demand pressure mean?
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-brand-muted">
                Demand pressure is a relative proxy calculated as predicted next-hour pickups divided by the rolling 24-hour
                average pickups for the same TLC zone. A higher ratio means the zone is expected to experience stronger demand
                compared with its recent baseline. Because NYC TLC data does not include observed passenger waiting time, this
                dashboard does not claim direct wait-time measurement.
              </p>
            </div>
          </div>

          {/* Map + insights */}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] lg:items-start">
            <SectionCard
              title="NYC TLC zones — demand visualization"
              subtitle={`Colored by ${PRESSURE_VIEWS.find((p) => p.value === pressureView)?.label ?? "pressure"} • Model ${model || snapshot?.model_name || "—"}`}
            >
              {fetchErrors.snapshot ? (
                <p className="mb-2 text-xs text-rose-600">Could not refresh snapshot from API: {fetchErrors.snapshot}</p>
              ) : null}
              <ZoneDemandCanvas rows={filteredRows} pressureView={pressureView} boroughFilter={borough} />
            </SectionCard>

            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-brand-border bg-gradient-to-br from-brand-mint/40 to-white px-4 py-3 shadow-card">
                <h3 className="text-sm font-semibold text-brand-text">AI Insights &amp; Recommendations</h3>
                <p className="mt-1 text-[11px] text-brand-muted">
                  Narrative cues from the active snapshot — pickup-count proxy only.
                </p>
              </div>
              <div className="grid gap-3">
                {insightCards.map((card, idx) => (
                  <div
                    key={idx}
                    className="rounded-xl border border-brand-border bg-white p-4 shadow-card transition-shadow hover:shadow-soft"
                  >
                    <div className="text-[11px] font-bold uppercase tracking-wide text-brand-primary">{card.title}</div>
                    <p className="mt-2 text-[13px] leading-relaxed text-brand-muted">{card.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Charts */}
          <div className="grid gap-4 xl:grid-cols-3">
            <SectionCard
              title="City demand trend"
              subtitle="Hourly city aggregates • darker area = summed next-hour proxy targets"
              className="xl:col-span-1"
            >
              {fetchErrors.city ? (
                <p className="mb-2 text-xs text-rose-600">Could not refresh this chart: {fetchErrors.city}</p>
              ) : null}
              {fetchErrors.weather ? (
                <p className="mb-2 text-xs text-rose-600">Weather / incident strip: {fetchErrors.weather}</p>
              ) : null}
              {cityChartThin.length >= 2 ? (
                <>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={trend24}>
                        <defs>
                          <linearGradient id="dashDm" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#008B78" stopOpacity={0.38} />
                            <stop offset="100%" stopColor="#008B78" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                        <XAxis dataKey="t" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Legend />
                        <Area
                          type="monotone"
                          dataKey="demand"
                          name="Next-hour target sum (proxy)"
                          stroke="#008B78"
                          fill="url(#dashDm)"
                        />
                        <Line
                          type="monotone"
                          dataKey="pickups"
                          name="Current-hour pickups sum"
                          stroke="#66736d"
                          dot={false}
                          strokeWidth={2}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 h-14 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={incidentSpark}>
                        <XAxis hide />
                        <YAxis hide />
                        <Tooltip />
                        <Line type="stepAfter" dataKey="inc" stroke="#F7B731" dot={false} strokeWidth={2} name="Incidents" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-brand-muted">
                    Limited hourly diversity in this export — showing the latest city buckets instead of a sparse chart.
                  </p>
                  <DataTable
                    columns={[
                      { key: "t", label: "Time" },
                      {
                        key: "demand",
                        label: "Next-hour sum",
                        render: (v) => formatNumber(v, 0),
                      },
                      {
                        key: "pickups",
                        label: "Pickups sum",
                        render: (v) => formatNumber(v, 0),
                      },
                    ]}
                    rows={cityChart.slice(-8)}
                    maxRows={12}
                  />
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Borough pressure comparison"
              subtitle="Aligned hour when available • avg ratio or fallback mass"
              className="xl:col-span-1"
            >
              {fetchErrors.borough ? (
                <p className="mb-2 text-xs text-rose-600">Could not refresh this chart: {fetchErrors.borough}</p>
              ) : null}
              {boroughBars.length ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={boroughBars} layout="vertical" margin={{ left: 4 }}>
                      <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                      <XAxis type="number" tickFormatter={(v) => `${formatDecimal(v, 2)}×`} />
                      <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v) => formatDecimal(v, 2)} />
                      <Bar dataKey="ratio" fill="#008B78" radius={[0, 6, 6, 0]} name="Avg pressure ratio" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="flex min-h-[200px] items-center justify-center px-4 text-center text-sm text-brand-muted">
                  No borough aggregates for this selection — adjust snapshot time or widen borough filters.
                </p>
              )}
            </SectionCard>

            <SectionCard title="Zone-hour demand heatmap" subtitle="Top zones vs hour-of-day" className="xl:col-span-1">
              {fetchErrors.heatmap ? (
                <p className="mb-2 text-xs text-rose-600">Could not refresh this chart: {fetchErrors.heatmap}</p>
              ) : null}
              <ZoneHourHeatMatrix rows={heatFiltered.length ? heatFiltered : heat} />
            </SectionCard>
          </div>

          {/* Tables */}
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Top pressure zones" subtitle="Ranked by pressure ratio in current filters">
              <div className="max-h-[300px] overflow-auto rounded-lg border border-brand-border">
                <DataTable
                  columns={[
                    { key: "__rank", label: "Rank" },
                    { key: "zone_name", label: "Zone" },
                    { key: "borough", label: "Borough" },
                    {
                      key: "predicted_next_hour_pickups",
                      label: "Pred. pickups",
                      render: (v, row) =>
                        formatNumber(v ?? row.target_pickup_count_next_hour ?? row.observed_next_hour_pickups, 0),
                    },
                    {
                      key: "pickup_count_roll_mean_24",
                      label: "Roll 24h μ",
                      render: (v) => formatDecimal(v, 2),
                    },
                    {
                      key: "pressure_ratio",
                      label: "Ratio",
                      render: (v, row) => formatRatio(v ?? row.observed_pressure_ratio),
                    },
                    {
                      key: "pressure_label",
                      label: "Label",
                      render: (_, row) =>
                        row.pressure_label ??
                        pressureLabel(Number(row.pressure_ratio ?? row.observed_pressure_ratio)),
                    },
                  ]}
                  rows={tablePressure.map((row, i) => ({ ...row, __rank: i + 1 }))}
                  maxRows={50}
                />
              </div>
            </SectionCard>

            <SectionCard title="Top predicted pickup zones" subtitle="Highest predicted next-hour pickups">
              <div className="max-h-[300px] overflow-auto rounded-lg border border-brand-border">
                <DataTable
                  columns={[
                    { key: "__rank", label: "Rank" },
                    { key: "zone_name", label: "Zone" },
                    { key: "borough", label: "Borough" },
                    {
                      key: "predicted_next_hour_pickups",
                      label: "Pred. pickups",
                      render: (v, row) =>
                        formatNumber(v ?? row.target_pickup_count_next_hour ?? row.observed_next_hour_pickups, 0),
                    },
                    {
                      key: "_inc",
                      label: "Incident context",
                      render: (_, row) =>
                        rowIncidentContext(row)
                          ? `Active (${formatNumber(row.zone_incident_count, 0)} zone inc.)`
                          : "Quiet",
                    },
                    {
                      key: "weather_category",
                      label: "Weather",
                      render: (v) => v ?? "—",
                    },
                  ]}
                  rows={tablePickup.map((row, i) => ({ ...row, __rank: i + 1 }))}
                  maxRows={50}
                />
              </div>
            </SectionCard>
          </div>
        </>
      ) : null}
    </div>
  );
}
