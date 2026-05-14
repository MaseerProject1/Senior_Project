import { useCallback, useMemo, useState } from "react";
import { Bell, ChevronDown, ChevronUp, X } from "lucide-react";
import { getTopPressureRow, incidentContextActive } from "../lib/insights";
import { formatNumber, formatRatio } from "../lib/format";
import { REGULATORY_ALERTS_SESSION_HIDE_KEY } from "../lib/roleAccess";
import GlassButton from "./GlassButton";

const MAP_ANCHOR_ID = "authority-zone-map";
const TABLE_ANCHOR_ID = "authority-high-priority-zones";

function readSessionHidden() {
  try {
    return sessionStorage.getItem(REGULATORY_ALERTS_SESSION_HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSessionHidden() {
  try {
    sessionStorage.setItem(REGULATORY_ALERTS_SESSION_HIDE_KEY, "1");
  } catch {
    /* ignore */
  }
}

function scrollToId(id) {
  const el = typeof document !== "undefined" ? document.getElementById(id) : null;
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Regulatory alert layer for Transport Authority view — uses current export / snapshot fields only.
 */
export default function AuthorityAlerts({
  enabled,
  fullRows,
  summary,
  sortedTableRows,
  peakBoroughAvg,
  peakBoroughStress,
}) {
  const [expanded, setExpanded] = useState(true);
  const [panelHidden, setPanelHidden] = useState(() => readSessionHidden());
  const [reviewedIds, setReviewedIds] = useState(() => new Set());

  const weatherPresent = Boolean(
    summary?.weather_status || (fullRows ?? []).some((r) => r.weather_category != null && String(r.weather_category).trim() !== "")
  );
  const weatherLabel =
    summary?.weather_status ||
    (fullRows ?? []).find((r) => r.weather_category)?.weather_category ||
    null;

  const incidentSample = useMemo(() => {
    const rows = sortedTableRows?.length ? sortedTableRows : fullRows || [];
    return rows.find((r) => incidentContextActive(r)) ?? null;
  }, [sortedTableRows, fullRows]);

  const topPressure = useMemo(() => getTopPressureRow(fullRows || []), [fullRows]);

  const alerts = useMemo(() => {
    const list = [];
    if (incidentSample) {
      const z = incidentSample.zone_name?.trim() || `Zone ${incidentSample.zone_id ?? "—"}`;
      const b = incidentSample.borough?.trim() || "selected borough scope";
      list.push({
        id: "incident",
        kind: "Current export indicator",
        title: "Planning review",
        body: `Incident context is detected in ${b} (${z}). Review the authority map and priority table for demand-pressure indicators in this snapshot — not a live emergency feed.`,
      });
    }
    const pr = Number(topPressure?.pressure_ratio ?? topPressure?.observed_pressure_ratio);
    if (topPressure && Number.isFinite(pr) && pr >= 1.15) {
      const z = topPressure.zone_name?.trim() || `Zone ${topPressure.zone_id ?? "—"}`;
      list.push({
        id: "pressure",
        kind: "Monitoring alert",
        title: "Demand-pressure indicator",
        body: `Monitoring alert: ${z} shows elevated demand pressure for the selected snapshot (pressure ratio ${formatRatio(pr)}; model-based next-hour pickup signal). Use for planning review and visibility only.`,
      });
    }
    const boroughName = peakBoroughStress?.name || peakBoroughAvg?.name;
    const boroughRatio = peakBoroughStress?.ratio ?? peakBoroughAvg?.ratio;
    if (boroughName && Number.isFinite(Number(boroughRatio))) {
      list.push({
        id: "borough",
        kind: "Monitoring alert",
        title: "Borough demand-pressure (export)",
        body: `${boroughName} shows the strongest average demand-pressure ratio in this snapshot (${formatRatio(boroughRatio)}). Suitable for regulatory oversight and planning review.`,
      });
    }
    if (weatherPresent) {
      list.push({
        id: "weather",
        kind: "Planning review",
        title: "Weather context (export)",
        body: weatherLabel
          ? `Weather context is available for this snapshot (${String(weatherLabel)}) and may help interpret demand patterns as a current export indicator.`
          : "Weather context fields are available for this snapshot as a current export indicator and may help interpret demand patterns.",
      });
    }
    return list;
  }, [incidentSample, topPressure, peakBoroughStress, peakBoroughAvg, weatherPresent, weatherLabel]);

  const markReviewed = useCallback((id) => {
    setReviewedIds((prev) => new Set(prev).add(id));
  }, []);

  const hidePanel = useCallback(() => {
    writeSessionHidden();
    setPanelHidden(true);
  }, []);

  if (!enabled || panelHidden) return null;

  const visibleAlerts = alerts.filter((a) => !reviewedIds.has(a.id));

  return (
    <div className="pointer-events-none fixed right-5 top-[4.5rem] z-[34] flex max-w-[min(100vw-2rem,380px)] flex-col items-end gap-2 xl:right-6">
      <div className="pointer-events-auto w-full overflow-hidden rounded-2xl border border-brand-border bg-white shadow-soft">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-between gap-2 border-b border-brand-border bg-gradient-to-r from-brand-mint/90 to-white px-3 py-2.5 text-left"
        >
          <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-deep">
            <Bell size={14} className="text-brand-primary" strokeWidth={2} />
            Regulatory Alerts
          </span>
          {expanded ? <ChevronUp size={16} className="text-brand-muted" /> : <ChevronDown size={16} className="text-brand-muted" />}
        </button>
        {expanded ? (
          <div className="max-h-[min(48vh,380px)] overflow-y-auto p-3">
            {visibleAlerts.length === 0 ? (
              <p className="text-xs leading-relaxed text-brand-muted">
                No active monitoring cards for this export slice, or items are marked reviewed. Demand-pressure indicators still appear
                in the main view.
              </p>
            ) : (
              <ul className="space-y-3">
                {visibleAlerts.map((a) => (
                  <li key={a.id} className="rounded-xl border border-brand-border/80 bg-brand-bg/80 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-brand-primary">{a.kind}</div>
                    <div className="mt-1 text-sm font-semibold text-brand-text">{a.title}</div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-brand-muted">{a.body}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <GlassButton
                        type="button"
                        variant="secondary"
                        className="px-2 py-1 text-[10px]"
                        onClick={() => scrollToId(TABLE_ANCHOR_ID)}
                      >
                        Review zone
                      </GlassButton>
                      <GlassButton
                        type="button"
                        variant="secondary"
                        className="px-2 py-1 text-[10px]"
                        onClick={() => markReviewed(a.id)}
                      >
                        Mark as reviewed
                      </GlassButton>
                      <GlassButton
                        type="button"
                        variant="secondary"
                        className="px-2 py-1 text-[10px]"
                        onClick={() => scrollToId(MAP_ANCHOR_ID)}
                      >
                        View authority map
                      </GlassButton>
                      <GlassButton type="button" variant="secondary" className="px-2 py-1 text-[10px]" onClick={hidePanel}>
                        Hide alert
                      </GlassButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 border-t border-brand-border pt-2 text-[10px] leading-snug text-brand-muted">
              Current export indicators only — not live operational control. Pickup counts shown as demand signals:{" "}
              {formatNumber(
                Number(summary?.total_predicted_next_hour_pickups ?? summary?.citywide_predicted_next_hour_pickups ?? 0),
                0
              )}{" "}
              citywide where available.
            </p>
          </div>
        ) : null}
      </div>
      {expanded ? (
        <button
          type="button"
          onClick={hidePanel}
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-brand-border bg-white text-brand-muted shadow-card hover:bg-brand-mint/50"
          title="Hide regulatory alerts for this session"
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}
