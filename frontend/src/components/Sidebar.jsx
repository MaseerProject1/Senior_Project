import { LayoutDashboard, Building2, Car, BarChart3, SlidersHorizontal, Database } from "lucide-react";

const icons = {
  dashboard: LayoutDashboard,
  transport: Building2,
  ops: Car,
  models: BarChart3,
  simulation: SlidersHorizontal,
  data: Database,
};

export default function Sidebar({ pages, activePage, setActivePage }) {
  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-gradient-to-b from-brand-deep to-brand-mid p-4 text-white">
      <div className="mb-6 rounded-xl bg-white p-4 text-center">
        <img
          src="/maseer_logo.png"
          alt="MASEER"
          className="mx-auto mb-2 max-h-24 w-auto object-contain"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
        <div className="text-lg font-bold text-brand-primary">MASEER</div>
        <div className="text-xs text-brand-muted">NYC Taxi Demand Pressure Forecasting</div>
      </div>
      <nav className="space-y-2">
        {pages.map((page) => {
          const Icon = icons[page.id] ?? LayoutDashboard;
          const active = activePage === page.id;
          return (
            <button
              key={page.id}
              onClick={() => setActivePage(page.id)}
              className={`flex w-full items-center gap-2 rounded-full px-3 py-2 text-left text-sm ${active ? "bg-brand-mint/25 text-brand-mint" : "hover:bg-white/10"}`}
            >
              <Icon size={16} />
              {page.label}
            </button>
          );
        })}
      </nav>
      <div className="mt-6 space-y-2 rounded-xl bg-white/10 p-3 text-xs">
        <div>Data Status: Ready</div>
        <div>Mode: Frontend Demo</div>
        <div>MASEER v1.0.0</div>
      </div>
    </aside>
  );
}
