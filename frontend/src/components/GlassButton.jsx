export default function GlassButton({ children, onClick, variant = "secondary", type = "button", disabled, className = "" }) {
  const cls =
    variant === "primary"
      ? "border-brand-primary bg-brand-primary text-white hover:bg-[#007360]"
      : "border-brand-border bg-white text-brand-text hover:border-brand-primary/40";
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-50 ${cls} ${className}`.trim()}
    >
      {children}
    </button>
  );
}
