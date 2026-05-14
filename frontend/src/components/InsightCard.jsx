import { Sparkles } from "lucide-react";

export default function InsightCard({
  title = "AI Insights & Recommendations",
  items = [],
  insights = [],
  footnote,
}) {
  const normalized =
    items.length > 0
      ? items
      : (insights || []).map((x) => (typeof x === "string" ? { body: x } : x));
  return (
    <div className="flex h-full min-h-[320px] flex-col rounded-xl border border-brand-border bg-white shadow-card">
      <div className="border-b border-brand-border bg-gradient-to-r from-brand-mint/35 to-transparent px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-brand-text">
          <Sparkles className="text-brand-primary" size={17} strokeWidth={1.85} />
          {title}
        </h3>
        <p className="mt-1 text-[11px] text-brand-muted">
          Demand-pressure highlights from live snapshot • demand-pressure indicator labels only
        </p>
      </div>
      <ul className="flex flex-1 flex-col gap-2.5 overflow-auto p-4">
        {normalized.length === 0 ? (
          <li className="text-sm text-brand-muted">No insights for this snapshot yet.</li>
        ) : (
          normalized.map((item, idx) => {
            const titleText = typeof item === "string" ? null : item.title;
            const body = typeof item === "string" ? item : item.body;
            return (
              <li
                key={idx}
                className="rounded-lg border border-brand-border bg-brand-bg/70 p-3 text-sm shadow-sm"
              >
                {titleText ? (
                  <div className="font-semibold text-brand-text">{titleText}</div>
                ) : null}
                <div className={titleText ? "mt-1 text-brand-muted leading-relaxed" : "text-brand-muted leading-relaxed"}>
                  {body}
                </div>
              </li>
            );
          })
        )}
      </ul>
      {footnote ? <div className="border-t border-brand-border px-4 py-2 text-[11px] text-brand-muted">{footnote}</div> : null}
    </div>
  );
}
