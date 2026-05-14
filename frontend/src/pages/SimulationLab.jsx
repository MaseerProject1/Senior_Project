import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FlaskConical, Play, RotateCcw, Search } from "lucide-react";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import SelectField from "../components/SelectField";
import GlassButton from "../components/GlassButton";
import {
  getZones,
  getTimestamps,
  getModelMetrics,
  getDashboardSnapshot,
  getModelPredictions,
  apiUrl,
  peekCachedApiUrl,
} from "../lib/api";
import { formatNumber, formatRatio, pressureTierLabel, pressureTone } from "../lib/format";
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
  LabelList,
} from "recharts";

const LOG = "[MASEER]";

const BOROUGH_OPTIONS = [
  { value: "all", label: "All NYC" },
  { value: "Manhattan", label: "Manhattan" },
  { value: "Brooklyn", label: "Brooklyn" },
  { value: "Queens", label: "Queens" },
  { value: "Bronx", label: "Bronx" },
  { value: "Staten Island", label: "Staten Island" },
  { value: "EWR", label: "EWR" },
];

const WEATHER_LABELS = ["Normal", "Mild weather effect", "Rain / low visibility", "Severe weather"];
const INCIDENT_LABELS = ["None", "Minor", "Moderate", "High disruption"];
const EVENT_LABELS = ["None", "Local event", "Large event", "Major surge event"];

const WEATHER_ADJ = [0, 0.05, 0.1, 0.18];
const INCIDENT_ADJ = [0, 0.04, 0.09, 0.15];
const EVENT_ADJ = [0, 0.08, 0.18, 0.3];

