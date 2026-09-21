import { WorkSession, PerDay, DayWindow } from './work-time.types';

/**
 * Merge intervals into a disjoint, sorted union. Overlapping OR touching
 * intervals are joined. Empty input → [].
 */
function union(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      out.push([curStart, curEnd]);
      curStart = s;
      curEnd = e;
    }
  }
  out.push([curStart, curEnd]);
  return out;
}

// Cache one Intl formatter per tz — constructing them is comparatively costly.
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFmt(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in `tz` (DST-correct, via Intl). */
function wallParts(ms: number, tz: string): WallParts {
  const parts = partsFmt(tz).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  let hour = get('hour');
  // Intl emits "24" for midnight under some engines/locales; normalize to 0.
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** tz offset (wall − real) at an instant, in ms. */
function offset(ms: number, tz: string): number {
  const p = wallParts(ms, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - ms;
}

/**
 * Epoch-ms of the local-midnight day start of `ms` in `tz`. DST-correct: takes
 * the calendar day of the instant, its wall-midnight, then converts back with
 * the offset that actually applies AT that midnight (refined once). The rare
 * tz-with-a-DST-transition-exactly-at-midnight case is a documented edge (§9#14).
 */
export function zonedDayStart(ms: number, tz: string): number {
  const p = wallParts(ms, tz);
  const wallMidnightAsUTC = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  let start = wallMidnightAsUTC - offset(ms, tz);
  // Refine with the offset at the computed midnight (DST may differ from `ms`).
  start = wallMidnightAsUTC - offset(start, tz);
  return start;
}

/** The next local midnight after `dayStart` (handles 23/25h DST days). */
function nextDayStart(dayStart: number, tz: string): number {
  // +26h always lands inside the NEXT calendar day (day length ∈ [23h,25h]),
  // never two days ahead; startOf('day') of it is the next midnight.
  return zonedDayStart(dayStart + 26 * 60 * 60 * 1000, tz);
}

export function isoDay(dayStart: number, tz: string): string {
  const p = wallParts(dayStart, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Clip a union to [lo, hi) and emit windows of `class`. */
function clip(
  merged: Array<[number, number]>,
  lo: number,
  hi: number,
  cls: DayWindow['class'],
): DayWindow[] {
  const out: DayWindow[] = [];
  for (const [s, e] of merged) {
    const start = Math.max(s, lo);
    const end = Math.min(e, hi);
    if (end > start) out.push({ start, end, class: cls });
  }
  return out;
}

/**
 * #395 §6.3 — bucket sessions into calendar days of `tz` for the punch-card.
 * Pure and deterministic. `work` and `agent_only` are unioned SEPARATELY (else
 * agent windows would swallow work windows on overlap), then each union is split
 * at tz midnight boundaries (`startOf('day')` in tz, NOT "+24h" — DST-safe §9#14)
 * and clipped to each day.
 *
 * By construction Σ perDay.activeMs == workMs: the days are a partition of the
 * `work` union — no loss, no dup, even on 23/25h DST days. `agent_only` windows
 * are drawn but NOT in activeMs. Empty days between the first and last active day
 * are emitted (empty track + "—") so the rhythm/pauses stay visible.
 */
export function bucketByDay(sessions: WorkSession[], tz: string): PerDay[] {
  const uWork = union(
    sessions.filter((s) => s.class === 'work').map((s) => [s.start, s.end]),
  );
  const uAgent = union(
    sessions
      .filter((s) => s.class === 'agent_only')
      .map((s) => [s.start, s.end]),
  );

  if (uWork.length === 0 && uAgent.length === 0) return [];

  const minStart = Math.min(
    uWork.length ? uWork[0][0] : Infinity,
    uAgent.length ? uAgent[0][0] : Infinity,
  );
  const maxEnd = Math.max(
    uWork.length ? uWork[uWork.length - 1][1] : -Infinity,
    uAgent.length ? uAgent[uAgent.length - 1][1] : -Infinity,
  );

  const perDay: PerDay[] = [];
  let dayStart = zonedDayStart(minStart, tz);
  // Guard against a pathological non-advancing boundary.
  let guard = 0;
  while (dayStart < maxEnd && guard < 100000) {
    guard++;
    const dayEnd = nextDayStart(dayStart, tz);
    const workWin = clip(uWork, dayStart, dayEnd, 'work');
    const agentWin = clip(uAgent, dayStart, dayEnd, 'agent_only');
    const activeMs = workWin.reduce((a, w) => a + (w.end - w.start), 0);
    const agentMs = agentWin.reduce((a, w) => a + (w.end - w.start), 0);
    const windows = [...workWin, ...agentWin].sort((a, b) => a.start - b.start);
    perDay.push({
      day: dayStart,
      dayISO: isoDay(dayStart, tz),
      activeMs,
      agentMs,
      windows,
    });
    dayStart = dayEnd;
  }
  return perDay;
}
