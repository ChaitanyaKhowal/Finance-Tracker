export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

/**
 * Strictly validates calendar dates (YYYY-MM-DD), rejecting impossible dates
 * such as February 31, April 31, or leap-year mismatches like 2025-02-29.
 */
export function isValidCalendarDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return false;
  const trimmed = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const [yStr, mStr, dStr] = trimmed.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const day = Number(dStr);
  if (m < 1 || m > 12) return false;
  if (day < 1 || day > 31) return false;

  const d = new Date(y, m - 1, day);
  return (
    d.getFullYear() === y &&
    d.getMonth() === m - 1 &&
    d.getDate() === day
  );
}

/**
 * Formats a valid YYYY-MM-DD string into "DD Mon YYYY" (e.g. "15 Oct 2026").
 * Uses direct string parsing to avoid UTC/timezone boundary shifts.
 */
export function fmtDate(iso) {
  if (!iso || !isValidCalendarDate(iso)) return iso || "";
  const [y, m, d] = iso.split("-");
  const monthName = MONTH_SHORT[Number(m) - 1] || m;
  return `${d} ${monthName} ${y}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Derives month (1-12) and year from a validated YYYY-MM-DD date string.
 * Parsed directly from string components to remain completely timezone-immune.
 */
export function deriveDateParts(dateStr) {
  if (!isValidCalendarDate(dateStr)) return { month: null, year: null };
  const [y, m] = dateStr.split("-");
  return { month: Number(m), year: Number(y) };
}
