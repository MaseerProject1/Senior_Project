export default function PageHeader({ title, subtitle, children }) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-brand-border pb-5">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight text-brand-text sm:text-[1.65rem] sm:leading-snug">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-[52rem] text-sm leading-relaxed text-brand-muted">{subtitle}</p>
        ) : null}
      </div>
      {children ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
      ) : null}
    </header>
  );
}
