import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import HeatPanel from "../components/HeatPanel";
import InsightCard from "../components/InsightCard";

export default function RideHailingOps({ data }) {
  const top = data?.topZones?.[0];
  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Expected Pickups" value={top?.predicted_next_hour_pickups ?? top?.observed_next_hour_pickups ?? "N/A"} />
        <KpiCard label="Demand Pressure Ratio" value={top?.pressure_ratio?.toFixed?.(2) ?? "N/A"} />
        <KpiCard label="Zones Needing Attention" value={(data?.topZones ?? []).filter((z) => (z.pressure_ratio ?? z.observed_pressure_ratio) >= 1.35).length} />
        <KpiCard label="Pressure Alert" value={(top?.pressure_ratio ?? 0) >= 1.35 ? "High" : "Typical"} />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard title="Operational Demand Panel">
            <HeatPanel rows={data?.topZones ?? []} />
          </SectionCard>
        </div>
        <InsightCard
          title="Operational Recommendations"
          insights={[
            "Review supply coverage in top demand-pressure zones.",
            "Monitor zones before peak demand windows.",
            "Use pressure ratio as waiting-pressure proxy, not direct waiting time.",
            "No real-time driver availability is included in this dashboard.",
          ]}
        />
      </div>
    </div>
  );
}
