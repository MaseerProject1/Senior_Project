import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import HeatPanel from "../components/HeatPanel";
import InsightCard from "../components/InsightCard";
import { buildInsights } from "../lib/insights";
import { formatDecimal } from "../lib/format";

export default function Dashboard({ data }) {
  const top = data?.topZones?.[0];
  const zones = data?.zonePressure ?? [];
  const insights = buildInsights(data);
  const highPressureCount = zones.filter((z) => (z.pressure_ratio ?? z.observed_pressure_ratio) >= 1.35).length;

  const trend = zones.slice(0, 12).map((z) => ({
    zone: z.zone_name,
    pickups: z.predicted_next_hour_pickups ?? z.observed_next_hour_pickups ?? 0,
  }));

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Predicted Next-Hour Pickups" value={formatDecimal(top?.predicted_next_hour_pickups ?? top?.observed_next_hour_pickups)} subtext="Waiting-Pressure Proxy signal" />
        <KpiCard label="High-Pressure Zones" value={highPressureCount} />
        <KpiCard label="Active Incidents" value={zones.filter((z) => Number(z.incident_flag) === 1).length} />
        <KpiCard label="Weather Status" value={zones[0]?.weather_category ?? "N/A"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard title="Demand Pressure Overview" subtitle="Heat-style zone panel">
            <HeatPanel rows={data?.topZones ?? []} />
          </SectionCard>
        </div>
        <InsightCard title="AI Insights & Recommendations" insights={insights} />
      </div>

      <SectionCard title="Snapshot Trend Preview" subtitle="Top-zone pickup levels">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend}>
              <XAxis dataKey="zone" hide />
              <YAxis />
              <Tooltip />
              <Bar dataKey="pickups" fill="#00856F" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-3 text-xs text-brand-muted">
          Proxy measure; NYC TLC data does not provide a direct passenger waiting-time label.
        </p>
      </SectionCard>
    </div>
  );
}
