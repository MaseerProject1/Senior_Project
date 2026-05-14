const accentMap = {
  teal: "bg-maseer-mint/70 text-brand-primary",
  mint: "bg-maseer-mint/90 text-brand-deep",
  warn: "bg-amber-100/90 text-amber-900",
  danger: "bg-red-50 text-brand-critical",
  neutral: "bg-slate-100 text-slate-700",
};

export default function KpiCard({
  label,
  value,
  subtext,
  icon: Icon,
  accent = "teal",
  /** When true, value is not truncated; wrapping is controlled via classes (no character-by-character break-all on value). */
  allowValueWrap = false,
  /** Merged into the value element when `allowValueWrap` (e.g. `whitespace-pre-line`, `whitespace-nowrap`). */
  valueClassName = "",
  /** Merged into the subtext element (e.g. `break-words` for long secondary lines). */
  subtextClassName = "",
  /** Optional native tooltip on the value block (e.g. full target column name). */
  valueTitle,
}) {
  const ring = accentMap[accent] ?? accentMap.teal;
  return (
    <div
      className={`flex h-full min-h-0 gap-3 rounded-xl border border-brand-border bg-white p-4 shadow-card ${
        allowValueWrap ? "items-start" : "items-center"
      }`}
    >
      {Icon ? (
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${ring}`}
        >
          <Icon size={22} strokeWidth={1.75} />
        </div>
      ) : null}
      <div className={`min-w-0 max-w-full flex-1 flex flex-col ${allowValueWrap ? "justify-start" : "justify-center"}`}>
        <div className="max-w-full whitespace-normal text-[11px] font-semibold uppercase tracking-wider text-brand-muted">
          {label}
        </div>
        <div
          title={valueTitle}
          className={
            allowValueWrap
              ? `mt-1 max-w-full whitespace-normal break-normal text-lg font-semibold tabular-nums leading-tight text-brand-text sm:text-xl ${valueClassName}`.trim()
              : "mt-1 max-w-full truncate text-2xl font-semibold tabular-nums text-brand-text"
          }
        >
          {value}
        </div>
        {subtext ? (
          <div
            className={`mt-1 max-w-full text-xs leading-snug text-brand-muted ${allowValueWrap ? `break-words ${subtextClassName}`.trim() : ""}`}
          >
            {subtext}
          </div>
        ) : null}
      </div>
    </div>
  );
}