function num(val) {
  if (val === "" || val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function normBorough(b) {
  return String(b || "").trim().toLowerCase();
}

function zoneMatchesBorough(zone, borough) {
  if (!borough || borough === "all") return true;
  const zb = normBorough(zone.borough);
  if (borough === "EWR") {
    return zb === "ewr" || /\bewr\b/i.test(zone.zone_name || "") || /newark/i.test(zone.zone_name || "");
  }
  return zb === normBorough(borough);
}

function baselinePredictionFromRow(row) {
  if (!row) return null;
  const v =
    num(row.predicted_next_hour_pickups) ??
    num(row.target_pickup_count_next_hour) ??
    num(row.observed_next_hour_pickups);
  return v;
}

function computeScenarioMultiplier(demandPct, weatherSev, incidentLv, eventLv) {
  const demandChangePercent = demandPct / 100;
  const weatherAdjustment = WEATHER_ADJ[Math.min(3, Math.max(0, weatherSev))] ?? 0;
  const incidentAdjustment = INCIDENT_ADJ[Math.min(3, Math.max(0, incidentLv))] ?? 0;
  const eventAdjustment = EVENT_ADJ[Math.min(3, Math.max(0, eventLv))] ?? 0;
  return {
    multiplier: 1 + demandChangePercent + weatherAdjustment + incidentAdjustment + eventAdjustment,
    demandChangePercent,
    weatherAdjustment,
    incidentAdjustment,
    eventAdjustment,
  };
}

function tierFromScenarioRatio(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return { key: "na", label: "N/A", short: "N/A" };
  if (r < 0.85) return { key: "low", label: "Low", short: "Low" };
  if (r < 1.15) return { key: "typical", label: "Typical", short: "Typical" };
  if (r < 1.35) return { key: "elevated", label: "Elevated", short: "Elevated" };
  return { key: "high", label: "High", short: "High" };
}

function formatPctSigned(n) {
  if (!Number.isFinite(n)) return "N/A";
  const rounded = Math.round(n);
  return `${rounded >= 0 ? "+" : ""}${rounded}%`;
}

export default function SimulationLab({ overview, refreshHealth, apiOnline }) {
  const subtitle =
    "Explore what-if demand-pressure indicators for one TLC zone using numeric scenario controls and a single selected model — useful for operational exploration and planning review, not a passenger waiting-time forecast.";

  const allowStaticFallback = apiOnline !== true;

  const [zones, setZones] = useState([]);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [borough, setBorough] = useState("all");
  const [zoneId, setZoneId] = useState("");
  const [zoneSearch, setZoneSearch] = useState("");
  const [timestamp, setTimestamp] = useState("");
  const [timestamps, setTimestamps] = useState([]);

  const [demandPct, setDemandPct] = useState(0);
  const [weatherSeverity, setWeatherSeverity] = useState(0);
  const [incidentLevel, setIncidentLevel] = useState(0);
  const [eventIntensity, setEventIntensity] = useState(0);

  const [snapshotRow, setSnapshotRow] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);

  const [runState, setRunState] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  useLayoutEffect(() => {
    if (apiOnline === null) return;
    const zPeek = peekCachedApiUrl(apiUrl("zones"));
    if (zPeek?.ok && zPeek.data && (Array.isArray(zPeek.data.zones) || Array.isArray(zPeek.data.rows))) {
      const rows = Array.isArray(zPeek.data.zones) ? zPeek.data.zones : zPeek.data.rows;
      setZones(rows);
    }
    const mmPeek = peekCachedApiUrl(apiUrl("models/metrics"));
    if (
      mmPeek?.ok &&
      mmPeek.data &&
      (Array.isArray(mmPeek.data.rows) || Array.isArray(mmPeek.data.model_metrics))
    ) {
      const mrows = Array.isArray(mmPeek.data.rows) ? mmPeek.data.rows : mmPeek.data.model_metrics;
      const names = [...new Set((mrows ?? []).map((m) => m.model_name).filter(Boolean))];
      const opts = [
        ...new Set([mmPeek.data.best_tabular_model, overview?.best_tabular_model, ...names].filter(Boolean)),
      ];
      setModels(opts);
      const preferred = opts.includes("XGBoost") ? "XGBoost" : String(opts[0] || "");
      setModel((p) => (p && opts.includes(p) ? p : preferred));
    }
  }, [apiOnline, overview?.best_tabular_model]);

  useEffect(() => {
    if (apiOnline === null) return;
    (async () => {
      const [z, mm] = await Promise.all([
        getZones({ allowStaticFallback }),
        getModelMetrics({ allowStaticFallback }),
      ]);
      if (z.ok !== false) {
        setZones(z.rows ?? []);
      } else console.warn(`${LOG} simulation zones:`, z.error);
      if (mm.ok === false) {
        console.warn(`${LOG} simulation model metrics:`, mm.error);
        return;
      }
      const names = [...new Set((mm.data?.model_metrics ?? []).map((m) => m.model_name).filter(Boolean))];
      const opts = [...new Set([mm.data?.best_tabular_model, overview?.best_tabular_model, ...names].filter(Boolean))];
      setModels(opts);
      const preferred = opts.includes("XGBoost") ? "XGBoost" : String(opts[0] || "");
      setModel((p) => (p && opts.includes(p) ? p : preferred));
    })();
  }, [overview?.best_tabular_model, apiOnline, allowStaticFallback]);

  const filteredZones = useMemo(() => {
    let list = zones.filter((z) => zoneMatchesBorough(z, borough));
    const q = zoneSearch.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (z) =>
          String(z.zone_id).includes(q) ||
          String(z.zone_name || "").toLowerCase().includes(q) ||
          String(z.borough || "").toLowerCase().includes(q)
      );
    }
    return list.sort(
      (a, b) =>
        (a.borough || "").localeCompare(b.borough || "") || (a.zone_name || "").localeCompare(b.zone_name || "")
    );
  }, [zones, borough, zoneSearch]);

  const pickDefaultZoneFromSnapshot = useCallback(
    (rows) => {
      if (!rows?.length || !filteredZones.length) return null;
      const inFilter = new Set(filteredZones.map((z) => Number(z.zone_id)));
      let bestId = null;
      let bestPred = -Infinity;
      for (const r of rows) {
        const id = Number(r.zone_id);
        if (!inFilter.has(id)) continue;
        const pred = baselinePredictionFromRow(r);
        if (pred != null && pred > bestPred) {
          bestPred = pred;
          bestId = id;
        }
      }
      if (bestId != null) return String(bestId);
      const first = filteredZones[0];
      return first?.zone_id != null ? String(first.zone_id) : null;
    },
    [filteredZones]
  );

  useEffect(() => {
    setTimestamp("");
  }, [zoneId]);

  useEffect(() => {
    if (apiOnline === null || !zoneId) return;
    (async () => {
      const ts = await getTimestamps(Number(zoneId), { allowStaticFallback });
      if (ts.ok === false) {
        console.warn(`${LOG} simulation timestamps:`, ts.error);
        return;
      }
      const list = ts.rows ?? [];
      setTimestamps(list);
      const last = list[list.length - 1];
      if (last) setTimestamp(last);
      else setTimestamp("");
    })();
  }, [zoneId, apiOnline, allowStaticFallback]);

  useEffect(() => {
    if (apiOnline === null || !zoneId) return;
    (async () => {
      const snap = await getDashboardSnapshot({
        timestamp: timestamp || undefined,
        borough: null,
        allowStaticFallback,
      });
      if (snap.ok === false) {
        console.warn(`${LOG} simulation snapshot:`, snap.error);
        setSnapshotRow(null);
        return;
      }
      const row = (snap.data?.rows ?? []).find((r) => Number(r.zone_id) === Number(zoneId));
      setSnapshotRow(row ?? null);
    })();
  }, [zoneId, timestamp, apiOnline, allowStaticFallback]);

  useEffect(() => {
    if (!zoneId || !model || apiOnline === null) return;
    (async () => {
      const pr = await getModelPredictions({
        zoneId: Number(zoneId),
        model,
        hours: 96,
        limit: 500,
        allowStaticFallback,
      });
      const rows = pr.rows ?? [];
      const pts = rows
        .map((r) => ({
          ts: String(r.timestamp || ""),
          v: num(r.y_pred ?? r.predicted_next_hour_pickups ?? r.y_hat),
        }))
        .filter((p) => p.ts && p.v != null)
        .sort((a, b) => a.ts.localeCompare(b.ts));
      setHistoryRows(pts.slice(-28));
    })();
  }, [zoneId, model, apiOnline, allowStaticFallback]);

  useEffect(() => {
    if (!filteredZones.length || !zoneId) return;
    const ok = filteredZones.some((z) => String(z.zone_id) === String(zoneId));
    if (ok) return;
    setZoneId("");
  }, [filteredZones, zoneId]);

  useEffect(() => {
    if (zoneId || apiOnline === null || !filteredZones.length) return;
    let cancelled = false;
    (async () => {
      const snap = await getDashboardSnapshot({
        timestamp: undefined,
        borough: borough === "all" ? null : borough,
        allowStaticFallback,
      });
      if (cancelled || snap.ok === false) return;
      const rows = snap.data?.rows ?? [];
      const next = pickDefaultZoneFromSnapshot(rows);
      if (!cancelled && next) setZoneId(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [borough, zones, zoneId, apiOnline, allowStaticFallback, pickDefaultZoneFromSnapshot, filteredZones]);

  const sharedZoneBaseline = baselinePredictionFromRow(snapshotRow);
  const roll24 = num(snapshotRow?.pickup_count_roll_mean_24);
  const baselineRatioFromData = num(snapshotRow?.pressure_ratio);

  const modelOptions = useMemo(
    () => models.map((m) => ({ value: m, label: m })),
    [models]
  );

  const zoneSelectList = useMemo(() => {
    const show = filteredZones.slice(0, 400);
    return show.map((z) => ({
      value: String(z.zone_id),
      label: `${z.zone_name || "Zone"} (${z.borough || "—"})`,
    }));
  }, [filteredZones]);

  const handleReset = () => {
    setDemandPct(0);
    setWeatherSeverity(0);
    setIncidentLevel(0);
    setEventIntensity(0);
    setZoneSearch("");
    setBorough("all");
    setRunState(null);
    setError("");
    const preferred = models.includes("XGBoost") ? "XGBoost" : models[0] || "";
    if (preferred) setModel(preferred);
    (async () => {
      const snap = await getDashboardSnapshot({
        borough: null,
        allowStaticFallback,
      });
      if (snap.ok === false) return;
      const rows = snap.data?.rows ?? [];
      let bestId = null;
      let bestPred = -Infinity;
      for (const r of rows) {
        const id = Number(r.zone_id);
        if (!zones.some((z) => Number(z.zone_id) === id)) continue;
        const pred = baselinePredictionFromRow(r);
        if (pred != null && pred > bestPred) {
          bestPred = pred;
          bestId = id;
        }
      }
      if (bestId != null) setZoneId(String(bestId));
      else if (zones[0]?.zone_id != null) setZoneId(String(zones[0].zone_id));
    })();
  };

  const handleRun = async () => {
    setRunning(true);
    setError("");
    try {
      if (!zoneId) {
        setError("Select a zone before running the scenario.");
        return;
      }
      if (!model) {
        setError("Select a model before running the scenario.");
        return;
      }

      const sharedBaseline = baselinePredictionFromRow(snapshotRow);
      const denom = roll24 != null && roll24 > 0 ? roll24 : null;

      const { multiplier, demandChangePercent, weatherAdjustment, incidentAdjustment, eventAdjustment } =
        computeScenarioMultiplier(demandPct, weatherSeverity, incidentLevel, eventIntensity);

      const pr = await getModelPredictions({
        zoneId: Number(zoneId),
        model,
        hours: 4000,
        limit: 12000,
        allowStaticFallback,
      });
      const predRows = pr.rows ?? [];
      const tsKey = timestamp ? String(timestamp) : null;
      let modelSpecific = null;
      if (tsKey) {
        const hit = predRows.find(
          (r) =>
            Number(r.zone_id) === Number(zoneId) &&
            String(r.timestamp) === tsKey &&
            String(r.model_name || "") === String(model)
        );
        modelSpecific = num(hit?.y_pred ?? hit?.predicted_next_hour_pickups ?? hit?.y_hat);
      } else {
        const zoneRows = predRows.filter((r) => Number(r.zone_id) === Number(zoneId) && String(r.model_name || "") === String(model));
        const latestTs = [...new Set(zoneRows.map((r) => String(r.timestamp)).filter(Boolean))].sort().at(-1);
        if (latestTs) {
          const hit = zoneRows.find((r) => String(r.timestamp) === latestTs);
          modelSpecific = num(hit?.y_pred ?? hit?.predicted_next_hour_pickups ?? hit?.y_hat);
        }
      }

      let baseline = null;
      let usedSharedBaseline = false;
      if (modelSpecific != null && Number.isFinite(modelSpecific)) {
        baseline = modelSpecific;
      } else if (sharedBaseline != null && Number.isFinite(sharedBaseline)) {
        baseline = sharedBaseline;
        usedSharedBaseline = true;
      }

      if (baseline == null || !Number.isFinite(baseline)) {
        setError(
          "Baseline prediction is unavailable for this zone, model, and timestamp. Try another timestamp or verify predictions data."
        );
        setRunState(null);
        return;
      }

      const scenarioPrediction = Math.max(0, Math.round(baseline * multiplier));
      const scenarioPressureRatio =
        denom != null && denom > 0 && Number.isFinite(scenarioPrediction) ? scenarioPrediction / denom : null;
      const estimatedPctChange = baseline !== 0 ? ((scenarioPrediction - baseline) / baseline) * 100 : null;
      const scenarioTier = tierFromScenarioRatio(scenarioPressureRatio);

      const breakdown = [
        { name: "Demand adjustment", value: Math.round(baseline * demandChangePercent) },
        { name: "Weather severity effect", value: Math.max(0, Math.round(baseline * weatherAdjustment)) },
        { name: "Incident level effect", value: Math.max(0, Math.round(baseline * incidentAdjustment)) },
        { name: "Event intensity effect", value: Math.max(0, Math.round(baseline * eventAdjustment)) },
      ];

      setRunState({
        model,
        baselinePrediction: baseline,
        scenarioPrediction,
        estimatedPctChange,
        scenarioPressureRatio,
        scenarioTier,
        multiplier,
        breakdown,
        usedSharedBaseline,
        rollMean24: roll24,
        barCompare: [
          { name: "Baseline", pickups: Math.round(baseline) },
          { name: "Scenario", pickups: scenarioPrediction },
        ],
      });
    } finally {
      setRunning(false);
      refreshHealth?.();
    }
  };

  const lineData = useMemo(() => {
    if (historyRows.length < 2) return [];
    return historyRows.map((r) => ({
      label: r.ts.slice(5, 16),
      indicator: Math.round(Number(r.v) * 1000) / 1000,
    }));
  }, [historyRows]);

  const interpretation = useMemo(() => {
    if (!runState) return [];
    const m = runState.model || "the selected model";
    const lines = [];
    const b = runState.baselinePrediction;
    const s = runState.scenarioPrediction;
    const tier = runState.scenarioTier;

    if (s > b) {
      lines.push(
        `Using ${m}, the selected assumptions increase the pickup-demand indicator compared with the baseline for this zone.`
      );
    } else if (s < b) {
      lines.push(
        `Using ${m}, the selected assumptions decrease the pickup-demand indicator compared with the baseline for this zone.`
      );
    } else {
      lines.push(`Using ${m}, the scenario matches the baseline indicator under the current assumptions.`);
    }

    lines.push(
      tier.key === "na"
        ? "Scenario pressure tier is unavailable because a rolling 24-hour baseline ratio could not be computed."
        : `The scenario falls into the ${tier.label} pressure tier${
            tier.key === "elevated" || tier.key === "high"
              ? ", suggesting closer planning review for similar conditions"
              : ""
          }.`
    );

    if (demandPct !== 0 || weatherSeverity > 0 || incidentLevel > 0 || eventIntensity > 0) {
      lines.push(
        "Demand, weather, incident, and/or event assumptions contribute to this scenario estimate alongside the model baseline."
      );
    }

    lines.push(
      "Treat this as what-if analysis and operational exploration — not as a direct waiting-time measurement or automated operational instruction."
    );

    return lines;
  }, [runState, demandPct, weatherSeverity, incidentLevel, eventIntensity]);

  const tierTone = runState?.scenarioPressureRatio != null ? pressureTone(runState.scenarioPressureRatio) : "neutral";

  return (
    <div className="space-y-5">
      <PageHeader showTitleStatusDot title="Simulation Lab" subtitle={subtitle} />

      <SectionCard
        title="Scenario Builder"
        subtitle="Choose zone, snapshot, model, and numeric assumptions, then run once to refresh the scenario estimate."
        bodyClassName="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField label="Selected Borough" value={borough} onChange={setBorough} options={BOROUGH_OPTIONS} />
          <SelectField
            label="Selected Model"
            value={model}
            onChange={setModel}
            options={modelOptions.length ? modelOptions : [{ value: "", label: "Loading…" }]}
          />
          <SelectField
            label="Snapshot timestamp"
            value={timestamp}
            onChange={setTimestamp}
            options={timestamps.slice(-280).reverse().map((t) => ({ value: t, label: t.slice(0, 16) }))}
          />
        </div>

        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-brand-muted">Selected Zone</label>
          <div className="relative mt-2">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-brand-muted"
              size={15}
              strokeWidth={2}
            />
            <input
              value={zoneSearch}
              onChange={(e) => setZoneSearch(e.target.value)}
              placeholder="Search by zone name or ID…"
              className="w-full rounded-lg border border-brand-border bg-white py-2 pl-9 pr-3 text-sm text-brand-text shadow-inner focus:border-brand-primary focus:outline-none"
            />
          </div>
          <select
            value={zoneId}
            onChange={(e) => setZoneId(e.target.value)}
            className="mt-2 w-full rounded-lg border border-brand-border bg-white px-3 py-2.5 text-sm text-brand-text shadow-inner focus:border-brand-primary focus:outline-none"
          >
            <option value="">Select a zone…</option>
            {zoneSelectList.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] leading-relaxed text-brand-muted">
            Zone list follows the borough filter. With All NYC, every available zone is listed.
          </p>
        </div>

        <div className="rounded-xl border border-emerald-100/80 bg-gradient-to-br from-white to-brand-mint/20 p-4 ring-1 ring-brand-primary/[0.06]">
          <p className="text-[11px] font-medium uppercase tracking-wide text-brand-muted">Active selection</p>
          <p className="mt-1 text-sm text-brand-text">
            <span className="font-semibold">{snapshotRow?.zone_name ?? "—"}</span>
            <span className="text-brand-muted"> · Zone </span>
            {formatNumber(zoneId, 0)}
            <span className="text-brand-muted"> · </span>
            {snapshotRow?.borough ?? "—"}
          </p>
          <p className="mt-1 text-xs text-brand-muted">
            Model <span className="font-medium text-brand-text">{model || "—"}</span>
            {sharedZoneBaseline != null ? (
              <>
                {" "}
                · Zone snapshot indicator{" "}
                <span className="font-medium text-brand-text">{formatNumber(Math.round(sharedZoneBaseline), 0)}</span>
              </>
            ) : null}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ScenarioSlider
            label="Demand Change"
            value={demandPct}
            onChange={setDemandPct}
            min={-30}
            max={70}
            step={5}
            formatValue={(v) => `${v >= 0 ? "+" : ""}${v}%`}
            helper="Adjusts the assumed pickup-demand level for the selected zone."
          />
          <ScenarioSlider
            label="Weather Severity"
            value={weatherSeverity}
            onChange={setWeatherSeverity}
            min={0}
            max={3}
            step={1}
            formatValue={(v) => `${v} / 3 — ${WEATHER_LABELS[v] ?? ""}`}
            helper="Adds weather-context pressure to the scenario estimate."
          />
          <ScenarioSlider
            label="Incident Level"
            value={incidentLevel}
            onChange={setIncidentLevel}
            min={0}
            max={3}
            step={1}
            formatValue={(v) => `${v} / 3 — ${INCIDENT_LABELS[v] ?? ""}`}
            helper="Adds disruption-context pressure to the scenario estimate."
          />
          <ScenarioSlider
            label="Event Intensity"
            value={eventIntensity}
            onChange={setEventIntensity}
            min={0}
            max={3}
            step={1}
            formatValue={(v) => `${v} / 3 — ${EVENT_LABELS[v] ?? ""}`}
            helper="Models an event-related demand surge assumption."
          />
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <GlassButton variant="primary" onClick={handleRun} disabled={running || !zoneId || !model}>
            <Play size={14} strokeWidth={2} />
            {running ? "Running…" : "Run Simulation"}
          </GlassButton>
          <GlassButton onClick={handleReset} disabled={running}>
            <RotateCcw size={14} strokeWidth={1.75} />
            Reset Scenario
          </GlassButton>
        </div>
      </SectionCard>

      <SectionCard
        title="Scenario Results"
        subtitle="Illustrative scenario estimate based on selected assumptions."
        bodyClassName="space-y-4"
      >
        {!runState ? (
          <p className="text-sm leading-relaxed text-brand-muted">
            Run the simulation to see KPIs, charts, and interpretation for the selected model and zone.
          </p>
        ) : (
          <>
            {runState.usedSharedBaseline ? (
              <p className="rounded-lg border border-slate-200/90 bg-slate-50/90 px-3 py-2 text-xs leading-relaxed text-slate-800">
                Model-specific prediction unavailable; using shared baseline estimate.
              </p>
            ) : null}

            <p className="rounded-lg border border-emerald-100/90 bg-emerald-50/40 px-3 py-2 text-xs leading-relaxed text-brand-text">
              Scenario prediction = baseline × {Number(runState.multiplier).toFixed(2)} (transparent scenario
              multiplier).
            </p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <KpiCard
                icon={FlaskConical}
                accent="teal"
                label="Baseline Prediction"
                value={formatNumber(Math.round(runState.baselinePrediction), 0)}
                subtext={`${runState.model} · before scenario`}
              />
              <KpiCard
                icon={FlaskConical}
                accent="mint"
                label="Scenario Prediction"
                value={formatNumber(runState.scenarioPrediction, 0)}
                subtext="After scenario assumptions"
              />
              <KpiCard
                icon={FlaskConical}
                accent="neutral"
                label="Estimated Change"
                value={formatPctSigned(runState.estimatedPctChange ?? 0)}
                subtext={`${runState.scenarioPrediction - runState.baselinePrediction >= 0 ? "+" : ""}${formatNumber(runState.scenarioPrediction - runState.baselinePrediction, 0)} pickups vs baseline`}
              />
              <KpiCard
                icon={FlaskConical}
                accent={tierTone === "critical" ? "danger" : tierTone === "warning" ? "warn" : "neutral"}
                label="Scenario Pressure Ratio"
                value={
                  runState.scenarioPressureRatio != null ? formatRatio(runState.scenarioPressureRatio) : "N/A"
                }
                subtext={
                  runState.rollMean24 != null
                    ? `vs 24h rolling baseline (${formatNumber(Math.round(runState.rollMean24), 0)})`
                    : "Rolling 24h baseline unavailable"
                }
              />
              <KpiCard
                icon={FlaskConical}
                accent="teal"
                label="Scenario Tier"
                value={runState.scenarioTier.label}
                subtext="From scenario pressure ratio bands"
              />
            </div>

            <div className="rounded-xl border border-brand-border bg-white p-3">
              <p className="text-xs font-semibold text-brand-text">Baseline vs Scenario Prediction</p>
              <div className="h-52 pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={runState.barCompare} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="pickups" radius={[6, 6, 0, 0]}>
                      {runState.barCompare.map((_, i) => (
                        <Cell key={i} fill={i === 0 ? "#94d2c9" : "#00856f"} />
                      ))}
                      <LabelList dataKey="pickups" position="top" formatter={(v) => formatNumber(v, 0)} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border border-brand-border bg-white p-3">
              <p className="text-xs font-semibold text-brand-text">Illustrative adjustment components</p>
              <p className="text-[11px] text-brand-muted">Pickup-space lift from each shared scenario channel.</p>
              <div className="h-52 pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={runState.breakdown} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={132} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => formatNumber(v, 0)} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {runState.breakdown.map((_, i) => (
                        <Cell key={i} fill={["#5ebfb0", "#3da89a", "#2c9588", "#00856f"][i % 4]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <TierGauge ratio={runState.scenarioPressureRatio} />

            {lineData.length >= 2 ? (
              <div className="rounded-xl border border-brand-border bg-white p-3">
                <p className="text-xs font-semibold text-brand-text">Recent Zone Context</p>
                <p className="text-[11px] text-brand-muted">Recent indicator history for {model} in this zone.</p>
                <div className="h-48 pt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={lineData}>
                      <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                      <XAxis dataKey="label" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
                      <Tooltip formatter={(v) => Number(v).toFixed(3)} />
                      <Line type="monotone" dataKey="indicator" stroke="#00856f" strokeWidth={2} dot={false} name="Indicator" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-brand-border bg-brand-bg/40 px-3 py-2 text-xs text-brand-muted">
                Recent zone history is unavailable for this selection.
              </p>
            )}

            <div className="rounded-xl border border-emerald-100/80 bg-gradient-to-br from-white to-brand-mint/15 p-4 ring-1 ring-brand-primary/[0.06]">
              <p className="text-sm font-semibold text-brand-text">Scenario Interpretation</p>
              <p className="mt-1 text-xs text-brand-muted">Planning-oriented reading for the selected model.</p>
              <ul className="mt-3 list-disc space-y-2 pl-4 text-sm leading-relaxed text-brand-text">
                {interpretation.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          </>
        )}
      </SectionCard>

      {error ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">{error}</div>
      ) : null}

      <SectionCard title="How to Read This Lab" subtitle="Short definitions for the demand-pressure indicator view.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <ExplainCard
            title="Baseline"
            body="The selected model's prediction before scenario adjustments."
          />
          <ExplainCard
            title="Scenario Estimate"
            body="A what-if estimate after applying selected demand, weather, incident, and event assumptions."
          />
          <ExplainCard
            title="Pressure Ratio"
            body="Pressure ratio compares predicted next-hour pickups with the recent 24-hour baseline for the same TLC zone."
          />
          <ExplainCard
            title="Indicator, Not Waiting Time"
            body="This lab uses demand-pressure indicators and does not directly measure passenger waiting minutes."
          />
          <ExplainCard
            title="Planning Use"
            body="Use results to compare scenarios and support planning review, not automated dispatch decisions."
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Potential Live Simulation Features"
        subtitle="These are future concepts if real-time company or authority data becomes available."
        bodyClassName="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FutureMini title="Live Demand Shock Testing" />
          <FutureMini title="Weather Event Scenario" />
          <FutureMini title="Incident Disruption Scenario" />
          <FutureMini title="Supply-Demand Coverage Scenario" />
          <FutureMini title="Event Surge Planning" />
          <FutureMini title="Multi-Zone Scenario Comparison" />
        </div>
      </SectionCard>

      <p className="text-[11px] leading-relaxed text-brand-muted">
        Scenario tiers use ratio bands: Low under 0.85×, Typical 0.85–1.15×, Elevated 1.15–1.35×, High from 1.35×.
        {baselineRatioFromData != null ? (
          <>
            {" "}
            Snapshot pressure ratio: {formatRatio(baselineRatioFromData)} ({pressureTierLabel(baselineRatioFromData)}).
          </>
        ) : null}
      </p>
    </div>
  );
}

function ScenarioSlider({ label, value, onChange, min, max, step, formatValue, helper }) {
  return (
    <div className="rounded-lg border border-brand-border/80 bg-white/90 p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-muted">{label}</span>
        <span className="text-sm font-semibold tabular-nums text-brand-text">{formatValue(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full bg-brand-mint/50 accent-brand-primary"
      />
      {helper ? <p className="mt-2 text-[11px] leading-relaxed text-brand-muted">{helper}</p> : null}
    </div>
  );
}

function ExplainCard({ title, body }) {
  return (
    <div className="rounded-xl border border-emerald-100/80 bg-gradient-to-br from-white to-emerald-50/40 p-3 shadow-sm">
      <p className="text-xs font-semibold text-brand-text">{title}</p>
      <p className="mt-2 text-[11px] leading-relaxed text-brand-muted">{body}</p>
    </div>
  );
}

function FutureMini({ title }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-dashed border-brand-border/90 bg-brand-bg/30 px-3 py-3">
      <span className="h-2 w-2 shrink-0 rounded-full bg-brand-teal/50" />
      <p className="text-xs font-medium leading-snug text-brand-text">{title}</p>
    </div>
  );
}

function TierGauge({ ratio }) {
  const r = Number(ratio);
  const bands = [
    { key: "low", label: "Low", widthPct: 28.333, color: "bg-sky-200/80" },
    { key: "typ", label: "Typical", widthPct: 33.333, color: "bg-emerald-200/80" },
    { key: "el", label: "Elevated", widthPct: 16.667, color: "bg-amber-200/80" },
    { key: "hi", label: "High", widthPct: 21.667, color: "bg-rose-200/80" },
  ];
  const minR = 0.5;
  const maxR = 1.6;
  const clamped = Number.isFinite(r) ? Math.min(maxR, Math.max(minR, r)) : minR;
  const t = (clamped - minR) / (maxR - minR);
  const markerPct = t * 100;

  return (
    <div className="rounded-xl border border-brand-border bg-white p-3">
      <p className="text-xs font-semibold text-brand-text">Scenario Pressure Tier</p>
      <p className="text-[11px] text-brand-muted">Where the scenario ratio sits across Low / Typical / Elevated / High.</p>
      <div className="relative mt-4 pb-6">
        <div className="flex h-3 overflow-hidden rounded-full ring-1 ring-brand-border/60">
          {bands.map((b) => (
            <div key={b.key} className={`${b.color} h-full`} style={{ width: `${b.widthPct}%` }} title={b.label} />
          ))}
        </div>
        <div
          className="absolute top-[-2px] flex flex-col items-center"
          style={{ left: `calc(${markerPct}% - 6px)` }}
        >
          <span className="h-0 w-0 border-x-[6px] border-b-[8px] border-x-transparent border-b-brand-primary" />
        </div>
        <div className="mt-2 flex justify-between text-[10px] font-medium text-brand-muted">
          <span>Low</span>
          <span>Typical</span>
          <span>Elevated</span>
          <span>High</span>
        </div>
        {!Number.isFinite(r) ? (
          <p className="mt-2 text-[11px] text-brand-muted">Ratio unavailable (rolling baseline missing).</p>
        ) : (
          <p className="mt-2 text-xs text-brand-text">
            Current ratio: <span className="font-semibold tabular-nums">{formatRatio(r)}</span> ·{" "}
            {tierFromScenarioRatio(r).label}
          </p>
        )}
      </div>
    </div>
  );
}
