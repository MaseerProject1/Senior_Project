import {
  LayoutDashboard,
  Building2,
  Car,
  BarChart3,
  SlidersHorizontal,
  Database,
} from "lucide-react";
import brandLogo from "../assets/maseer-logo.jpg";

const icons = {
  dashboard: LayoutDashboard,
  transport: Building2,
  ops: Car,
  models: BarChart3,
  simulation: SlidersHorizontal,
  data: Database,
};

function modeLabel(apiOnline) {
  if (apiOnline === null) return "Checking API…";
  return apiOnline ? "API Online" : "Exported Data Fallback";
}

export default function Sidebar({ pages, activePage, setActivePage, apiOnline, lastRefresh }) {
  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-[240px] flex-col bg-gradient-to-b from-[#002B24] via-[#003C35] to-[#021e19] px-3 pb-5 pt-6 text-[13px] text-white shadow-soft">
      <div className="mb-8 rounded-xl border border-white/10 bg-brand-mid/30 px-3 py-3">
        <div className="flex items-center gap-2">
          <img
            src={brandLogo}
            alt="MASEER logo"
            className="h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ring-white/20"
          />
          <div className="min-w-0">
            <div className="text-[15px] font-bold tracking-wide">MASEER</div>
            <div className="text-[10px] font-medium leading-snug text-white/80">
              مسير — NYC demand intelligence
            </div>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-white/70">
          Next-hour pickup demand as a waiting-pressure proxy (TLC zone level).
        </p>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {pages.map((page) => {
          const Icon = icons[page.id] ?? LayoutDashboard;
          const active = activePage === page.id;
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => setActivePage(page.id)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left font-medium transition-colors ${
                active
                  ? "bg-[#DFF7EF] text-[#003C35] shadow-md shadow-black/20 ring-1 ring-[#008B78]/40"
                  : "text-white/92 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon size={17} strokeWidth={1.9} />
              <span>{page.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-4 space-y-2 rounded-xl border border-white/10 bg-brand-mid/25 p-3 text-[11px] leading-snug">
        <div className="flex items-center gap-2 text-white">
          <span
            className={`h-2 w-2 rounded-full shadow-[0_0_12px_rgba(52,211,153,0.9)] ${
              apiOnline === null ? "bg-slate-300" : apiOnline ? "animate-pulse bg-emerald-400" : "bg-amber-300"
            }`}
          />
          <span className="font-semibold">
            Data Status: Ready{apiOnline ? " / API Online" : apiOnline === false ? " / Fallback JSON" : ""}
          </span>
        </div>
        <div
          className={`font-semibold ${
            apiOnline === null ? "text-white/80" : apiOnline ? "text-emerald-300" : "text-amber-200"
          }`}
        >
          Mode: {modeLabel(apiOnline)}
        </div>
        <div className="text-[10px] text-white/65">
          {lastRefresh ? `Last refresh: ${lastRefresh}` : "Awaiting first refresh ping."}
        </div>
        <div className="border-t border-white/10 pt-2 text-center text-[10px] font-semibold text-white/80">
          MASEER v1.0.0
        </div>
      </div>
    </aside>
  );
}
