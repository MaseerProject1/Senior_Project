import { RefreshCcw } from "lucide-react";

export default function Header({ title, subtitle, latestTs, onRefresh }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-brand-text">{title}</h1>
        <p className="text-sm text-brand-muted">{subtitle ?? "Demand pressure dashboard"}</p>
      </div>
      <div className="flex items-center gap-3">
        <span className="rounded-full border border-brand-border bg-white px-3 py-1 text-xs text-brand-muted">
          {latestTs}
        </span>
        <button onClick={onRefresh} className="flex items-center gap-2 rounded-lg border border-brand-border bg-white px-3 py-2 text-sm">
          <RefreshCcw size={14} />
          Refresh
        </button>
      </div>
    </header>
  );
}
