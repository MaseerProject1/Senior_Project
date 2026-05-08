import { formatRatio } from "../lib/format";

export default function HeatPanel({ rows = [] }) {
  const items = rows.slice(0, 20);
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((row, idx) => {
        const ratio = row.pressure_ratio ?? row.observed_pressure_ratio;
        const color =
          ratio >= 1.35
            ? "bg-red-100 border-red-300"
            : ratio >= 1.0
              ? "bg-amber-100 border-amber-300"
              : "bg-emerald-50 border-emerald-200";
        return (
          <div key={`${row.zone_id}-${idx}`} className={`rounded-lg border p-3 ${color}`}>
            <div className="font-medium">{row.zone_name}</div>
            <div className="text-xs text-brand-muted">{row.borough}</div>
            <div className="mt-1 text-sm">Pressure Ratio: {formatRatio(ratio)}</div>
            <div className="text-xs">
              Predicted Next-Hour Pickups: {row.predicted_next_hour_pickups ?? row.observed_next_hour_pickups ?? "N/A"}
            </div>
          </div>
        );
      })}
    </div>
  );
}
