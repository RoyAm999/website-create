export function parseShekelInput(value: string): number | null {
  const normalized = value.trim().replace(/\s| /g, "");
  // A comma may be a decimal separator, but a grouped value such as 1,000 is
  // deliberately rejected instead of being silently converted to one shekel.
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) return null;
  const number = Number(normalized.replace(",", "."));
  if (!Number.isFinite(number) || number < 0) return null;
  const minor = Math.round(number * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function formatShekelMinor(minor: number): string {
  return (minor / 100).toLocaleString("he-IL", {
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
