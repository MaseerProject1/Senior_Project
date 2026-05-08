export default function SectionCard({ title, subtitle, children, bodyClassName = "", className = "" }) {
  return (
    <section className={`rounded-xl border border-brand-border bg-white shadow-card ${className}`}>
      <div className="border-b border-brand-border px-4 py-3">
        <h3 className="font-semibold text-brand-text">{title}</h3>
        {subtitle ? <p className="text-xs text-brand-muted">{subtitle}</p> : null}
      </div>
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
