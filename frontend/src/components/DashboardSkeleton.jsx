export default function DashboardSkeleton() {
  return (
    <div className="space-y-5 animate-pulse" aria-hidden>
      <div className="h-36 rounded-2xl bg-gradient-to-r from-slate-200/90 via-brand-mint/40 to-slate-100" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((k) => (
          <div key={k} className="h-24 rounded-xl bg-white shadow-card ring-1 ring-brand-border/60" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.55fr_340px]">
        <div className="h-[min(480px,52vh)] rounded-2xl bg-slate-100/90 ring-1 ring-brand-border" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((k) => (
            <div key={k} className="h-24 rounded-xl bg-white shadow-card ring-1 ring-brand-border/70" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-64 rounded-xl bg-white ring-1 ring-brand-border/70 lg:col-span-1" />
        <div className="h-64 rounded-xl bg-white ring-1 ring-brand-border/70 lg:col-span-2" />
      </div>
    </div>
  );
}
