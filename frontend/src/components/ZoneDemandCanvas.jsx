import { useMemo, useState } from "react";
import { formatDecimal, formatNumber, formatRatio, pressureLabel } from "../lib/format";

/** Borough → approximate TLC-style regions inside the canvas (percent). */
const REGIONS = [
  { match: (b) => /bronx/i.test(b || ""), l: 46, t: 6, w: 34, h: 26 },
  { match: (b) => /manhattan/i.test(b || ""), l: 38, t: 30, w: 24, h: 44 },
  { match: (b) => /queens/i.test(b || ""), l: 54, t: 48, w: 38, h: 34 },
  { match: (b) => /brooklyn/i.test(b || ""), l: 26, t: 54, w: 34, h: 30 },
  { match: (b) => /staten/i.test(b || ""), l: 6, t: 58, w: 22, h: 26 },
  { match: (b) => /ewr|newark/i.test(b || ""), l: 4, t: 38, w: 10, h: 12 },
  {
    match: () => true,
    l: 32,
    t: 44,
    w: 36,
    h: 28,
  },
];

function stableHash(id) {
  const s = String(id ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return Math.abs(h);
}

function regionForBorough(borough) {
  const b = borough || "";
  return REGIONS.find((r) => r.match(b)) || REGIONS[REGIONS.length - 1];
}

function dotPosition(zoneId, borough) {
  const r = regionForBorough(borough);
  const h = stableHash(zoneId);
  const hx = (h % 97) / 100;
  const hy = ((h >> 5) % 97) / 100;
  return {
    left: r.l + hx * r.w * 0.85 + r.w * 0.05,
    top: r.t + hy * r.h * 0.85 + r.h * 0.05,
  };
}

function colorForView(row, mode) {
  if (mode === "pickups") {
    const v = Number(row.predicted_next_hour_pickups ?? row.target_pickup_count_next_hour ?? 0);
    if (!Number.isFinite(v) || v <= 0) return "rgba(148,163,184,0.55)";
    const t = Math.min(1, Math.log1p(v) / Math.log1p(150));
    return `hsla(168, ${Math.round(45 + t * 42)}%, ${Math.round(32 + t * 28)}%, ${0.55 + t * 0.38})`;
  }
  if (mode === "incident") {
    const score =
      Number(row.zone_incident_count || 0) +
      (Number(row.incident_flag) > 0 ? 2 : 0) +
      (Number(row.road_closure_flag) > 0 ? 1.5 : 0) +
      Number(row.disruption_score || 0) +
      (Number(row.event_active) > 0 || Number(row.event_flag) > 0 ? 1 : 0);
    if (score <= 0) return "rgba(191,239,226,0.75)";
    const t = Math.min(1, score / 8);
    return `rgba(${Math.round(247 - t * 40)}, ${Math.round(183 - t * 80)}, ${Math.round(49 + t * 130)}, ${0.65 + t * 0.25})`;
  }
  const ratio = Number(row.pressure_ratio ?? row.observed_pressure_ratio);
  if (!Number.isFinite(ratio)) return "rgba(226,232,240,0.9)";
  if (ratio >= 1.35) return "rgba(180,35,24,0.92)";
  if (ratio >= 1.0) return "rgba(247,183,49,0.88)";
  if (ratio >= 0.75) return "rgba(110,231,183,0.85)";
  return "rgba(223,247,239,0.95)";
}

export default function ZoneDemandCanvas({
  rows = [],
  pressureView = "ratio",
  boroughFilter = "all",
}) {
  const [hover, setHover] = useState(null);

  const filtered = useMemo(() => {
    let r = rows.filter((x) => x.zone_name || x.zone_id != null);
    if (boroughFilter && boroughFilter !== "all") {
      const want = boroughFilter.toLowerCase();
      r = r.filter((row) => (row.borough || "").toLowerCase() === want);
    }
    return r;
  }, [rows, boroughFilter]);

  const mode =
    pressureView === "pickups" ? "pickups" : pressureView === "incident" ? "incident" : "ratio";

  const dots = useMemo(
    () =>
      filtered.map((row) => {
        const pos = dotPosition(row.zone_id, row.borough);
        const bg = colorForView(row, mode);
        return { row, pos, bg };
      }),
    [filtered, mode]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-brand-border/80 pb-3">
        <div>
          <h4 className="text-sm font-semibold text-brand-text">NYC zone demand — schematic view</h4>
          <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-brand-muted">
            Each dot approximates a TLC taxi zone placed by borough (not true latitude/longitude).{" "}
            <strong className="text-brand-text">Map data source: TLC zone geometry is not bundled in this frontend build</strong> — swap in GeoJSON later for a real choropleth.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wide text-brand-muted">
          <span className="rounded-md bg-slate-100 px-2 py-1">Legend</span>
          {mode === "ratio" ? (
            <>
              <span className="rounded-md px-2 py-1" style={{ background: "rgba(223,247,239,0.95)" }}>
                Low
              </span>
              <span className="rounded-md px-2 py-1" style={{ background: "rgba(110,231,183,0.85)" }}>
                Typical
              </span>
              <span className="rounded-md px-2 py-1" style={{ background: "rgba(247,183,49,0.88)" }}>
                Elevated
              </span>
              <span className="rounded-md px-2 py-1 text-white" style={{ background: "rgba(180,35,24,0.92)" }}>
                High
              </span>
            </>
          ) : mode === "pickups" ? (
            <span className="normal-case text-brand-text">Teal intensity ∝ predicted next-hour pickups</span>
          ) : (
            <span className="normal-case text-brand-text">Warm tones ∝ incident / disruption signals</span>
          )}
        </div>
      </div>

      <div className="relative mx-auto aspect-[16/10] w-full max-h-[min(520px,52vh)] rounded-2xl border-2 border-[#c8e8df] bg-gradient-to-br from-[#e8f7f2] via-[#dff7ef] to-[#cfeadf] shadow-inner">
        {/* Stylized water / parks */}
        <div className="pointer-events-none absolute inset-[6%] rounded-xl bg-[radial-gradient(ellipse_at_30%_40%,rgba(255,255,255,0.5)_0%,transparent_55%)] opacity-90" />
        <div className="pointer-events-none absolute bottom-[8%] left-[8%] h-[18%] w-[22%] rounded-full bg-sky-100/40 blur-xl" />

        {REGIONS.slice(0, -1).map((reg, i) => (
          <div
            key={i}
            className="pointer-events-none absolute rounded-lg border border-white/25 bg-white/10"
            style={{
              left: `${reg.l}%`,
              top: `${reg.t}%`,
              width: `${reg.w}%`,
              height: `${reg.h}%`,
            }}
          />
        ))}

        {dots.map(({ row, pos, bg }, idx) => {
          const sizePx = Math.min(13, Math.max(6, 6 + Math.log1p(Number(row.pickup_count || 1)) * 1.1));
          return (
            <button
              key={`${row.zone_id}-${idx}`}
              type="button"
              className="absolute z-[2] rounded-full border border-white/55 shadow-md outline-none ring-brand-primary/30 transition hover:z-[5] hover:scale-[1.35] focus-visible:ring-2"
              style={{
                left: `${pos.left}%`,
                top: `${pos.top}%`,
                width: sizePx,
                height: sizePx,
                transform: "translate(-50%, -50%)",
                backgroundColor: bg,
              }}
              title={`${row.zone_name ?? "Zone"} (${row.borough})`}
              onMouseEnter={() => setHover(row)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(row)}
              onBlur={() => setHover(null)}
            />
          );
        })}

        {hover ? (
          <div className="absolute bottom-3 left-3 right-3 z-[6] rounded-xl border border-brand-border bg-white/95 p-3 text-left text-xs shadow-card backdrop-blur-sm">
            <div className="font-semibold text-brand-text">{hover.zone_name}</div>
            <div className="text-brand-muted">{hover.borough}</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-brand-muted">Pred. next-hour</dt>
              <dd className="tabular-nums">{formatNumber(hover.predicted_next_hour_pickups ?? hover.target_pickup_count_next_hour, 0)}</dd>
              <dt className="text-brand-muted">Roll mean 24h</dt>
              <dd className="tabular-nums">{formatDecimal(hover.pickup_count_roll_mean_24, 2)}</dd>
              <dt className="text-brand-muted">Pressure ratio</dt>
              <dd className="tabular-nums">{formatRatio(hover.pressure_ratio ?? hover.observed_pressure_ratio)}</dd>
              <dt className="text-brand-muted">Label</dt>
              <dd>{hover.pressure_label ?? pressureLabel(Number(hover.pressure_ratio ?? hover.observed_pressure_ratio))}</dd>
              <dt className="text-brand-muted">Incidents</dt>
              <dd>{formatNumber(hover.zone_incident_count, 0)}</dd>
              <dt className="text-brand-muted">Weather</dt>
              <dd className="truncate">{hover.weather_category ?? "—"}</dd>
            </dl>
          </div>
        ) : (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-white/70 px-3 py-1.5 text-[10px] text-brand-muted backdrop-blur-sm">
            Hover a zone for TLC-aligned metrics
          </div>
        )}
      </div>
    </div>
  );
}
