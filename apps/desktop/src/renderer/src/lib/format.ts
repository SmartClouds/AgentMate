/** A byte count with about three significant digits: "9.28 GB", "58.4 MB", "467 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 999.6 would round up to "1000 MB"; step to the next unit instead.
  if (value >= 999.5 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** A sensor temperature in whole degrees, e.g. "61 °C". */
export function formatCelsius(celsius: number): string {
  return `${Math.round(celsius)} °C`;
}

/** A CPU share: "<0.1%" for a trace, one decimal under 10%, whole numbers above. */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return '<0.1%';
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}
