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
  return `${formatDecimal(value, 2)}x`;
}

export function formatPercent(value) {
  if (!isValidNumber(value)) return "N/A";
  return `${formatDecimal(Number(value) * 100, 1)}%`;
}

export function riskLabelFromRatio(ratio) {
  if (!isValidNumber(ratio)) return "Unavailable";
  if (Number(ratio) >= 1.35) return "High Pressure";
  if (Number(ratio) >= 1.0) return "Elevated Pressure";
  if (Number(ratio) >= 0.75) return "Typical Pressure";
  return "Low Pressure";
}

export function riskToneFromRatio(ratio) {
  if (!isValidNumber(ratio)) return "neutral";
  if (Number(ratio) >= 1.35) return "danger";
  if (Number(ratio) >= 1.0) return "warning";
  if (Number(ratio) >= 0.75) return "neutral";
  return "success";
}
