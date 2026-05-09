import { useEffect, useMemo, useState } from "react";
import { RefreshCcw, Trophy, BarChart2, Layers } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  ZAxis,
  Cell,
} from "recharts";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import DataTable from "../components/DataTable";
import GlassButton from "../components/GlassButton";
import SelectField from "../components/SelectField";
import { getModelMetrics, getModelPredictions } from "../lib/api";
import { formatDecimal, formatNumber } from "../lib/format";

const LOG = "[MASEER]";

function aggregatePredictionsByTime(rows) {
  const m = {};
  for (const r of rows ?? []) {
    const t = r.timestamp;
    if (!t) continue;
    const a = Number(r.actual ?? r.y_true ?? 0);
    const p = Number(r.predicted ?? r.y_pred ?? 0);
    if (!m[t]) m[t] = { a: [], p: [] };
    m[t].a.push(a);
    m[t].p.push(p);
  }
  const out = Object.entries(m).map(([t, bundle]) => {
    const avg = (arr) =>
      arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
    return {
      timestamp: t,
      actualAvg: avg(bundle.a),
      predAvg: avg(bundle.p),
    };
  });
  out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return out;
}

export default function ModelPerformance({ overview, apiOnline }) {
  const subtitle =
    "Model cards stay tied to TLC pickup targets (`target_pickup_count_next_hour`) — error metrics summarize holdout fit, not waiting minutes.";

  const [metricsPack, setMetricsPack] = useState(null);
  const [predModel, setPredModel] = useState("");
  const [predictions, setPredictions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchErrors, setFetchErrors] = useState({});

  const allowStaticFallback = apiOnline !== true;

  const loadAll = async (modelKey) => {
    setLoading(true);
    try {
      if (apiOnline === null) return;
      const mp = await getModelMetrics({ allowStaticFallback });
      if (mp.ok === false) {
        console.warn(`${LOG} model metrics:`, mp.error);
        setFetchErrors((e) => ({ ...e, metrics: mp.error || "Failed" }));
      } else {
        setFetchErrors((e) => {
          const n = { ...e };
          delete n.metrics;
          return n;
        });
        setMetricsPack(mp.data ?? null);
      }
      const best =
        (mp.ok !== false ? mp.data?.best_tabular_model : null) ??
        overview?.best_tabular_model ??
        "";
      const useModel =
        modelKey ||
        predModel ||
        best ||
        (mp.ok !== false ? mp.data?.model_metrics?.[0]?.model_name ?? "" : "");
      const pr = await getModelPredictions({
        model: useModel || undefined,
        limit: 2400,
        allowStaticFallback,
      });
      if (pr.ok === false) {
        console.warn(`${LOG} model predictions:`, pr.error);
        setFetchErrors((e) => ({ ...e, predictions: pr.error || "Failed" }));
      } else {
        setFetchErrors((e) => {
          const n = { ...e };
          delete n.predictions;
          return n;
        });
        setPredictions(pr.rows ?? []);
      }
      if (!predModel && useModel) setPredModel(String(useModel));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview?.best_tabular_model, apiOnline]);

  const showBlocking = loading || apiOnline === null;

  const modelMetrics = metricsPack?.model_metrics ?? [];
  const forecastMetrics = metricsPack?.forecast_metrics ?? [];
  const contextual = metricsPack?.contextual_comparison ?? [];

  const sortedTabular = useMemo(() => [...modelMetrics].sort((a, b) => (a.test_rmse ?? 9e9) - (b.test_rmse ?? 9e9)), [modelMetrics]);
  const bestName = sortedTabular[0]?.model_name ?? metricsPack?.best_tabular_model ?? "N/A";

  const leaderboardRows = sortedTabular;

  const compareBars = sortedTabular.slice(0, 7).map((m) => ({
    name: m.model_name ?? "Model",
    mae: Number(m.test_mae ?? NaN),
    rmse: Number(m.test_rmse ?? NaN),
  }));

  const xgbCompare = contextual.find((c) => String(c.model_name).toLowerCase().includes("xgboost"));

  const contextLines = aggregatePredictionsByTime(predictions.slice(0, 2000));

  const predsHaveSeries = contextLines.length >= 4;

  const scatterDots = predictions.slice(0, 400).map((r, i) => ({
    i,
    actual: Number(r.actual ?? r.y_true ?? NaN),
    pred: Number(r.predicted ?? r.y_pred ?? NaN),
  })).filter((d) => Number.isFinite(d.actual) && Number.isFinite(d.pred));

  const fcBars = [...forecastMetrics]
    .sort((a, b) => (a.rmse ?? 9e9) - (b.rmse ?? 9e9))
    .slice(0, 8);

  const modelOptions = [
    ...new Set([...(modelMetrics ?? []).map((r) => r.model_name)].filter(Boolean)),
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Model Performance" subtitle={subtitle}>
        <SelectField
          label="Prediction trace model"
          value={predModel}
          onChange={(m) => {
            setPredModel(m);
            loadAll(m);
          }}
          options={modelOptions.map((m) => ({ value: m, label: m }))}
          placeholder={modelOptions.length ? "Choose model" : "No leaderboard"}
        />
        <GlassButton variant="primary" onClick={() => loadAll(predModel)}>
          <RefreshCcw size={16} strokeWidth={1.75} />
          Refresh
        </GlassButton>
      </PageHeader>

      {showBlocking ? (
        <div className="rounded-xl border bg-white px-4 py-3 text-sm text-brand-muted shadow-card">Refreshing metrics payloads…</div>
      ) : null}

      {!showBlocking && (fetchErrors.metrics || fetchErrors.predictions) ? (
        <div className="space-y-1 text-xs text-rose-600">
          {fetchErrors.metrics ? <p>Model metrics: {fetchErrors.metrics}</p> : null}
          {fetchErrors.predictions ? <p>Predictions preview: {fetchErrors.predictions}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-4">
        <KpiCard icon={Trophy} accent="teal" label="Best Next-Hour Model" value={bestName ?? "—"} subtext={`Selected by lowest holdout RMSE in export`} />
        <KpiCard
          icon={BarChart2}
          accent="mint"
          label="Test RMSE (best tabular)"
          value={sortedTabular[0]?.test_rmse != null ? formatDecimal(sortedTabular[0].test_rmse, 3) : "N/A"}
          subtext={`MAE ${sortedTabular[0]?.test_mae != null ? formatDecimal(sortedTabular[0].test_mae, 3) : "—"} • R² ${sortedTabular[0]?.test_r2 != null ? formatDecimal(sortedTabular[0].test_r2, 3) : "—"}`}
        />
        <KpiCard
          icon={Layers}
          accent="neutral"
          label="Holdout Rows (preview)"
          value={formatNumber(predictions?.length ?? 0, 0)}
          subtext={predModel ? `Model: ${predModel}` : "Pick a trace model"}
        />
        <KpiCard icon={Layers} accent="neutral" label="24H Forecaster" value={metricsPack?.best_forecast_model ?? "N/A"} subtext={`Lowest exported RMSE in forecast_metrics`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <SectionCard title="Next-Hour RMSE Leaderboard" subtitle="Horizontal view — lower is better" className="xl:col-span-2">
          {sortedTabular.length ? (
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={[...sortedTabular].reverse().slice(0, 10)} margin={{ left: 12 }}>
                  <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => `${formatDecimal(v, 2)}`} />
                  <YAxis type="category" dataKey="model_name" width={120} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value) => formatDecimal(value, 4)} />
                  <Bar dataKey="test_rmse" radius={[0, 6, 6, 0]} name="Test RMSE">
                    {[...(sortedTabular)].reverse().slice(0, 10).map((_, i, arr) => (
                      <Cell key={i} fill={i === arr.length - 1 ? "#00856f" : "#BFEFE3"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-sm text-brand-muted">Model metrics CSV/JSON export not present.</p>
          )}
        </SectionCard>

        <SectionCard title="MAE vs RMSE (Top Candidates)" subtitle="Comparable loss scales • R² in KPI tiles" className="xl:col-span-3">
          {compareBars.length ? (
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={compareBars}>
                  <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-18} textAnchor="end" height={70} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="rmse" fill="#00856f" name="RMSE" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="mae" fill="#66736d" name="MAE" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyNote />
          )}
        </SectionCard>
      </div>

      <SectionCard title="Contextual Integration vs Base (export)" subtitle="Laboratory deltas from contextual_comparison payload">
        {xgbCompare ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[
                    { segment: "Base", rmse: xgbCompare.base_test_rmse, mae: xgbCompare.base_test_mae },
                    { segment: "Contextual", rmse: xgbCompare.context_test_rmse, mae: xgbCompare.context_test_mae },
                  ]}
                  margin={{ top: 8 }}
                >
                  <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                  <XAxis dataKey="segment" />
                  <YAxis />
                  <Tooltip formatter={(value) => formatDecimal(value, 4)} />
                  <Legend />
                  <Bar dataKey="rmse" fill="#00856f" />
                  <Bar dataKey="mae" fill="#BFEFE3" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="rounded-lg border border-brand-border bg-brand-bg/40 p-4 text-sm leading-relaxed text-brand-muted">
              <p className="font-semibold text-brand-text">Interpretation checklist</p>
              <ul className="mt-2 list-disc space-y-2 pl-4">
                <li>Δ RMSE {(xgbCompare.rmse_delta ?? 0) >= 0 ? "+" : ""}
                  {formatDecimal(xgbCompare.rmse_delta ?? 0, 4)} between base and enriched feature bundles.</li>
                <li>Δ R² {(xgbCompare.r2_delta ?? 0) >= 0 ? "+" : ""}
                  {formatDecimal(xgbCompare.r2_delta ?? 0, 4)} — watch overfitting alongside weather/event signals.</li>
                <li>All statements reference pickup counts rather than unseen queue-time labels.</li>
              </ul>
            </div>
          </div>
        ) : contextual.length === 0 ? (
          <EmptyNote />
        ) : (
          <DataTable
            columns={[
              { key: "model_name", label: "Model" },
              { key: "base_test_rmse", label: "Base RMSE", render: (v) => formatDecimal(v, 3) },
              { key: "context_test_rmse", label: "Context RMSE", render: (v) => formatDecimal(v, 3) },
              { key: "improved_with_context", label: "Improved?", render: (v) => String(!!v) },
            ]}
            rows={contextual}
            maxRows={12}
          />
        )}
      </SectionCard>

      <SectionCard title="Actual vs Predicted Trace" subtitle={`Rolling mean by timestamp (${predModel || "mixed"}) — preview sample`}>
        {predsHaveSeries ? (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={contextLines.slice(-140)}>
                <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" />
                <XAxis dataKey="timestamp" tick={{ fontSize: 9 }} hide />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip labelFormatter={(l) => l} formatter={(value) => formatDecimal(value, 3)} />
                <Legend />
                <Line type="monotone" dataKey="actualAvg" stroke="#00856f" name="Actual (hourly mean)" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="predAvg" stroke="#F7B731" name="Predicted (hourly mean)" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : scatterDots.length > 40 ? (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ bottom: 8 }}>
                <CartesianGrid strokeDasharray="5 10" stroke="#E3EEE9" />
                <XAxis type="number" dataKey="actual" name="Actual pickups" domain={["auto", "auto"]} />
                <YAxis type="number" dataKey="pred" name="Predicted pickups" domain={["auto", "auto"]} />
                <ZAxis range={[18, 18]} />
                <Tooltip formatter={(value) => formatDecimal(value, 3)} />
                <Scatter data={scatterDots} fill="#00856f77" />
              </ScatterChart>
            </ResponsiveContainer>
            <p className="mt-3 text-[11px] text-brand-muted">
              Timestamp diversity is sparse in this artifact — depicting an Actual vs Predicted scatter instead.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-brand-muted">
              Prediction preview does not expose enough granularity for charts — excerpting the leaderboard table slice below.
            </p>
            <DataTable
              columns={[
                { key: "timestamp", label: "Time", render: (v) => (v ?? "").slice(0, 19) },
                { key: "zone_id", label: "Zone" },
                {
                  key: "actual",
                  label: "Actual",
                  render: (v, r) => formatDecimal(Number(v ?? r.y_true ?? 0), 3),
                },
                {
                  key: "predicted",
                  label: "Pred.",
                  render: (v, r) => formatDecimal(Number(v ?? r.y_pred ?? 0), 3),
                },
              ]}
              rows={predictions}
              maxRows={12}
            />
          </>
        )}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-5">
        <SectionCard title="Full Model Leaderboard" subtitle="All exported tabular models" className="lg:col-span-3">
          <DataTable
            columns={[
              { key: "model_name", label: "Model" },
              { key: "test_rmse", label: "RMSE", render: (v) => formatDecimal(v, 4) },
              { key: "test_mae", label: "MAE", render: (v) => formatDecimal(v, 4) },
              { key: "test_r2", label: "R²", render: (v) => formatDecimal(v, 4) },
            ]}
            rows={leaderboardRows}
            maxRows={50}
          />
        </SectionCard>

        <SectionCard title="24H Forecast Bench" subtitle="Exported forecast_metrics artifact" className="lg:col-span-2">
          {fcBars.length ? (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={[...fcBars].reverse()} margin={{ left: 8 }}>
                  <CartesianGrid strokeDasharray="4 8" stroke="#E3EEE9" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => `${formatDecimal(v, 2)}`} />
                  <YAxis type="category" width={136} tick={{ fontSize: 10 }} dataKey="model_name" />
                  <Tooltip formatter={(value) => formatDecimal(value, 4)} />
                  <Bar dataKey="rmse" radius={[0, 6, 6, 0]} name="Forecast RMSE" fill="#003D34" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyNote />
          )}
          <div className="mt-6">
          <DataTable
            columns={[
              { key: "model_name", label: "Forecaster" },
              { key: "rmse", label: "RMSE", render: (v) => formatDecimal(v, 3) },
              { key: "mae", label: "MAE", render: (v) => formatDecimal(v, 3) },
            ]}
            rows={forecastMetrics}
            maxRows={8}
          />
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ExplanationCard title="Why XGBoost-class models for next-hour?" body="Tree ensembles capture nonlinear weather, disruption scores, and zone-hour crossings without prescribing a fixed seasonal form. Exported metrics quantify lift vs smoother baselines (SARIMA, Prophet) — always anchored to TLC pickup counts, not unseen queue waits." badge="tabular" />
        <ExplanationCard title="Why GRU/LSTM stacks for multi-hour horizons?" body="Sequences over longer windows capture smoothed workloads between boroughs when features stack temporally—use these curves for pacing and staffing outlooks paired with TLC proxy targets rather than instantaneous enforcement thresholds." badge="forecast" />
      </div>

      <p className="text-[11px] text-brand-muted">
        Displayed KPIs originate from bundled metrics JSON — they do not mutate live inference unless the FastAPI service is hydrated with regenerated artifacts.
      </p>
    </div>
  );
}

function ExplanationCard({ title, body, badge }) {
  return (
    <div className="rounded-xl border border-brand-border bg-gradient-to-br from-white to-brand-bg p-5 shadow-card">
      <div className="mb-3 inline-flex items-center rounded-full bg-brand-mint px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-primary">
        {badge}
      </div>
      <h4 className="text-lg font-semibold text-brand-text">{title}</h4>
      <p className="mt-2 text-sm leading-relaxed text-brand-muted">{body}</p>
    </div>
  );
}

function EmptyNote() {
  return (
    <p className="rounded-lg border border-dashed border-brand-border bg-brand-bg p-8 text-center text-sm text-brand-muted">
      Chart data not available — export metrics or enable the `/api/models/metrics` feed.
    </p>
  );
}
