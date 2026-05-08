const HOURS = Array.from({ length: 24 }, (_, i) => i);

function hue(pr) {
  if (!Number.isFinite(pr)) return "rgb(229 231 235)";
  if (pr >= 1.35) return "rgb(180 35 24)";
  if (pr >= 1.0) return "rgb(247 183 49)";
  if (pr >= 0.75) return "rgb(110 231 183)";
  return "rgb(191 239 226)";
}

export default function ZoneHourHeatMatrix({ rows = [] }) {
  const zoneKeys = [
    ...new Set(rows.map((r) => String(r.zone_name ?? `Zone ${r.zone_id ?? ""}`))),
  ].slice(0, 12);

  const map = {};
  for (const r of rows) {
    const z = String(r.zone_name ?? `Zone ${r.zone_id ?? ""}`);
    const h = Number(r.hour);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    const pr = Number(r.pressure_ratio);
    if (!map[z]) map[z] = {};
    const prev = map[z][h];
    if (prev == null || (Number.isFinite(pr) && pr > prev)) map[z][h] = pr;
  }

  if (!zoneKeys.length) {
    return (
      <div className="flex min-h-[180px] items-center justify-center rounded-lg border border-dashed border-brand-border bg-brand-bg/40 text-sm text-brand-muted">
        Not enough zone-hour points in this view — enable the API or widen the static export window.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-brand-border bg-white p-3">
      <div className="inline-block min-w-[640px]">
        <div
          className="grid gap-[3px]"
          style={{ gridTemplateColumns: `96px repeat(24, minmax(14px, 1fr))` }}
        >
          <div className="flex items-end px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-brand-muted">
            Zone \\ Hour
          </div>
          {HOURS.map((h) => (
            <div key={`h-${h}`} className="pb-1 text-center text-[9px] font-semibold text-brand-muted">
              {h % 4 === 0 ? h : ""}
            </div>
          ))}

          {zoneKeys.map((z) => (
            <div key={z} className="contents">
              <div className="truncate px-1 py-1 text-[11px] font-medium text-brand-text" title={z}>
                {z}
              </div>
              {HOURS.map((h) => {
                const pr = map[z]?.[h];
                return (
                  <div
                    key={`${z}-${h}`}
                    className="aspect-square min-h-[14px] min-w-[12px] rounded-[2px] border border-white/50"
                    style={{ backgroundColor: hue(pr) }}
                    title={`${z} @ ${h}:00 — ratio ${Number.isFinite(pr) ? pr.toFixed(2) : "n/a"}`}
                  />
                );
              })}
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] font-semibold uppercase tracking-wide text-brand-muted">
          <span>Scale</span>
          <span className="flex items-center gap-1 normal-case">
            <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: hue(0.5) }} />
            Low
          </span>
          <span className="flex items-center gap-1 normal-case">
            <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: hue(0.85) }} />
            Typical
          </span>
          <span className="flex items-center gap-1 normal-case">
            <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: hue(1.1) }} />
            Elevated
          </span>
          <span className="flex items-center gap-1 normal-case">
            <span className="h-3 w-5 rounded-sm" style={{ backgroundColor: hue(1.4) }} />
            High
          </span>
        </div>
      </div>
    </div>
  );
}
