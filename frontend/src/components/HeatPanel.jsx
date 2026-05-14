import { formatRatio, formatNumber } from "../lib/format";

function cellStyle(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return "bg-slate-100/90 border-slate-200 text-brand-muted";
  if (r >= 1.35) return "bg-gradient-to-br from-rose-400/95 to-brand-critical border-rose-500/35 text-white";
  if (r >= 1.0) return "bg-amber-200/95 border-amber-400/50 text-amber-950";
  if (r >= 0.75) return "bg-emerald-200/80 border-emerald-400/35 text-brand-text";
  return "bg-brand-mint/80 border-teal-200/60 text-brand-deep";
}

export default function HeatPanel({
  rows = [],
  subtitle = "NYC TLC taxi zones • demand-pressure indicator",
  onOpenZones,
  expandLabel = false,
  fullGrid = false,
}) {
  const sorted = [...rows]
    .filter((row) => row.zone_name || row.zone_id != null)
    .sort((a, b) => {
      const br = String(a.borough || "").localeCompare(String(b.borough || ""));
      if (br) return br;
      return String(a.zone_name || "").localeCompare(String(b.zone_name || ""));
    });

  const topByPressure = [...sorted]
    .map((row) => ({
      row,
      r: Number(row.pressure_ratio ?? row.observed_pressure_ratio),
    }))
    .filter((x) => Number.isFinite(x.r))
    .sort((a, b) => b.r - a.r)
    .slice(0, 56)
    .map((x) => x.row);

  const grid = fullGrid
    ? sorted.slice(0, 160)
    : topByPressure.length
      ? topByPressure
      : sorted.slice(0, 48);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-brand-muted">{subtitle}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-brand-muted">
            <span>Legend:</span>
            <span className="rounded border border-teal-200 bg-brand-mint px-2 py-0.5 text-brand-deep">Low</span>
            <span className="rounded border border-emerald-300 bg-emerald-200 px-2 py-0.5 text-brand-text">Typical</span>
            <span className="rounded border border-amber-400 bg-amber-200 px-2 py-0.5 text-amber-950">Elevated</span>
            <span className="rounded border border-rose-500/40 bg-gradient-to-r from-rose-500 to-brand-critical px-2 py-0.5 text-white">
              High
            </span>
          </div>
        </div>
        {onOpenZones ? (
          <button
            type="button"
            onClick={onOpenZones}
            className="rounded-lg border border-brand-border bg-white px-3 py-1.5 text-xs font-semibold text-brand-primary shadow-sm hover:border-brand-primary"
          >
            {expandLabel ? "Show top grid" : "View all zones"}
          </button>
        ) : null}
      </div>

      <div className="grid max-h-[min(420px,50vh)] auto-rows-fr grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-1 overflow-auto rounded-xl border border-brand-border bg-brand-bg/50 p-2">
        {grid.length === 0 ? (
          <div className="col-span-full flex min-h-[200px] items-center justify-center text-sm text-brand-muted">
            No zone geometry in export — awaiting snapshot rows with zone pressure.
          </div>
        ) : (
          grid.map((row, idx) => {
            const ratio = row.pressure_ratio ?? row.observed_pressure_ratio;
            const pickups = row.predicted_next_hour_pickups ?? row.observed_next_hour_pickups;
            return (
              <div
                key={`${row.zone_id}-${idx}`}
                title={`${row.zone_name ?? "Zone"} — ratio ${ratio ?? "N/A"}`}
                className={`relative flex min-h-[72px] flex-col rounded-lg border p-2 text-xs shadow-sm transition-transform hover:z-[1] hover:scale-[1.02] ${cellStyle(ratio)}`}
              >
                <div className="truncate font-semibold leading-tight">
                  {row.zone_name ?? `Zone ${row.zone_id ?? ""}`}
                </div>
                <div className="mt-auto flex items-end justify-between gap-1 pt-1 text-[10px] opacity-95">
                  <span className="truncate opacity-95">{formatRatio(ratio)}</span>
                  <span className="shrink-0 tabular-nums opacity-95">{pickups != null ? formatNumber(pickups, 0) : "—"}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
      <p className="mt-3 text-[11px] leading-snug text-brand-muted">
        Values reflect Pressure Ratio: predicted next-hour pickups vs the rolling 24-hour pickup mean for the zone. This is an
        indirect demand-pressure indicator, not a direct measurement of passenger waiting time. NYC TLC labels do not include observed
        passenger queue time.
      </p>
    </div>
  );
}
