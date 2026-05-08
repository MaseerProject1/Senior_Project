import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import HeatPanel from "../components/HeatPanel";

export default function TransportAuthority({ data }) {
  const rows = data?.zonePressure ?? [];
  const maxRatio = Math.max(
    ...rows.map((r) => Number(r.pressure_ratio ?? r.observed_pressure_ratio ?? 0))
  );
  const risk = maxRatio >= 1.35 ? "High" : maxRatio >= 1 ? "Elevated" : "Typical";

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="City Risk Level" value={risk} />
        <KpiCard label="Critical Zones" value={rows.filter((r) => (r.pressure_ratio ?? r.observed_pressure_ratio) >= 1.35).length} />
        <KpiCard label="Active Incidents" value={rows.filter((r) => Number(r.incident_flag) === 1).length} />
        <KpiCard label="Peak Demand Window" value={rows[0]?.timestamp?.slice?.(11, 16) ?? "N/A"} />
      </div>
      <SectionCard title="Citywide Risk Heatmap">
        <HeatPanel rows={rows} />
      </SectionCard>
    </div>
  );
}
