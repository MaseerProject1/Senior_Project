export default function KpiCard({ label, value, subtext }) {
  return (
    <div className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
      <div className="text-xs uppercase tracking-wide text-brand-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-brand-text">{value}</div>
      {subtext ? <div className="mt-1 text-xs text-brand-muted">{subtext}</div> : null}
    </div>
  );
}
