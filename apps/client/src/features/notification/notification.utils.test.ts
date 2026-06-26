import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
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
