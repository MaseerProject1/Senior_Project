export function isValidNumber(value) {
  const number = Number(value);
  return Number.isFinite(number);
}

export function safeValue(value, fallback = "N/A") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number" && !Number.isFinite(value)) return fallback;
  return value;
}

export function formatNumber(value, decimals = 0) {
  if (!isValidNumber(value)) return "N/A";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatDecimal(value, decimals = 2) {
  if (!isValidNumber(value)) return "N/A";
  return Number(value).toFixed(decimals);
}

export function formatRatio(value) {
  if (!isValidNumber(value)) return "N/A";
  const n = Number(value);
  const d = Number.isInteger(n * 100) ? 2 : Math.min(2, (String(n).split(".")[1] || "").length);
  const shown = Number(n.toFixed(Math.max(d, 2)));
  return `${shown.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}×`;
}

export function formatPercent(value) {
  if (!isValidNumber(value)) return "N/A";
  const n = Number(value);
  const scaled = Math.abs(n) <= 1 ? n * 100 : n;
  return `${Number(scaled).toFixed(1)}%`;
}

export function pressureLabel(ratio) {
  if (!isValidNumber(ratio)) return "Unavailable";
  const r = Number(ratio);
  if (r >= 1.35) return "High Pressure";
  if (r >= 1.15) return "Elevated";
  if (r >= 0.85) return "Typical";
  return "Low";
}

/** Short tier labels for tables and map legend alignment (ratio thresholds). */
export function pressureTierLabel(ratio) {
  if (!isValidNumber(ratio)) return "N/A";
  const r = Number(ratio);
  if (r >= 1.35) return "High";
  if (r >= 1.15) return "Elevated";
  if (r >= 0.85) return "Typical";
  return "Low";
}

export function pressureTone(ratio) {
  if (!isValidNumber(ratio)) return "neutral";
  const r = Number(ratio);
  if (r >= 1.35) return "critical";
  if (r >= 1.15) return "warning";
  if (r >= 0.85) return "neutral";
  return "low";
}

export function riskLabelFromRatio(ratio) {
  return pressureLabel(ratio);
}

export function riskToneFromRatio(ratio) {
  return pressureTone(ratio);
}

export function isoToDisplay(iso, fallback = "Latest snapshot") {
  if (!iso || typeof iso !== "string") return fallback;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}
