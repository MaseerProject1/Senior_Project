export default function Footer() {
  return (
    <footer className="mt-10 border-t border-brand-border pt-6 text-[11px] text-brand-muted">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <span>Secure • Private • Government Use Only</span>
        <span className="tabular-nums">MASEER v1.0.0</span>
        <span className="text-right">
          Source: TLC Trip Data • Weather • Events / Incidents (proxy features only)
        </span>
      </div>
    </footer>
  );
}
