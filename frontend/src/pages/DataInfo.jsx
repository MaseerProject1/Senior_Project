import KpiCard from "../components/KpiCard";
import SectionCard from "../components/SectionCard";
import DataTable from "../components/DataTable";

export default function DataInfo({ data }) {
  const summary = data?.datasetSummary ?? {};
  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Rows" value={summary.rows ?? "N/A"} />
        <KpiCard label="Columns" value={summary.columns ?? "N/A"} />
        <KpiCard label="Zones" value={summary.number_of_zones ?? "N/A"} />
        <KpiCard label="Feature Count" value={summary.feature_count ?? "N/A"} />
      </div>
      <SectionCard title="Dataset Summary">
        <p className="text-sm text-brand-muted">
          Target: <strong>{summary.target_column ?? "target_pickup_count_next_hour"}</strong> (next-hour pickup demand as waiting-pressure proxy).
        </p>
      </SectionCard>
      <SectionCard title="Feature Dictionary Preview">
        <DataTable
          columns={[
            { key: "column", label: "Column" },
            { key: "feature_group", label: "Group" },
            { key: "dtype", label: "Type" },
          ]}
          rows={data?.featureDictionary ?? []}
        />
      </SectionCard>
    </div>
  );
}
