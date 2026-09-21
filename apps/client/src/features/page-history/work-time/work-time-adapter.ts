// #566 — adapter: real IPageWorkTime → the render-ready shape the redesigned
// time-of-day timeline consumes. The visual prototype (NewDesign/TimeWorkedModal)
// was written against invented props (`DaySummary[]`, pre-made `totalLabel`); the
// real payload is IPageWorkTime. Everything below is pure so the mapping (windows
// → time-of-day blocks, ms → labels, the "now" boundary, empty-run collapsing) is
// unit-testable without React. No re-bucketing: the server already grouped the
// windows by the request timezone — we only lay out the windows it returned.

import { IPageWorkTime, IPerDay, IDayWindow } from "./work-time.types";
import { formatDayTotal, formatHeadline } from "./format-work-time";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export const DAY_MS = 24 * 60 * 60 * 1000;
// Collapse a run of this many (or more) consecutive edit-free days into a single
// "× N days" separator (§6.2 long-range) — preserved from the original punch-card.
export const EMPTY_RUN_COLLAPSE = 8;

export interface TimelineBlock {
  /** Hour fraction 0..24 within the day — drives left/width positioning. */
  start: number;
  end: number;
  kind: "work" | "agent";
  /** Real epoch ms, kept for a DST-safe tooltip (formatted in the data tz). */
  startEpoch: number;
  endEpoch: number;
}

export interface TimelineDay {
  key: string;
  label: string;
  totalLabel: string;
  blocks: TimelineBlock[];
  isEmpty: boolean;
  /** Today lives only in the last active bucket; drives the "now" boundary. */
  isToday: boolean;
  /** 0..1 position of "now" within today's track (undefined when not today). */
  nowFraction?: number;
}

export type TimelineRow =
  | { type: "day"; day: TimelineDay }
  | { type: "gap"; count: number };

/** Weekday-day-month heading in the browser locale (matches the server tz
 *  bucketing, since usePageWorkTime requests buckets in the viewer tz). */
export function dayHeading(day: number): string {
  return new Date(day).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Map one day's absolute windows into time-of-day blocks. `class` work|agent_only
 *  → kind work|agent; positions are the in-day hour fraction (epoch kept for the
 *  tooltip). Fractions are clamped to [0,24] to match the original punch-card. */
export function toBlocks(day: IPerDay): TimelineBlock[] {
  return day.windows.map((w: IDayWindow) => {
    const start = clampHour((w.start - day.day) / (DAY_MS / 24));
    const end = clampHour((w.end - day.day) / (DAY_MS / 24));
    return {
      start,
      end,
      kind: w.class === "work" ? "work" : "agent",
      startEpoch: w.start,
      endEpoch: w.end,
    };
  });
}

function clampHour(h: number): number {
  return Math.max(0, Math.min(24, h));
}

/** Build a single render-ready day. `now` is injected for testability; the
 *  "now" boundary is drawn only when `now` falls inside this bucket's calendar
 *  day (so it appears on today's row and only when today has edits). */
export function toTimelineDay(
  day: IPerDay,
  t: Translate,
  now: number,
): TimelineDay {
  const isToday = now >= day.day && now < day.day + DAY_MS;
  return {
    key: day.dayISO,
    label: dayHeading(day.day),
    totalLabel: formatDayTotal(day.activeMs, t),
    blocks: toBlocks(day),
    isEmpty: day.activeMs === 0 && day.agentMs === 0,
    isToday,
    nowFraction: isToday ? (now - day.day) / DAY_MS : undefined,
  };
}

/** Collapse long edit-free runs (≥ EMPTY_RUN_COLLAPSE) into an in-place "gap"
 *  row; short runs stay as (dimmed, "—") day rows. Preserved from the original
 *  punch-card so a page edited over months does not render hundreds of rows. */
export function buildRows(
  perDay: IPerDay[],
  t: Translate,
  now: number,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let emptyRun: IPerDay[] = [];
  const flush = () => {
    if (emptyRun.length >= EMPTY_RUN_COLLAPSE) {
      rows.push({ type: "gap", count: emptyRun.length });
    } else {
      for (const d of emptyRun) {
        rows.push({ type: "day", day: toTimelineDay(d, t, now) });
      }
    }
    emptyRun = [];
  };
  for (const d of perDay) {
    if (d.activeMs === 0 && d.agentMs === 0) {
      emptyRun.push(d);
    } else {
      flush();
      rows.push({ type: "day", day: toTimelineDay(d, t, now) });
    }
  }
  flush();
  return rows;
}

/** The big summary slot. Fail-safe for an agent-only page (#395/#551): since
 *  formatHeadline(0) === "", never leave the 22px slot empty — put the agent
 *  estimate in the main slot, and only show the secondary `agent:` line when
 *  BOTH a human and an agent estimate exist. */
export function summaryLabels(
  data: IPageWorkTime,
  t: Translate,
): { total: string; agent?: string } {
  const total =
    data.workMs > 0
      ? formatHeadline(data.workMs, t)
      : t("agent: {{value}}", { value: formatHeadline(data.agentOnlyMs, t) });
  const agent =
    data.workMs > 0 && data.agentOnlyMs > 0
      ? formatHeadline(data.agentOnlyMs, t)
      : undefined;
  return { total, agent };
}

/** Block hover label "start – end · duration". Times come from the REAL epoch
 *  rendered in the data tz (NOT the 24h fraction) so a DST-transition day does
 *  not skew the shown clock time. Duration reuses formatDayTotal (always > 0
 *  here, so never "—"). */
export function formatBlockTooltip(
  block: TimelineBlock,
  tz: string,
  locale: string,
  t: Translate,
): string {
  const fmt = new Intl.DateTimeFormat(locale || undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  });
  return t("{{start}} – {{end}} · {{duration}}", {
    start: fmt.format(block.startEpoch),
    end: fmt.format(block.endEpoch),
    duration: formatDayTotal(block.endEpoch - block.startEpoch, t),
  });
}
