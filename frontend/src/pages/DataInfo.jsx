import { Fragment, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  RefreshCcw,
  Sparkles,
  Layers,
  ImageIcon,
  Table2,
  CloudSun,
  Route,
  MapPinned,
  AlertTriangle,
  CalendarRange,
  Crosshair,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import PageHeader from "../components/PageHeader";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import DataTable from "../components/DataTable";
import GlassButton from "../components/GlassButton";
import {
  getDataInfo,
  getFigures,
  apiUrl,
  peekCachedApiUrl,
  peekCachedDataInfo,
} from "../lib/api";
import { formatNumber } from "../lib/format";

const LOG = "[MASEER]";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "pipeline", label: "Pipeline" },
  { id: "quality", label: "Data quality" },
  { id: "features", label: "Feature dictionary" },
  { id: "context", label: "Incident & weather" },
  { id: "artifacts", label: "Figures & artifacts" },
];

const PIPELINE_STEPS = [
  {
    title: "TLC trip records",
    body: "Aggregate TLC trips into hourly pickup counts per NYC taxi zone.",
    Icon: Route,
  },
  {
    title: "Taxi zone geometry / lookup",
    body: "Zone IDs, names, boroughs, and exported GeoJSON support mapping and joins.",
    Icon: MapPinned,
  },
  {
    title: "Weather context",
    body: "Hourly weather fields aligned to each zone-hour where present in the export.",
    Icon: CloudSun,
  },
  {
    title: "Incident / event context",
    body: "Disruption indicators cleaned, geocoded to zones when possible, merged on the timeline.",
    Icon: AlertTriangle,
  },
  {
    title: "Feature engineering",
    body: "Lags, rolling baselines (incl. 24h mean for Pressure Ratio), calendar signals, weather, events, interactions.",
    Icon: Sparkles,
  },
  {
    title: "Model-ready dataset",
    body: "Final zone-hour table for supervised next-hour demand: target_pickup_count_next_hour.",
    Icon: Table2,
  },
];

/** Static export files wired through `frontend/src/lib/api.js` (same as `public/data/`). */
const DASHBOARD_ARTIFACTS = [
  {
    file: "dataset_summary.json",
    purpose: "Row/column counts, zone count, time span, target column, weather/event column lists, and source labels for the merged zone-hour export.",
    usedIn: "Data Information, overview fallback merge",
    filter: "data",
  },
  {
    file: "feature_dictionary.json",
    purpose: "Per-column dtype, feature group, and missingness for exported modeling columns.",
    usedIn: "Data Information",
    filter: "features",
  },
  {
    file: "event_integration_summary.json",
    purpose: "Preprocessing counts for raw events through zone mapping and merge into the final modeling rows.",
    usedIn: "Data Information",
    filter: "events",
  },
  {
    file: "overview.json",
    purpose: "Project metadata, target definition, indicator note, best models, and data source labels.",
    usedIn: "Dashboard, Data Information, static API fallback",
    filter: "dashboard",
  },
  {
    file: "zone_pressure.json",
    purpose: "Zone-hour snapshots with pickups, targets, predictions, Pressure Ratio, and context fields for maps and charts.",
    usedIn: "Dashboard, map, trends, heatmap, timestamps fallback",
    filter: "dashboard",
  },
  {
    file: "taxi_zones.geojson",
    purpose: "TLC taxi zone boundaries for map rendering when the zones API is unavailable.",
    usedIn: "Map (static fallback)",
    filter: "dashboard",
  },
  {
    file: "model_metrics.json",
    purpose: "Tabular model evaluation metrics used on the Model Performance page.",
    usedIn: "Model Performance, models list fallback",
    filter: "models",
  },
  {
    file: "forecast_metrics.json",
    purpose: "Forecast scenario metrics for longer-horizon models.",
    usedIn: "Model Performance (static fallback bundle)",
    filter: "models",
  },
  {
    file: "contextual_comparison.json",
    purpose: "Contextual performance comparisons between model configurations.",
    usedIn: "Model Performance (static fallback bundle)",
    filter: "models",
  },
  {
    file: "predictions_preview.json",
    purpose: "Sample of model predictions for tables and previews.",
    usedIn: "Model Performance (static fallback)",
    filter: "models",
  },
  {
    file: "top_zones.json",
    purpose: "Ranked zone summaries for dashboard highlights.",
    usedIn: "Dashboard data bundle",
    filter: "dashboard",
  },
  {
    file: "scenario_defaults.json",
    purpose: "Default simulation parameters shipped with the export (for scenario tooling when wired in).",
    usedIn: "Present in `public/data`; listed in `api.js` static fallback paths",
    filter: "dashboard",
  },
  {
    file: "app_config.json",
    purpose: "Optional app configuration payload shipped with the export.",
    usedIn: "Present in `public/data`; listed in `api.js` static fallback paths",
    filter: "dashboard",
  },
];

const GALLERY_FILTER_TABS = [
  { id: "all", label: "All" },
  { id: "data", label: "Data" },
  { id: "features", label: "Features" },
  { id: "events", label: "Events / weather" },
  { id: "models", label: "Models" },
  { id: "dashboard", label: "Dashboard" },
];

const FEATURE_GROUP_LABELS = {
  taxi_demand_features: "Taxi demand & calendar",
  taxi_zone_lookup_features: "Zone / borough lookup",
  weather_features: "Weather",
  event_incident_features: "Incident & event",
  lag_rolling_calendar_features: "Lag & rolling demand",
  interaction_features: "Interaction terms",
  target: "Target variable",
};

