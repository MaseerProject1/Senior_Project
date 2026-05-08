import { useEffect, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar";
import Header from "./components/Header";
import Footer from "./components/Footer";
import Dashboard from "./pages/Dashboard";
import TransportAuthority from "./pages/TransportAuthority";
import RideHailingOps from "./pages/RideHailingOps";
import ModelPerformance from "./pages/ModelPerformance";
import SimulationLab from "./pages/SimulationLab";
import DataInfo from "./pages/DataInfo";
import { loadDashboardData } from "./lib/data";

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
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refreshData() {
    setLoading(true);
    setError("");
    try {
      const data = await loadDashboardData();
      setDashboardData(data);
      if (!data?.overview) {
        setError(
          "Dashboard data has not been exported yet. Run: python scripts/export_dashboard_data.py"
        );
      }
    } catch (err) {
      setError(
        "Dashboard data has not been exported yet. Run: python scripts/export_dashboard_data.py"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshData();
  }, []);

  const ActiveComponent = useMemo(
    () => PAGES.find((p) => p.id === activePage)?.component ?? Dashboard,
    [activePage]
  );

  const latestTs =
    dashboardData?.zonePressure?.[0]?.timestamp ?? "Exported Data Ready";

  return (
    <div className="min-h-screen bg-brand-bg">
      <Sidebar pages={PAGES} activePage={activePage} setActivePage={setActivePage} />
      <main className="ml-64 min-h-screen p-6">
        <Header title={PAGES.find((p) => p.id === activePage)?.label ?? "Dashboard"} subtitle={dashboardData?.overview?.subtitle} latestTs={latestTs} onRefresh={refreshData} />
        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="rounded-xl border border-brand-border bg-white p-8 text-sm text-brand-muted">
            Loading dashboard...
          </div>
        ) : (
          <ActiveComponent data={dashboardData} />
        )}
        <Footer />
      </main>
    </div>
  );
}
