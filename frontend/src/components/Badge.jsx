export default function Badge({ children }) {
  return (
    <span className="rounded-full border border-brand-border bg-brand-mint/40 px-2 py-1 text-xs text-brand-primary">
      {children}
    </span>
  );
}