const WEATHER_LABELS = {
  temperature: "Temperature",
  precipitation: "Precipitation",
  snowfall: "Snowfall",
  wind_speed: "Wind speed",
  humidity: "Humidity",
  weather_category: "Weather category",
  rain_indicator: "Rain indicator",
  heavy_rain_indicator: "Heavy rain indicator",
  snowfall_indicator: "Snowfall indicator",
  weather_available: "Weather availability flag",
};

export default function DataInfo({ refreshHealth, apiOnline }) {
  const headerSubtitle =
    "Transparent overview of the datasets, preprocessing pipeline, feature artifacts, and modeling target behind MASEER.";

  const headerFooter = (
    <p className="text-sm leading-relaxed text-brand-muted">
      This page documents the exported data artifacts used by the dashboard, including zone-hour features, weather and
      incident context, feature definitions, model evaluation files, and the final next-hour pickup-demand target.
    </p>
  );

  const [tab, setTab] = useState("overview");
  const [bundle, setBundle] = useState(() => peekCachedDataInfo()?.data ?? null);
  const [figures, setFigures] = useState(() => {
    const peek = peekCachedApiUrl(apiUrl("figures"));
    if (peek?.ok && Array.isArray(peek.data?.figures)) return peek.data.figures;
    if (peek?.ok && Array.isArray(peek.data?.rows)) return peek.data.rows;
    return [];
  });
  const [featQ, setFeatQ] = useState("");
  const [galleryFilter, setGalleryFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [softRefreshing, setSoftRefreshing] = useState(false);
  const [fetchErrors, setFetchErrors] = useState({});

  useLayoutEffect(() => {
    if (apiOnline === null) return;
    const peekedBundle = peekCachedDataInfo();
    if (peekedBundle?.data) {
      setBundle((prev) => prev ?? peekedBundle.data);
    }
    const figPeek = peekCachedApiUrl(apiUrl("figures"));
    if (figPeek?.ok) {
      const next = Array.isArray(figPeek.data?.figures)
        ? figPeek.data.figures
        : Array.isArray(figPeek.data?.rows)
          ? figPeek.data.rows
          : null;
      if (next) setFigures((prev) => (prev?.length ? prev : next));
    }
  }, [apiOnline]);

  const load = async ({ forceRefresh = false } = {}) => {
    if (apiOnline === null) return;
    const allowStaticFallback = apiOnline !== true;
    if (!bundle || forceRefresh) {
      if (!bundle) setLoading(true);
      else setSoftRefreshing(true);
    }
    try {
      const [di, fg] = await Promise.all([
        getDataInfo({ allowStaticFallback, forceRefresh }),
        getFigures({ allowStaticFallback, forceRefresh }),
      ]);
      setBundle(di.data ?? null);
      const nextErr = {};
      if (di.ok === false) {
        const parts = [di.errors?.overview, di.errors?.modelMetrics].filter(Boolean).join(" • ");
        console.warn(`${LOG} data info partial failure:`, parts || "overview or model metrics");
        nextErr.dataInfo = parts || "Some API slices failed; static files still shown where available.";
      }
      if (fg.ok === false) {
        console.warn(`${LOG} figures:`, fg.error);
        nextErr.figures = fg.error || "Figures API failed";
      }
      setFetchErrors(nextErr);
      if (fg.ok !== false) setFigures(fg.rows ?? []);
    } finally {
      setLoading(false);
      setSoftRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOnline]);

  const ds = bundle?.dataset_summary ?? {};
  const feats = bundle?.feature_dictionary ?? [];
  const events = bundle?.event_integration_summary ?? [];
  const eventRow = Array.isArray(events) && events.length ? events[0] : null;
  const targ = bundle?.target_explanation ?? {};
  const overviewSources = bundle?.data_sources ?? ds.data_sources ?? [];

  const featureGroupCount = useMemo(() => {
    const s = new Set();
    for (const r of feats) {
      if (r?.feature_group) s.add(r.feature_group);
    }
    return s.size;
  }, [feats]);

  const featureRowsPrepared = useMemo(() => {
    return feats.map((row) => {
      const col = row.column ?? "";
      const g = row.feature_group ?? "";
      const desc = row.description ?? deriveFeatureDescription(col, g);
      const usedFor = featureUsedForLabel(g);
      return {
        ...row,
        _groupLabel: FEATURE_GROUP_LABELS[g] ?? humanizeSnake(g),
        _description: desc,
        _usedFor: usedFor,
      };
    });
  }, [feats]);

  const filteredFeats = useMemo(() => {
    const q = featQ.trim().toLowerCase();
    if (!q) return featureRowsPrepared;
    return featureRowsPrepared.filter((row) =>
      [`${row.column ?? ""}`, `${row._groupLabel ?? ""}`, `${row.feature_group ?? ""}`, `${row._description ?? ""}`, `${row._usedFor ?? ""}`]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [featQ, featureRowsPrepared]);

  const featRowsNumbered = useMemo(
    () => filteredFeats.map((row, i) => ({ ...row, _seq: i + 1 })),
    [filteredFeats]
  );

  const modelingRows = pickFiniteNumber(ds.rows, ds.number_of_final_merged_rows, eventRow?.number_of_final_merged_rows);
  const zoneCount = pickFiniteNumber(ds.number_of_zones);
  const timeStart = ds.time_range_start ?? null;
  const timeEnd = ds.time_range_end ?? null;
  const weatherCols = Array.isArray(ds.available_weather_columns) ? ds.available_weather_columns : [];
  const eventCols = Array.isArray(ds.available_event_columns) ? ds.available_event_columns : [];

  const figureCards = useMemo(() => {
    const rows = Array.isArray(figures) ? figures : [];
    return rows
      .filter((f) => typeof f?.url === "string" && f.url.length > 0)
      .map((f, idx) => ({
        ...f,
        _key: `${f.path ?? f.url ?? "fig"}-${idx}`,
        _category: inferFigureCategory(f),
      }));
  }, [figures]);

  const filteredFigures = useMemo(() => {
    if (galleryFilter === "all") return figureCards;
    return figureCards.filter((f) => galleryCategoryId(f) === galleryFilter);
  }, [figureCards, galleryFilter]);

  const imgs = figureCards;

  const fullTargetColumn = ds.target_column ?? "target_pickup_count_next_hour";

  const kpiTimeRange = useMemo(() => {
    if (!timeStart || !timeEnd) {
      return {
        value: "N/A",
        valueClassName: "",
        subtext: "Not available in current export",
      };
    }
    return {
      value: `${formatTimestampLabel(timeStart)}\n→\n${formatTimestampLabel(timeEnd)}`,
      valueClassName: "whitespace-pre-line text-base leading-tight sm:text-lg",
      subtext: "From `dataset_summary` export",
    };
  }, [timeStart, timeEnd]);

  const kpiContextSubtext = useMemo(() => {
    if (!weatherCols.length && !eventCols.length) return "Not available in current export";
    return `${formatNumber(weatherCols.length, 0)} weather fields\n${formatNumber(eventCols.length, 0)} incident/event fields in export`;
  }, [weatherCols.length, eventCols.length]);

  return (
    <div className="space-y-5">
      <PageHeader showTitleStatusDot title="Data Information" subtitle={headerSubtitle} footer={headerFooter}>
        <GlassButton
          variant="primary"
          onClick={async () => {
            await refreshHealth?.({ forceRefresh: true });
            await load({ forceRefresh: true });
          }}
        >
          <RefreshCcw size={16} strokeWidth={1.75} />
          Refresh
        </GlassButton>
      </PageHeader>

      {apiOnline === null || (loading && bundle == null) ? (
        <div className="rounded-xl border bg-white px-4 py-3 text-sm text-brand-muted shadow-card">Refreshing metadata…</div>
      ) : null}

      {softRefreshing ? <p className="text-xs font-semibold text-brand-muted">Updating…</p> : null}

      {fetchErrors.dataInfo || fetchErrors.figures ? (
        <div className="space-y-1 text-xs text-rose-600">
          {fetchErrors.dataInfo ? <p>{fetchErrors.dataInfo}</p> : null}
          {fetchErrors.figures ? <p>Figures: {fetchErrors.figures}</p> : null}
        </div>
      ) : null}

      <div className="grid auto-rows-fr min-w-0 grid-cols-1 items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          allowValueWrap
          valueClassName="whitespace-nowrap"
          icon={Table2}
          accent="teal"
          label="Final modeling rows"
          value={formatNumber(modelingRows, 0)}
          subtext={modelingRows == null ? "Not available in current export" : "From `dataset_summary` export"}
        />
        <KpiCard
          allowValueWrap
          valueClassName="whitespace-nowrap"
          icon={MapPinned}
          accent="mint"
          label="Unique TLC zones"
          value={formatNumber(zoneCount, 0)}
          subtext={zoneCount == null ? "Not available in current export" : "Distinct zones in merged export"}
        />
        <KpiCard
          allowValueWrap
          valueClassName={kpiTimeRange.valueClassName}
          icon={CalendarRange}
          accent="neutral"
          label="Time range"
          value={kpiTimeRange.value}
          subtext={kpiTimeRange.subtext}
        />
        <KpiCard
          allowValueWrap
          valueClassName="proportional-nums"
          icon={Crosshair}
          accent="teal"
          label="Target variable"
          value="Next-hour pickup demand"
          valueTitle={fullTargetColumn}
          subtext={`Column: ${fullTargetColumn}`}
        />
        <KpiCard
          allowValueWrap
          valueClassName="whitespace-nowrap"
          icon={Layers}
          accent="mint"
          label="Feature groups"
          value={feats.length ? formatNumber(featureGroupCount, 0) : "N/A"}
          subtext={
            feats.length
              ? `${formatNumber(feats.length, 0)} columns in dictionary`
              : "Not available in current export"
          }
        />
        <KpiCard
          allowValueWrap
          valueClassName="whitespace-nowrap"
          icon={CloudSun}
          accent="neutral"
          label="Context signals"
          value={weatherCols.length || eventCols.length ? "Exported" : "N/A"}
          subtext={kpiContextSubtext}
          subtextClassName={weatherCols.length || eventCols.length ? "whitespace-pre-line" : ""}
        />
      </div>

      <SectionCard title="Data pipeline overview" subtitle="End-to-end flow reflected in the exported zone-hour modeling table">
        <PipelineProcessDiagram steps={PIPELINE_STEPS} />
      </SectionCard>

      <div className="flex flex-wrap gap-2 rounded-xl border border-brand-border bg-white p-2 shadow-card">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wide ${
              tab === t.id ? "bg-brand-primary text-white shadow-card" : "text-brand-muted hover:bg-brand-bg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="space-y-4">
          <SectionCard
            title="Modeling target and dashboard metrics"
            subtitle="How the supervised target and Pressure Ratio relate to the dashboard (no live fleet data)"
          >
            <div className="grid gap-3 md:grid-cols-2">
              <MetricExplainCard
                title="Target variable"
                code="target_pickup_count_next_hour"
                body="The supervised learning target is the next-hour TLC yellow-taxi pickup count for each zone-hour record, as stated in the exported overview metadata."
              />
              <MetricExplainCard
                title="Predicted pickups"
                code="predicted_next_hour_pickups (where present)"
                body="The model estimate of next-hour pickup demand for a zone-hour, surfaced on the dashboard from predictions joined to the zone-hour snapshot export."
              />
              <div className="rounded-xl border border-brand-mint bg-maseer-mint/30 p-4">
                <div className="text-sm font-semibold text-brand-text">Pressure Ratio</div>
                <p className="mt-2 font-mono text-xs text-brand-deep">
                  Pressure Ratio = predicted next-hour pickups ÷ rolling 24-hour average pickups
                </p>
                <p className="mt-2 text-sm leading-relaxed text-brand-muted">
                  Pressure Ratio compares predicted demand with the recent 24-hour baseline for the same TLC zone (see
                  `pickup_count_roll_mean_24` in the feature dictionary). Higher values indicate stronger demand pressure
                  relative to the zone&apos;s recent baseline.
                </p>
              </div>
              <div className="rounded-xl border border-brand-border bg-brand-bg/80 p-4">
                <div className="text-sm font-semibold text-brand-text">Demand-pressure indicator</div>
                <p className="mt-2 text-sm leading-relaxed text-brand-muted">
                  An indirect indicator showing whether predicted demand is higher than usual for that zone. It is not a
                  direct measurement of passenger waiting time and does not reflect live driver availability.
                </p>
                {targ.proxy_note ? (
                  <p className="mt-3 text-sm leading-relaxed text-brand-text">
                    <span className="font-semibold text-brand-primary">From export: </span>
                    {String(targ.proxy_note).replace(/\bproxy\b/gi, "indicator")}
                  </p>
                ) : null}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Data sources" subtitle="What the current NYC TLC historical export is built from">
            <div className="grid gap-3 md:grid-cols-2">
              <SourceCard
                name="NYC TLC Yellow Taxi trip data"
                purpose="Build hourly pickup-demand aggregates by TLC taxi zone for the modeling period."
                fields="Zone-hour pickup totals and trip-level aggregates summarized in `taxi_demand_features` (see feature dictionary)."
                status="Exported & used in dashboard"
              />
              <SourceCard
                name="TLC taxi zone lookup & GeoJSON"
                purpose="Join zone names, boroughs, and map geometry for spatial views."
                fields="`taxi_zones.geojson`, `zone_id`, `borough`, `zone_name`, `service_zone` (see feature dictionary)."
                status="Exported & used in dashboard / map"
              />
              <SourceCard
                name="Weather data"
                purpose="Hourly weather context aligned to the zone-hour grid where available."
                fields={
                  weatherCols.length
                    ? weatherCols.map((c) => WEATHER_LABELS[c] ?? humanizeSnake(c)).join(" · ")
                    : "Not listed in current `dataset_summary` export"
                }
                status={weatherCols.length ? "Exported (column names in summary)" : "Not available in current export"}
              />
              <SourceCard
                name="Collision / incident / event data"
                purpose="Indicators of disruptions mapped in time and, when possible, to taxi zones."
                fields={
                  eventCols.length
                    ? eventCols.map((c) => humanizeSnake(c)).join(" · ")
                    : "Not listed in current `dataset_summary` export"
                }
                status={eventCols.length ? "Exported (column names in summary)" : "Not available in current export"}
              />
              <SourceCard
                name="Model metrics & prediction previews"
                purpose="Offline evaluation tables and sample predictions bundled for the Model Performance views."
                fields="`model_metrics.json`, `forecast_metrics.json`, `contextual_comparison.json`, `predictions_preview.json`."
                status="Exported"
              />
              <SourceCard
                name="Future authority or ride-hailing feeds (illustrative)"
                purpose="A future deployment could substitute or augment TLC exports with regulator or operator feeds; it is not part of this historical export."
                fields="—"
                status="Future adaptation only (not in current export)"
              />
            </div>
          </SectionCard>

          <SectionCard title="Dataset snapshot" subtitle="Key fields from `dataset_summary.json` (exported)">
            <DataTable
              rows={datasetRows(ds)}
              columns={[
                { key: "metric", label: "Metric", render: (v) => v },
                { key: "value", label: "Value" },
              ]}
              maxRows={22}
            />
            <div className="mt-6">
              <h4 className="text-xs font-semibold uppercase text-brand-muted">Source labels in export</h4>
              <ul className="mt-3 space-y-2 text-sm text-brand-text">
                {(overviewSources.length ? overviewSources : ["Not available in current export"]).map((s) => (
                  <li key={s}>• {s}</li>
                ))}
              </ul>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {tab === "pipeline" ? (
        <div className="space-y-4">
          <SectionCard title="Pipeline detail" subtitle="Same stages as the strip above, with artifact pointers">
            <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-brand-text">
              <li>
                <span className="font-semibold">TLC trip records → zone-hour demand. </span>
                Hourly pickups by TLC zone feed `pickup_count` and related demand aggregates documented in the feature
                dictionary.
              </li>
              <li>
                <span className="font-semibold">Zone geometry & lookup. </span>
                `taxi_zones.geojson` and lookup columns connect each `zone_id` to borough and zone name for maps and
                tables.
              </li>
              <li>
                <span className="font-semibold">Weather alignment. </span>
                Weather columns listed in `dataset_summary.available_weather_columns` appear as `weather_features` in the
                dictionary; explicit hourly alignment diagnostics are not included in the JSON export.
              </li>
              <li>
                <span className="font-semibold">Incident / event integration. </span>
                Counts and mapping flags are summarized in `event_integration_summary.json`; derived columns are listed
                under `event_incident_features`.
              </li>
              <li>
                <span className="font-semibold">Feature engineering. </span>
                Lags, rolling means/stds (including the 24-hour rolling mean), cyclical time encodings, weather and event
                fields, and interaction terms are enumerated in `feature_dictionary.json`.
              </li>
              <li>
                <span className="font-semibold">Model-ready merge. </span>
                Final row counts and column totals match `dataset_summary` and support training on
                `target_pickup_count_next_hour`.
              </li>
            </ol>
          </SectionCard>
        </div>
      ) : null}

      {tab === "quality" ? (
        <div className="space-y-4">
          <SectionCard
            title="Data preparation and quality checks"
            subtitle="Based on exported preprocessing summaries (`dataset_summary`, `event_integration_summary`); no extra cleaning statistics are inferred here."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <QualityTile
                label="Final merged modeling rows"
                value={formatNumber(eventRow?.number_of_final_merged_rows ?? ds.rows, 0)}
              />
              <QualityTile label="Dataset columns (export)" value={formatNumber(ds.columns, 0)} />
              <QualityTile label="Feature tally (summary)" value={formatNumber(ds.feature_count, 0)} />
              <QualityTile label="Distinct zones (summary)" value={formatNumber(ds.number_of_zones, 0)} />
              <QualityTile
                label="Invalid timestamps dropped (events)"
                value={
                  eventRow && eventRow.invalid_timestamp_records_dropped != null
                    ? formatNumber(eventRow.invalid_timestamp_records_dropped, 0)
                    : "Not available in current export"
                }
              />
              <QualityTile
                label="Missing values (features)"
                subtitle="Per-column `missing_count` in feature dictionary"
                value={feats.length ? "See dictionary tab" : "Not available in current export"}
              />
              <QualityTile
                label="Raw incident/event records"
                value={eventRow ? formatNumber(eventRow.total_raw_event_records, 0) : "Not available in current export"}
              />
              <QualityTile
                label="Records mapped to taxi zones"
                value={eventRow ? formatNumber(eventRow.records_mapped_to_taxi_zones, 0) : "Not available in current export"}
              />
              <QualityTile
                label="Records not mapped / citywide-only"
                value={
                  eventRow
                    ? `${formatNumber(eventRow.records_not_mapped, 0)} not mapped · ${formatNumber(eventRow.citywide_only_records, 0)} citywide-only`
                    : "Not available in current export"
                }
              />
              <QualityTile
                label="Weather alignment status"
                value="Not available in current export"
                subtitle="No dedicated alignment diagnostic is present in the bundled JSON summaries."
              />
            </div>
          </SectionCard>
        </div>
      ) : null}

      {tab === "features" ? (
        <SectionCard title="Feature dictionary" subtitle="Exported column metadata — search across name, group, description, and use">
          <label className="mb-4 block">
            <span className="text-[11px] font-semibold uppercase text-brand-muted">Search</span>
            <input
              value={featQ}
              onChange={(e) => setFeatQ(e.target.value)}
              placeholder="Filter by feature, group, description, or use…"
              className="mt-2 w-full rounded-lg border border-brand-border px-3 py-2 text-sm shadow-inner focus:border-brand-primary focus:outline-none"
            />
          </label>
          <p className="mb-3 text-xs text-brand-muted">
            Descriptions without an explicit export note are derived from feature names and groups, labeled in the table
            where applicable.
          </p>
          <DataTable
            rows={featRowsNumbered}
            columns={[
              {
                key: "_seq",
                label: "#",
                render: (v) => (
                  <span className="inline-block min-w-[1.75rem] tabular-nums text-center text-brand-muted">{v}</span>
                ),
              },
              { key: "column", label: "Feature" },
              { key: "_groupLabel", label: "Group / category" },
              {
                key: "_description",
                label: "Description",
                render: (v, r) => (
                  <span>
                    {v}
                    {r.description ? null : (
                      <span className="ml-1 text-[10px] font-medium uppercase text-brand-muted"> (from name) </span>
                    )}
                  </span>
                ),
              },
              { key: "_usedFor", label: "Used for" },
              {
                key: "dtype",
                label: "Type",
                render: (v, r) => String(v ?? r.data_type ?? "—"),
              },
            ]}
            maxRows={200}
          />
        </SectionCard>
      ) : null}

      {tab === "context" ? (
        <div className="space-y-4">
          <SectionCard
            title="Incident and event integration"
            subtitle="Figures from `event_integration_summary.json` — context to interpret patterns, not a claim of direct causality"
          >
            {eventRow ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <QualityTile label="Raw incident/event records" value={formatNumber(eventRow.total_raw_event_records, 0)} />
                <QualityTile
                  label="Records with latitude/longitude"
                  value={formatNumber(eventRow.records_with_latitude_longitude, 0)}
                />
                <QualityTile
                  label="Records mapped to taxi zones"
                  value={formatNumber(eventRow.records_mapped_to_taxi_zones, 0)}
                />
                <QualityTile label="Records not mapped" value={formatNumber(eventRow.records_not_mapped, 0)} />
                <QualityTile
                  label="Citywide-only records"
                  value={formatNumber(eventRow.citywide_only_records, 0)}
                  subtitle={
                    eventRow.citywide_fallback_used
                      ? "Citywide fallback was used in this export"
                      : undefined
                  }
                />
                <QualityTile label="Unique mapped zones (events)" value={formatNumber(eventRow.unique_mapped_zones, 0)} />
                <QualityTile label="Event-active hours" value={formatNumber(eventRow.event_active_hours, 0)} />
                <QualityTile
                  label="Event feature rows generated"
                  value={formatNumber(eventRow.number_of_event_feature_rows, 0)}
                />
                <QualityTile
                  label="Final merged rows (modeling table)"
                  value={formatNumber(eventRow.number_of_final_merged_rows, 0)}
                />
                <QualityTile
                  label="Final rows with incident flag"
                  value={formatNumber(eventRow.final_merged_rows_with_incident_flag, 0)}
                  subtitle={
                    eventRow.percentage_final_rows_incident_flag_1 != null
                      ? `${formatNumber(eventRow.percentage_final_rows_incident_flag_1, 2)}% of rows (export)`
                      : undefined
                  }
                />
              </div>
            ) : (
              <p className="text-sm text-brand-muted">Not available in current export.</p>
            )}
            <p className="mt-4 text-sm leading-relaxed text-brand-muted">
              Incident and event context is used to help interpret demand patterns alongside pickups and predictions. It
              does not assert a causal link for any single trip or hour.
            </p>
          </SectionCard>

          <SectionCard title="Weather context" subtitle="Fields present in the export (friendly labels)">
            <p className="text-sm leading-relaxed text-brand-muted">
              Weather variables provide context for interpreting pickup-demand patterns. They are joined to the same
              zone-hour timeline as the demand features when available.
            </p>
            {weatherCols.length ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {weatherCols.map((c) => (
                  <div
                    key={c}
                    className="rounded-lg border border-brand-border bg-brand-bg/60 px-3 py-2 text-sm text-brand-text"
                  >
                    <span className="font-medium text-brand-primary">{WEATHER_LABELS[c] ?? humanizeSnake(c)}</span>
                    <span className="mt-1 block font-mono text-[10px] text-brand-muted">{c}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm text-brand-muted">Not available in current export.</p>
            )}
            <div className="mt-4 rounded-lg border border-dashed border-brand-border bg-white/80 px-3 py-2 text-xs text-brand-muted">
              Hourly weather-to-demand alignment diagnostics are not included in the bundled JSON; only column names and
              dictionary metadata are shown here.
            </div>
          </SectionCard>
        </div>
      ) : null}

      {tab === "artifacts" ? (
        <div className="space-y-4">
          <SectionCard
            title="Exported figures and artifacts"
            subtitle="Visual outputs and supporting artifacts from exploration, preprocessing, modeling, and dashboard export — only items returned by `/api/figures` with a public URL are previewed."
          >
            <div className="mb-4 flex flex-wrap gap-2">
              {GALLERY_FILTER_TABS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGalleryFilter(g.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                    galleryFilter === g.id
                      ? "border-brand-primary bg-brand-primary text-white"
                      : "border-brand-border bg-white text-brand-muted hover:bg-brand-bg"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>

            {filteredFigures.length ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {filteredFigures.map((fig) => (
                  <FigureGalleryCard key={fig._key} fig={fig} />
                ))}
              </div>
            ) : imgs.length === 0 ? (
              <p className="rounded-xl border border-dashed border-brand-border bg-brand-bg/50 px-4 py-6 text-center text-sm text-brand-muted">
                No figure gallery is available in the current export.
              </p>
            ) : (
              <p className="text-sm text-brand-muted">No figures match this filter.</p>
            )}
          </SectionCard>

          <SectionCard title="Dashboard data artifacts" subtitle="Files under `frontend/public/data/` used by the static fallback bundle">
            <DataTable
              rows={DASHBOARD_ARTIFACTS.map((a) => ({
                artifact: a.file,
                purpose: a.purpose,
                usedIn: a.usedIn,
                status: "Available",
              }))}
              columns={[
                { key: "artifact", label: "Artifact" },
                { key: "purpose", label: "Purpose" },
                { key: "usedIn", label: "Used in" },
                { key: "status", label: "Status" },
              ]}
              maxRows={40}
            />
          </SectionCard>
        </div>
      ) : null}

      <SectionCard title="Current data scope" subtitle="What this historical dashboard does and does not represent">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-brand-muted">
          <li>The dashboard runs on exported historical and processed NYC TLC zone-hour data, not on a live operational feed.</li>
          <li>It does not use live driver availability and does not perform fleet allocation.</li>
          <li>It does not directly measure passenger waiting minutes; it highlights predicted pickup demand and Pressure Ratio as demand-pressure indicators.</li>
          <li>
            A future deployment could integrate additional live or proprietary sources (for example operator or authority
            feeds); that is outside the scope of this static export.
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}

function PipelineProcessDiagram({ steps }) {
  return (
    <div className="relative">
      {/* Stacked / wrapped layout: smaller viewports */}
      <div className="flex flex-col gap-2 sm:hidden">
        {steps.map((step, idx) => (
          <Fragment key={step.title}>
            {idx > 0 ? (
              <div className="flex justify-center py-0.5 text-brand-primary/40" aria-hidden>
                <ChevronDown size={20} strokeWidth={2} />
              </div>
            ) : null}
            <PipelineStepCard step={step} stepNumber={idx + 1} />
          </Fragment>
        ))}
      </div>
      <div className="hidden sm:grid sm:grid-cols-2 sm:gap-3 lg:grid-cols-3 xl:hidden">
        {steps.map((step, idx) => (
          <PipelineStepCard key={step.title} step={step} stepNumber={idx + 1} />
        ))}
      </div>
      {/* Desktop: single-row process flow with chevrons */}
      <div className="hidden xl:flex xl:items-stretch xl:justify-between xl:gap-1">
        {steps.map((step, idx) => (
          <Fragment key={step.title}>
            {idx > 0 ? (
              <div
                className="flex w-7 shrink-0 items-center justify-center self-center text-brand-primary/45"
                aria-hidden
              >
                <ChevronRight size={22} strokeWidth={2} className="drop-shadow-sm" />
              </div>
            ) : null}
            <PipelineStepCard step={step} stepNumber={idx + 1} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function PipelineStepCard({ step, stepNumber }) {
  const { title, body, Icon } = step;
  return (
    <div className="flex h-full min-h-[120px] min-w-0 flex-1 flex-col rounded-xl border border-brand-border/90 bg-gradient-to-b from-white to-brand-mint/20 p-3 text-center shadow-card ring-1 ring-brand-primary/[0.06]">
      <div className="mb-2 flex items-center justify-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-primary text-[11px] font-bold tabular-nums leading-none text-white shadow-sm">
          {stepNumber}
        </span>
        <Icon className="shrink-0 text-brand-primary" size={18} strokeWidth={1.8} aria-hidden />
      </div>
      <div className="text-[11px] font-semibold leading-snug text-brand-text">{title}</div>
      <p className="mt-1.5 line-clamp-3 text-[10px] leading-snug text-brand-muted">{body}</p>
    </div>
  );
}

function FigureGalleryCard({ fig }) {
  const [broken, setBroken] = useState(false);
  const category = fig._category ?? "Project artifact";
  const title = fig.title ?? "Figure";
  const desc = figureBlurb(fig);
  const stage = figureStage(fig);
  const href = typeof fig.url === "string" ? fig.url : null;

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-brand-border bg-white shadow-card">
      <div className="relative aspect-[4/3] w-full bg-gradient-to-br from-brand-mint/40 to-emerald-50/60">
        {!broken && href ? (
          <img
            src={href}
            alt={title}
            className="h-full w-full object-contain"
            onError={() => setBroken(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm font-medium text-brand-muted">
            Preview unavailable
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-full bg-brand-primary/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          {category}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h4 className="text-sm font-semibold text-brand-text">{title}</h4>
        <p className="text-xs leading-relaxed text-brand-muted">{desc}</p>
        <p className="text-[10px] font-medium uppercase tracking-wide text-brand-primary/80">{stage}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-primary hover:underline"
          >
            <ImageIcon size={14} strokeWidth={1.75} />
            Open full image
          </a>
        ) : null}
      </div>
    </article>
  );
}

function figureBlurb(fig) {
  const t = `${fig.title ?? ""} ${fig.path ?? ""} ${fig.category ?? ""}`.toLowerCase();
  if (/clean|missing|null|imput/i.test(t)) return "Supports data-quality review before modeling (completeness / missingness)."
  if (/weather|rain|temp|humid|wind/i.test(t)) return "Relates weather context to the demand timeline used in the export."
  if (/incident|collision|event|disrupt/i.test(t)) return "Summarizes how incident or event signals enter the zone-hour table."
  if (/feature|importance|shap|coef/i.test(t)) return "Illustrates engineered inputs or model attribution for the tabular predictors."
  if (/metric|rmse|mae|r2|loss|eval/i.test(t)) return "Visualizes offline evaluation metrics bundled for Model Performance."
  if (/forecast|horizon|24h|seq/i.test(t)) return "Relates to forecast-model outputs where those artifacts exist in the project."
  if (/predict|sample|preview/i.test(t)) return "Shows sample predictions aligned with the predictions preview export."
  if (/dashboard|map|snapshot|export/i.test(t)) return "Dashboard-oriented visual from the reporting or export pipeline."
  return "Project artifact supporting the data, modeling, or dashboard export process."
}

function figureStage(fig) {
  const t = `${fig.title ?? ""} ${fig.path ?? ""}`.toLowerCase();
  if (/clean|missing/i.test(t)) return "Pipeline stage: data preparation"
  if (/weather/i.test(t)) return "Pipeline stage: weather context"
  if (/incident|event|collision/i.test(t)) return "Pipeline stage: incident integration"
  if (/feature|shap|importance/i.test(t)) return "Pipeline stage: feature engineering"
  if (/metric|eval|loss|r2|rmse|mae/i.test(t)) return "Pipeline stage: model evaluation"
  if (/predict|preview/i.test(t)) return "Pipeline stage: prediction preview"
  if (/dashboard|map/i.test(t)) return "Pipeline stage: dashboard export"
  return "Pipeline stage: project artifact"
}

function inferFigureCategory(fig) {
  const blob = `${fig.category ?? ""} ${fig.title ?? ""} ${fig.path ?? ""}`.toLowerCase();
  if (/clean|missing|null/i.test(blob)) return "Data cleaning"
  if (/weather|rain|temp|snow|humid|wind/i.test(blob)) return "Weather context"
  if (/incident|collision|event|closure|disrupt/i.test(blob)) return "Incident integration"
  if (/feature|importance|shap/i.test(blob)) return "Feature engineering"
  if (/metric|eval|loss|r2|rmse|mae/i.test(blob)) return "Model evaluation"
  if (/forecast|24h|horizon/i.test(blob)) return "Forecasting"
  if (/predict|preview|sample/i.test(blob)) return "Prediction preview"
  if (/map|dashboard|snapshot/i.test(blob)) return "Dashboard export"
  if (/explor|eda|distrib|hist|plot/i.test(blob)) return "Data exploration"
  return "Project artifact"
}

function galleryCategoryId(fig) {
  const c = inferFigureCategory(fig);
  if (c === "Data cleaning" || c === "Data exploration") return "data"
  if (c === "Feature engineering") return "features"
  if (c === "Weather context" || c === "Incident integration") return "events"
  if (c === "Model evaluation" || c === "Forecasting" || c === "Prediction preview") return "models"
  if (c === "Dashboard export") return "dashboard"
  return "data"
}

function datasetRows(ds) {
  return [
    ["Total rows (export)", formatNumber(ds.rows, 0)],
    ["Columns", formatNumber(ds.columns, 0)],
    ["Distinct zones", formatNumber(ds.number_of_zones, 0)],
    ["Feature tally (summary)", formatNumber(ds.feature_count, 0)],
    ["Temporal start", ds.time_range_start ?? "—"],
    ["Temporal end", ds.time_range_end ?? "—"],
    ["Target column", ds.target_column ?? "target_pickup_count_next_hour"],
  ].map(([metric, value]) => ({ metric, value }));
}

function SourceCard({ name, purpose, fields, status }) {
  return (
    <div className="rounded-xl border border-brand-border bg-gradient-to-br from-white to-brand-mint/20 p-4 shadow-inner">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-brand-text">{name}</h4>
        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-primary ring-1 ring-brand-primary/20">
          {status}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-brand-muted">{purpose}</p>
      <p className="mt-2 text-[11px] font-medium text-brand-text">
        <span className="text-brand-muted">Key fields: </span>
        {fields}
      </p>
    </div>
  );
}

function MetricExplainCard({ title, code, body }) {
  return (
    <div className="rounded-xl border border-brand-border bg-white p-4 shadow-inner">
      <div className="text-sm font-semibold text-brand-text">{title}</div>
      <code className="mt-2 block text-[11px] text-brand-deep">{code}</code>
      <p className="mt-2 text-sm leading-relaxed text-brand-muted">{body}</p>
    </div>
  );
}

function QualityTile({ label, value, subtitle }) {
  return (
    <div className="rounded-xl border border-brand-border bg-brand-bg/70 px-3 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-brand-text">{value}</div>
      {subtitle ? <p className="mt-1 text-[11px] text-brand-muted">{subtitle}</p> : null}
    </div>
  );
}

function pickFiniteNumber(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatTimestampLabel(raw) {
  if (raw == null || raw === "") return "—";
  const s = String(raw).replace(" ", "T");
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return String(raw);
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return String(raw);
  }
}

function humanizeSnake(s) {
  if (!s) return "—";
  return String(s)
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function featureUsedForLabel(group) {
  if (group === "target") return "Supervised learning target"
  if (group === "weather_features") return "Weather context / modeling inputs"
  if (group === "event_incident_features") return "Incident & event context / modeling inputs"
  if (group === "taxi_zone_lookup_features") return "Zone & borough labels / joins"
  if (group === "taxi_demand_features") return "Demand aggregates & calendar signals"
  if (group === "lag_rolling_calendar_features") return "Lags, rolling baselines, cyclical time"
  if (group === "interaction_features") return "Interaction terms for modeling"
  return "Modeling / dashboard context"
}

function deriveFeatureDescription(column, group) {
  const c = String(column || "");
  const g = String(group || "");
  if (!c) return "Exported modeling column (no separate description field in JSON)."
  if (/_lag_\d+/i.test(c)) return `Lag of pickup demand (${c}) — derived from exported feature name.`
  if (/roll_mean|roll_std/i.test(c)) return `Rolling statistic of pickups (${c}) — derived from exported feature name.`
  if (/sin|cos/i.test(c)) return `Cyclical encoding (${c}) — derived from exported feature name.`
  if (/indicator|flag/i.test(c)) return `Binary indicator (${c}) — derived from exported feature name.`
  if (g === "interaction_features") return `Interaction term (${c}) — derived from exported feature name.`
  if (g === "target") return "Supervised target for next-hour pickups (see overview export)."
  return `Exported column "${c}" — description derived from feature name only.`
}
