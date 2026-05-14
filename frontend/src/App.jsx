import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Footer from "./components/Footer";
import AccessDenied from "./components/AccessDenied";
import Dashboard from "./pages/Dashboard";
import TransportAuthority from "./pages/TransportAuthority";
import RideHailingOps from "./pages/RideHailingOps";
import ModelPerformance from "./pages/ModelPerformance";
import SimulationLab from "./pages/SimulationLab";
import DataInfo from "./pages/DataInfo";
import RoleLogin from "./pages/RoleLogin";
import { StakeholderRoleProvider } from "./context/StakeholderRoleContext";
import {
  readStoredSession,
  clearStoredSession,
  canAccessPage,
  clearRegulatoryAlertsSessionHide,
  ROLE_LABEL,
  defaultLandingPageId,
  welcomeToastText,
} from "./lib/roleAccess";
import { getHealth, getOverview, logFallbackMode, prefetchCoreData } from "./lib/api";
import { isoToDisplay } from "./lib/format";

const LOG = "[MASEER]";

const PAGES = [
  { id: "dashboard", label: "Dashboard", component: Dashboard },
  { id: "transport", label: "Transport Authority", component: TransportAuthority },
  { id: "ops", label: "Ride-Hailing Companies", component: RideHailingOps },
  { id: "models", label: "Model Performance", component: ModelPerformance },
  { id: "simulation", label: "Simulation Lab", component: SimulationLab },
  { id: "data", label: "Data Info", component: DataInfo },
];

function WelcomeBanner({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return undefined;
    const t = window.setTimeout(() => onDismiss(), 5200);
    return () => window.clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      className="pointer-events-auto fixed left-1/2 top-5 z-[42] w-[min(92vw,420px)] -translate-x-1/2 rounded-xl border border-emerald-200/90 bg-gradient-to-r from-brand-mint via-white to-brand-mint/90 px-4 py-2.5 text-center shadow-soft"
      role="status"
    >
      <div className="flex items-start justify-center gap-2">
        <p className="flex-1 text-sm font-semibold text-brand-deep">{message}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-lg p-0.5 text-brand-muted transition-colors hover:bg-white/80 hover:text-brand-text"
          aria-label="Dismiss welcome message"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function MaseerWorkspace({ session, onSwitchRole, welcomeMessage, onDismissWelcome }) {
  const [activePage, setActivePage] = useState(() => defaultLandingPageId(session.role));
  const [overview, setOverview] = useState(null);
  const [apiOnline, setApiOnline] = useState(null);
  const [lastRefreshDisplay, setLastRefreshDisplay] = useState("");
  const healthRefreshGen = useRef(0);
  const prefetchOnce = useRef(false);

  const refreshMeta = useCallback(async (opts = {}) => {
    const forceRefresh = opts.forceRefresh === true;
    const id = ++healthRefreshGen.current;

    const health = await getHealth();
    if (id !== healthRefreshGen.current) return;

    if (health.ok) {
      console.info(`${LOG} /api/health → OK (status=${health.status})`);
      setApiOnline(true);

      if (!prefetchOnce.current) {
        prefetchOnce.current = true;
        void prefetchCoreData();
      }

      const ov = await getOverview({ allowStaticFallback: false, forceRefresh });
      if (id !== healthRefreshGen.current) return;

      if (ov.ok !== false) {
        setOverview(ov.data ?? null);
      } else {
        console.warn(`${LOG} /api/overview failed while API is online; keeping prior overview if any.`, ov.error ?? "");
      }
    } else {
      console.warn(`${LOG} /api/health → FAIL (status=${health.status})`);
      prefetchOnce.current = false;
      setApiOnline(false);
      logFallbackMode(`/api/health did not succeed (status=${health.status}); loading exported JSON snapshots.`);

      const ov = await getOverview({ allowStaticFallback: true });
      if (id !== healthRefreshGen.current) return;
      setOverview(ov.data ?? null);
    }

    setLastRefreshDisplay(isoToDisplay(new Date().toISOString()));
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const visiblePages = useMemo(
    () => PAGES.filter((p) => canAccessPage(session.role, p.id)),
    [session.role]
  );

  const ActiveComponent = useMemo(
    () => PAGES.find((p) => p.id === activePage)?.component ?? Dashboard,
    [activePage]
  );

  const pageCfg = PAGES.find((p) => p.id === activePage);
  const allowed = canAccessPage(session.role, activePage);

  const badgeApi = apiOnline === true;
  const badgeFallback = apiOnline === false;

  const sidebarName = session.welcomeName || session.displayName || "";

  return (
    <StakeholderRoleProvider
      role={session.role}
      displayName={session.displayName}
      username={session.username}
      welcomeName={session.welcomeName}
      onSwitchRole={onSwitchRole}
    >
      <div className="min-h-screen bg-brand-bg antialiased">
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[41] flex justify-center px-4 pt-2">
          <WelcomeBanner message={welcomeMessage} onDismiss={onDismissWelcome} />
        </div>
        <Sidebar
          pages={visiblePages}
          activePage={activePage}
          setActivePage={setActivePage}
          apiOnline={apiOnline}
          lastRefresh={lastRefreshDisplay}
          userDisplayName={sidebarName}
          roleLabel={ROLE_LABEL[session.role]}
          onSwitchRole={onSwitchRole}
        />
        <main className="min-h-screen pl-[240px]">
          <div
            className={`pointer-events-none fixed right-5 top-6 z-30 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide opacity-95 shadow-soft ${
              badgeApi
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : badgeFallback
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-slate-200 bg-slate-50 text-slate-700"
            }`}
            title="Backed by GET /api/health"
          >
            {apiOnline === null ? "Checking API…" : badgeApi ? "API Online" : "Exported Data Fallback"}
          </div>
          <div className="mx-auto max-w-[1600px] px-5 pt-14 pb-10">
            {allowed ? (
              <ActiveComponent
                pageMeta={{ label: pageCfg?.label ?? "Dashboard", apiOnline }}
                overview={overview}
                refreshHealth={refreshMeta}
                apiOnline={apiOnline}
              />
            ) : (
              <AccessDenied pageLabel={pageCfg?.label ?? "This page"} onGoDashboard={() => setActivePage("dashboard")} />
            )}
            <Footer />
          </div>
        </main>
      </div>
    </StakeholderRoleProvider>
  );
}

export default function App() {
  const [session, setSession] = useState(() => readStoredSession());
  const [welcomeMessage, setWelcomeMessage] = useState(null);

  const handleEntered = useCallback((s) => {
    setSession(s);
    setWelcomeMessage(welcomeToastText(s));
  }, []);

  const dismissWelcome = useCallback(() => {
    setWelcomeMessage(null);
  }, []);

  const handleSwitchRole = useCallback(() => {
    clearStoredSession();
    clearRegulatoryAlertsSessionHide();
    setWelcomeMessage(null);
    setSession(null);
  }, []);

  if (!session?.role) {
    return <RoleLogin onEntered={handleEntered} />;
  }

  return (
    <MaseerWorkspace
      session={session}
      onSwitchRole={handleSwitchRole}
      welcomeMessage={welcomeMessage}
      onDismissWelcome={dismissWelcome}
    />
  );
}
