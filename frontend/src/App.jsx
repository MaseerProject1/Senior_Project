import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar";
import Footer from "./components/Footer";
import Dashboard from "./pages/Dashboard";
import TransportAuthority from "./pages/TransportAuthority";
import RideHailingOps from "./pages/RideHailingOps";
import ModelPerformance from "./pages/ModelPerformance";
import SimulationLab from "./pages/SimulationLab";
import DataInfo from "./pages/DataInfo";
import { getHealth, getOverview } from "./lib/api";
import { isoToDisplay } from "./lib/format";

const PAGES = [
  { id: "dashboard", label: "Dashboard", component: Dashboard },
  { id: "transport", label: "Transport Authority", component: TransportAuthority },
  { id: "ops", label: "Ride-Hailing Ops", component: RideHailingOps },
  { id: "models", label: "Model Performance", component: ModelPerformance },
  { id: "simulation", label: "Simulation Lab", component: SimulationLab },
  { id: "data", label: "Data Info", component: DataInfo },
];

export default function App() {
  const [activePage, setActivePage] = useState("dashboard");
  const [overview, setOverview] = useState(null);
  const [apiOnline, setApiOnline] = useState(false);
  const [lastRefreshDisplay, setLastRefreshDisplay] = useState("");

  const refreshMeta = useCallback(async () => {
    const [health, ov] = await Promise.all([getHealth(), getOverview()]);
    setApiOnline(!!health.ok);
    setOverview(ov.data ?? null);
    setLastRefreshDisplay(isoToDisplay(new Date().toISOString()));
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const ActiveComponent = useMemo(
    () => PAGES.find((p) => p.id === activePage)?.component ?? Dashboard,
    [activePage]
  );

  const pageCfg = PAGES.find((p) => p.id === activePage);

  return (
    <div className="min-h-screen bg-brand-bg antialiased">
      <Sidebar
        pages={PAGES}
        activePage={activePage}
        setActivePage={setActivePage}
        apiOnline={apiOnline}
        lastRefresh={lastRefreshDisplay}
      />
      <main className="min-h-screen pl-[240px]">
        <div
          className={`pointer-events-none fixed right-4 top-5 z-30 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide shadow-soft ${
            apiOnline ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
          title="Backed by GET /api/health"
        >
          {apiOnline ? "API Online" : "Static Demo Mode"}
        </div>
        <div className="mx-auto max-w-[1600px] px-5 py-7 pb-10">
          <ActiveComponent
            pageMeta={{ label: pageCfg?.label ?? "Dashboard", apiOnline }}
            overview={overview}
            refreshHealth={refreshMeta}
          />
          <Footer />
        </div>
      </main>
    </div>
  );
}
