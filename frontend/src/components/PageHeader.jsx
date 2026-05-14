export default function PageHeader({ title, subtitle, children, footer, showTitleStatusDot = false }) {
  return (
    <header className="mb-6 rounded-3xl border border-emerald-100/90 bg-gradient-to-br from-white via-brand-mint/35 to-emerald-50/45 p-7 shadow-card ring-1 ring-brand-primary/[0.07]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            {showTitleStatusDot ? (
              <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center" aria-hidden>
                <span className="absolute h-3 w-3 rounded-full bg-brand-teal/30 blur-[3px]" />
                <span className="relative block h-2 w-2 rounded-full bg-brand-teal shadow-[0_0_10px_rgba(0,133,111,0.55),0_0_4px_rgba(0,133,111,0.35)] ring-[3px] ring-brand-primary/15" />
              </span>
            ) : null}
            <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-brand-text sm:text-[1.65rem] sm:leading-snug">
              {title}
            </h1>
          </div>
          {subtitle ? (
            <p className="mt-2 max-w-[52rem] text-sm leading-relaxed text-brand-muted">{subtitle}</p>
          ) : null}
        </div>
        {children ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
        ) : null}
      </div>
      {footer ? (
        <div className="mt-5 space-y-3 border-t border-emerald-100/80 pt-5">{footer}</div>
      ) : null}
    </header>
  );
}
