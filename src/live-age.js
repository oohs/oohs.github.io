export const BIRTH_MS = Date.parse("2004-01-03T03:14:00-08:00");
export const TROPICAL_YEAR_MS = 365.2425 * 86400000;

// Eleven characters through age 99, matching the fixed token count used by
// the corruption and transition systems.
export function formatLiveAge(now = Date.now()) {
  const years = Math.max(0, (Number(now) - BIRTH_MS) / TROPICAL_YEAR_MS);
  return years.toFixed(8).padStart(11, "0");
}
