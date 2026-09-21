import { TimelineSample } from './work-time.types';
import { zonedDayStart, isoDay } from './bucket-by-day';

/** One calendar day of the page-history heatmap (#568, #605): the number of
 *  ALL revisions (any kind) that landed on that day — i.e. day activity. */
export interface DayCount {
  /** 'YYYY-MM-DD' in the requested tz — the same stable key the client uses to
   *  group the dense revision list. In the default (filter-off) list a heatmap
   *  cell maps to a list row; with "Only versions" on, an autosave-only day is
   *  lit but has no version row (#605 — heatmap is broader than the filter). */
  dayISO: string;
  count: number;
}

/**
 * #568/#605 — pure, tz-aware "all revisions per day" bucketer for the
 * mini-calendar heatmap. Reuses the already-tested tz core (`zonedDayStart` +
 * `isoDay` from bucket-by-day.ts) so DST/day boundaries stay identical to the
 * work-time punch-card — no copy-pasted date math.
 *
 * ALL rows are counted regardless of kind (manual, agent, idle/boundary
 * autosnapshots, legacy null): the heatmap reflects total day activity, not
 * just versions (#605). This is intentionally broader than the client's "Only
 * versions" list filter, which stays about versions.
 *
 * Returns days ascending by `dayISO`; days with no revision are omitted
 * (the client renders a full month grid and treats a missing day as count 0).
 */
export function countRevisionsByDay(
  rows: ReadonlyArray<Pick<TimelineSample, 'createdAt' | 'kind'>>,
  tz: string,
): DayCount[] {
  const tally = new Map<string, number>();
  for (const row of rows) {
    const ms = new Date(row.createdAt).getTime();
    if (Number.isNaN(ms)) continue;
    const key = isoDay(zonedDayStart(ms, tz), tz);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([dayISO, count]) => ({ dayISO, count }))
    .sort((a, b) => (a.dayISO < b.dayISO ? -1 : a.dayISO > b.dayISO ? 1 : 0));
}
