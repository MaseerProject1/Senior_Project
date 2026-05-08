import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import DataTable from "../components/DataTable";

export default function ModelPerformance({ data }) {
  const metrics = data?.modelMetrics ?? [];
  const best = data?.overview?.best_tabular_model ?? "N/A";
  const sorted = [...metrics]
    .sort((a, b) => (a.test_rmse ?? 999) - (b.test_rmse ?? 999))
    .map((m) => ({ name: m.model_name, rmse: m.test_rmse, mae: m.test_mae, r2: m.test_r2 }));

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Best Next-Hour Model" value={best} />
        <KpiCard label="Test RMSE" value={data?.overview?.best_test_rmse?.toFixed?.(3) ?? "N/A"} />
        <KpiCard label="Test MAE" value={data?.overview?.best_test_mae?.toFixed?.(3) ?? "N/A"} />
        <KpiCard label="24H Forecaster" value={data?.overview?.best_forecast_model ?? "N/A"} />
      </div>
      <SectionCard title="Next-Hour RMSE by Model">
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={sorted}>
              <XAxis type="number" />
              <YAxis type="category" dataKey="name" width={120} />
              <Tooltip />
              <Bar dataKey="rmse" fill="#00856F" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>
      <SectionCard title="Model Metrics Table">
        <DataTable
          columns={[
            { key: "model_name", label: "Model" },
            { key: "test_mae", label: "MAE" },
            { key: "test_rmse", label: "RMSE" },
            { key: "test_r2", label: "R²" },
          ]}
          rows={metrics}
        />
      </SectionCard>
    </div>
  );
}
