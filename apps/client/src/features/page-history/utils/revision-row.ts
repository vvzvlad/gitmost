import { IPageHistory } from "@/features/page-history/types/page.types";
import { historyKindMeta } from "@/features/page-history/utils/history-kind-meta";

/**
 * #568 — pure `IPageHistory → dense-row` adapter for the redesigned page-history
 * panel. No React / Mantine here so it is unit-tested without mounting.
 *
 * TWO orthogonal signals are honored (per #370/#300):
 *  - GLYPH is by AUTHOR IDENTITY: `lastUpdatedSource === 'agent'` with an
 *    `agent` present → a square role glyph + "via <launcher>"; otherwise the
 *    human's round avatar. (An agent AUTOSAVE keeps its agent identity.)
 *  - BADGE is by INTENTIONALITY, simplified to a single SAVED badge: only
 *    `kind === 'manual'`. Agent versions are distinguished by the glyph (no
 *    duplicate badge); autosaves are dimmed (`version === false`).
 */

/** 'YYYY-MM-DD' for `date` in `tz` — the stable per-row key used for day
 *  grouping, jump-to-day and matching heatmap cells. Matches the server's
 *  `isoDay` format (en-CA yields ISO order), so both sides agree. */
export function isoDayInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Localized clock label for `date` in `tz` (e.g. "5:35 AM"). */
export function timeLabelInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export interface RevisionRowData {
  id: string;
  /** epoch-ms, kept for jump-to-day boundary math. */
  ts: number;
  atLabel: string;
  dayISO: string;
  /** author-identity glyph: true → square agent role glyph + "via launcher". */
  isAgent: boolean;
  agentName?: string;
  agentEmoji?: string | null;
  launcherName?: string | null;
  authorName?: string;
  authorAvatarUrl?: string;
  /** intentionality badge: SAVED shown only when true (kind === 'manual'). */
  saved: boolean;
  /** historyKindMeta().version — non-versions (autosaves) are dimmed. */
  version: boolean;
}

export function toRevisionRow(item: IPageHistory, tz: string): RevisionRowData {
  const date = new Date(item.createdAt);
  const isAgent = item.lastUpdatedSource === "agent" && !!item.agent;
  return {
    id: item.id,
    ts: date.getTime(),
    atLabel: timeLabelInTz(date, tz),
    dayISO: isoDayInTz(date, tz),
    isAgent,
    agentName: item.agent?.name,
    agentEmoji: item.agent?.emoji,
    launcherName: item.launcher?.name ?? null,
    authorName: item.lastUpdatedBy?.name,
    authorAvatarUrl: item.lastUpdatedBy?.avatarUrl,
    saved: item.kind === "manual",
    version: historyKindMeta(item.kind).version,
  };
}

export interface RevisionDayGroup {
  dayISO: string;
  /** Representative epoch-ms of the group (first row) for label formatting. */
  ts: number;
  rows: RevisionRowData[];
}

/**
 * Group already-ordered (newest-first) rows into contiguous day buckets. The
 * grouping is PURELY presentational — diff/restore still resolve the previous
 * snapshot from the FULL flat list, never from a group. Rows for one day always
 * arrive contiguous because the list is time-ordered, so a single pass suffices.
 */
export function groupRevisionsByDay(
  rows: RevisionRowData[],
): RevisionDayGroup[] {
  const groups: RevisionDayGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.dayISO === row.dayISO) {
      last.rows.push(row);
    } else {
      groups.push({ dayISO: row.dayISO, ts: row.ts, rows: [row] });
    }
  }
  return groups;
}

/**
 * Relative day-group heading: "Today" / "Yesterday" (i18n via `t`) else an
 * absolute "Mon 12 Jul" (locale-formatted, no year to stay compact). `now` and
 * `tz` are injected so the function stays pure/testable.
 */
export function dayGroupLabel(
  group: Pick<RevisionDayGroup, "dayISO" | "ts">,
  tz: string,
  now: Date,
  t: (key: string) => string = (k) => k,
): string {
  const todayISO = isoDayInTz(now, tz);
  const yesterdayISO = isoDayInTz(
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
    tz,
  );
  if (group.dayISO === todayISO) return t("Today");
  if (group.dayISO === yesterdayISO) return t("Yesterday");
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(group.ts));
}

/**
 * Heatmap tier ceilings for a day's TOTAL revision count (#605). The heatmap now
 * counts ALL revisions per day (any kind), not just versions, so daily sums are
 * an order of magnitude larger than the old version-only counts and the old
 * ≤2 / ≤4 ceilings degenerated to a single top tier.
 *
 * These ceilings are a roughly log/tertile-flavored split of the real stage
 * daily sums (8, 13, 19, 48, 73, 76, 163, 426): low days (8–19) land in tier 1,
 * mid days (48–76) in tier 2, and heavy days (163, 426) in tier 3 — all three
 * tiers used, low and high genuinely distinct (issue #605 acceptance criterion 4).
 */
export const HEAT_LOW_TO_MID_CEILING = 20;
export const HEAT_MID_TO_HIGH_CEILING = 100;

/** heatmap intensity tier for a day's total revision count:
 *  0 none, 1 low (≤20), 2 mid (≤100), 3 heavy (>100). */
export function heatLevel(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count <= HEAT_LOW_TO_MID_CEILING) return 1;
  if (count <= HEAT_MID_TO_HIGH_CEILING) return 2;
  return 3;
}
