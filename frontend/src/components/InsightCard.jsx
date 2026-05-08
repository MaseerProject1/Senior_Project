export default function InsightCard({ title, insights = [] }) {
  return (
    <div className="rounded-xl border border-brand-border bg-white p-4 shadow-card">
      <h3 className="font-semibold text-brand-text">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm text-brand-muted">
        {insights.map((text, idx) => (
          <li key={idx} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 rounded-full bg-brand-secondary" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
