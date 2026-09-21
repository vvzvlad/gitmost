// #395 — display formatting for the work-time estimate. Pure functions that take
// a translator so ru-RU / en-US wording lives in the i18n catalogue and the
// rounding logic stays unit-testable.

type Translate = (key: string, opts?: Record<string, unknown>) => string;

const MIN = 60 * 1000;

function hm(totalMinutes: number): { hours: number; minutes: number } {
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * Headline number (§6.1): an ESTIMATE, so rounded to a coarse 5-minute step and
 * prefixed with "≈". A non-zero-but-tiny estimate floors to 5m rather than
 * rounding down to "0" (which would read as "no work"). Zero → empty string
 * (the caller hides the widget).
 */
export function formatHeadline(workMs: number, t: Translate): string {
  if (workMs <= 0) return "";
  let minutes = Math.round(workMs / MIN / 5) * 5;
  if (minutes === 0) minutes = 5;
  const { hours, minutes: m } = hm(minutes);
  if (hours > 0 && m > 0) return t("≈ {{hours}}h {{minutes}}m", { hours, minutes: m });
  if (hours > 0) return t("≈ {{hours}}h", { hours });
  return t("≈ {{minutes}}m", { minutes: m });
}

/** Per-day sum (§6.2), rounded to the minute. Zero → "—". */
export function formatDayTotal(activeMs: number, t: Translate): string {
  if (activeMs <= 0) return "—";
  const minutes = Math.max(1, Math.round(activeMs / MIN));
  const { hours, minutes: m } = hm(minutes);
  if (hours > 0 && m > 0) return t("{{hours}}h {{minutes}}m", { hours, minutes: m });
  if (hours > 0) return t("{{hours}}h", { hours });
  return t("{{minutes}}m", { minutes: m });
}

/** The inactivity threshold, for the "estimate · gap = N min" caption. */
export function formatGapMinutes(tGapMs: number): number {
  return Math.round(tGapMs / MIN);
}
