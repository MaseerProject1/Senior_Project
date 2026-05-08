import { useMemo, useState } from "react";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import { riskLabelFromRatio } from "../lib/format";

export default function SimulationLab({ data }) {
  const defaults = data?.scenarioDefaults ?? {};
  const [nextPickups, setNextPickups] = useState(defaults?.target_pickup_count_next_hour ?? 0);
  const [rollMean, setRollMean] = useState(defaults?.pickup_count_roll_mean_24 ?? 1);

  const ratio = useMemo(() => {
    const n = Number(nextPickups);
    const d = Number(rollMean);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return n / d;
  }, [nextPickups, rollMean]);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Scenario Pickups" value={nextPickups} />
        <KpiCard label="Pressure Ratio" value={ratio != null ? ratio.toFixed(2) : "N/A"} />
        <KpiCard label="Scenario Risk" value={riskLabelFromRatio(ratio)} />
        <KpiCard label="Context Signal" value="Display-level scenario estimate" />
      </div>
      <SectionCard title="Scenario Inputs">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Next-Hour Pickups
            <input className="mt-1 w-full rounded border border-brand-border px-2 py-1" value={nextPickups} onChange={(e) => setNextPickups(e.target.value)} />
          </label>
          <label className="text-sm">
            Rolling 24H Pickup Mean
            <input className="mt-1 w-full rounded border border-brand-border px-2 py-1" value={rollMean} onChange={(e) => setRollMean(e.target.value)} />
          </label>
        </div>
        <p className="mt-3 text-xs text-brand-muted">
          This simulation is a frontend prototype and uses waiting-pressure proxy values, not direct passenger waiting time.
        </p>
      </SectionCard>
    </div>
  );
}
