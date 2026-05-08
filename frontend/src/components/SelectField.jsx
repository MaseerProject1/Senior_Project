export default function SelectField({ label, value, onChange, options = [], placeholder, className = "" }) {
  return (
    <label className={`flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-brand-muted ${className}`}>
      {label}
      <select
        value={value ?? ""}
        onChange={(e) => onChange?.(e.target.value)}
        className="min-h-[38px] min-w-[140px] cursor-pointer rounded-lg border border-brand-border bg-white px-3 py-2 text-sm normal-case tracking-normal text-brand-text shadow-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((opt) =>
          typeof opt === "object" ? (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ) : (
            <option key={opt} value={opt}>
              {opt}
            </option>
          )
        )}
      </select>
    </label>
  );
}
