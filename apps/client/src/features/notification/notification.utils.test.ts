import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import i18n from "@/i18n.ts";
import {
  formatRelativeTime,
  getTimeGroup,
  groupNotificationsByTime,
} from "@/features/notification/notification.utils.ts";
import type { INotification } from "@/features/notification/types/notification.types.ts";

/**
 * `getTimeGroup` classifies a timestamp into today / yesterday / this_week /
 * older using LOCAL-time day boundaries derived from `now`. To stay timezone-
 * independent, the boundary anchors are computed exactly the way the SUT does
 * (local midnight of today, minus 1 day, minus 7 days) and inputs are offset
 * from those anchors by a safe margin. `groupNotificationsByTime` buckets a
 * list, drops empty groups, and preserves input order within each group, in the
 * fixed order today -> yesterday -> this_week -> older.
 */
const FIXED_NOW = new Date("2026-06-21T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// Local midnight of "today" relative to the frozen clock.
function startOfTodayLocal(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// An ISO string `offsetMs` away from local midnight of today.
function fromTodayStart(offsetMs: number): string {
  return new Date(startOfTodayLocal().getTime() + offsetMs).toISOString();
}

function notif(id: string, createdAt: string): INotification {
  return {
    id,
    createdAt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("getTimeGroup — boundary classification", () => {
  it("classifies a time after today's midnight as 'today'", () => {
    expect(getTimeGroup(fromTodayStart(HOUR))).toBe("today");
  });

  it("classifies exactly today's midnight as 'today' (inclusive lower bound)", () => {
    expect(getTimeGroup(fromTodayStart(0))).toBe("today");
  });

  it("classifies the slice between yesterday-midnight and today-midnight as 'yesterday'", () => {
    expect(getTimeGroup(fromTodayStart(-HOUR))).toBe("yesterday");
    expect(getTimeGroup(fromTodayStart(-DAY))).toBe("yesterday"); // start of yesterday, inclusive
  });

  it("classifies 2..7 days before today as 'this_week'", () => {
    expect(getTimeGroup(fromTodayStart(-DAY - HOUR))).toBe("this_week");
    expect(getTimeGroup(fromTodayStart(-7 * DAY))).toBe("this_week"); // start of week, inclusive
  });

  it("classifies anything before the 7-day window as 'older'", () => {
    expect(getTimeGroup(fromTodayStart(-7 * DAY - HOUR))).toBe("older");
    expect(getTimeGroup(fromTodayStart(-30 * DAY))).toBe("older");
  });
});

describe("groupNotificationsByTime", () => {
  const labels = {
    today: "Today",
    yesterday: "Yesterday",
    this_week: "This week",
    older: "Older",
  };

  it("returns groups in the order today -> yesterday -> this_week -> older", () => {
    // Provide rows out of order to prove ordering comes from the group order,
    // not input order.
    const result = groupNotificationsByTime(
      [
        notif("old", fromTodayStart(-30 * DAY)),
        notif("today", fromTodayStart(HOUR)),
        notif("week", fromTodayStart(-3 * DAY)),
        notif("yest", fromTodayStart(-HOUR)),
      ],
      labels,
    );
    expect(result.map((g) => g.key)).toEqual([
      "today",
      "yesterday",
      "this_week",
      "older",
    ]);
    expect(result.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "This week",
      "Older",
    ]);
  });

  it("preserves input order within a single group", () => {
    const result = groupNotificationsByTime(
      [
        notif("t1", fromTodayStart(HOUR)),
        notif("t2", fromTodayStart(2 * HOUR)),
        notif("t3", fromTodayStart(3 * HOUR)),
      ],
      labels,
    );
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("today");
    expect(result[0].notifications.map((n) => n.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("drops empty groups", () => {
    const result = groupNotificationsByTime(
      [notif("only-today", fromTodayStart(HOUR))],
      labels,
    );
    expect(result.map((g) => g.key)).toEqual(["today"]);
  });

  it("returns an empty array for no notifications", () => {
    expect(groupNotificationsByTime([], labels)).toEqual([]);
  });
});

describe("formatRelativeTime — relative buckets and absolute-date fallback", () => {
  // Distinct fixed clock for the relative formatter (uses Date.now via `new
  // Date()`), so the bucket boundaries are deterministic under fake timers.
  const NOW = new Date("2026-06-15T12:00:00.000Z");
  const MIN = 60_000;

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  // ISO string `ms` milliseconds before NOW.
  function ago(ms: number): string {
    return new Date(NOW.getTime() - ms).toISOString();
  }

  it("returns the i18n 'now' label for anything under a minute", () => {
    expect(formatRelativeTime(ago(0))).toBe(i18n.t("now"));
    expect(formatRelativeTime(ago(59_000))).toBe(i18n.t("now"));
  });

  it("crosses into the minutes bucket exactly at 1 minute", () => {
    expect(formatRelativeTime(ago(MIN - 1000))).toBe(i18n.t("now"));
    expect(formatRelativeTime(ago(MIN))).toBe("1m");
    expect(formatRelativeTime(ago(5 * MIN))).toBe("5m");
    expect(formatRelativeTime(ago(59 * MIN))).toBe("59m");
  });

  it("crosses into the hours bucket exactly at 60 minutes", () => {
    expect(formatRelativeTime(ago(60 * MIN - 1000))).toBe("59m");
    expect(formatRelativeTime(ago(HOUR))).toBe("1h");
    expect(formatRelativeTime(ago(23 * HOUR))).toBe("23h");
  });

  it("crosses into the days bucket exactly at 24 hours", () => {
    expect(formatRelativeTime(ago(24 * HOUR - 1000))).toBe("23h");
    expect(formatRelativeTime(ago(DAY))).toBe("1d");
    expect(formatRelativeTime(ago(6 * DAY))).toBe("6d");
  });

  it("falls back to an absolute short date once >= 7 days old", () => {
    // 6d -> still relative; 7d -> absolute date (no longer N[mhd], and equal to
    // the localized short-date of the source timestamp).
    expect(formatRelativeTime(ago(6 * DAY))).toBe("6d");

    const sevenDaysAgo = ago(7 * DAY);
    const result = formatRelativeTime(sevenDaysAgo);
    expect(result).not.toMatch(/^\d+[mhd]$/);
    expect(result).not.toBe(i18n.t("now"));
    const expected = new Intl.DateTimeFormat(i18n.language, {
      month: "short",
      day: "numeric",
    }).format(new Date(sevenDaysAgo));
    expect(result).toBe(expected);
  });
});
