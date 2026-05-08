const accentMap = {
  teal: "bg-maseer-mint/70 text-brand-primary",
  mint: "bg-maseer-mint/90 text-brand-deep",
  warn: "bg-amber-100/90 text-amber-900",
  danger: "bg-red-50 text-brand-critical",
  neutral: "bg-slate-100 text-slate-700",
};

export default function KpiCard({ label, value, subtext, icon: Icon, accent = "teal" }) {
  const ring = accentMap[accent] ?? accentMap.teal;
  return (
    <div className="flex gap-3 rounded-xl border border-brand-border bg-white p-4 shadow-card">
      {Icon ? (
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${ring}`}
        >
          <Icon size={22} strokeWidth={1.75} />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-muted">{label}</div>
        <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-brand-text">{value}</div>
        {subtext ? (
          <div className="mt-1 text-xs leading-snug text-brand-muted">{subtext}</div>
        ) : null}
      </div>
    </div>
  );
}
