import { describe, it, expect } from "vitest";
import {
  buildRows,
  formatBlockTooltip,
  summaryLabels,
  toBlocks,
  toTimelineDay,
  EMPTY_RUN_COLLAPSE,
} from "./work-time-adapter";
import { IPageWorkTime, IPerDay } from "./work-time.types";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;

// Fake translator: renders the key with {{tokens}} substituted, so the tests
// assert the mapping/branching without depending on the i18n catalogue.
const t = (key: string, opts?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ""));

// A day midnight anchored at a fixed UTC instant (tz handled server-side; we
// only lay out fractions of the day the server already bucketed).
const DAY0 = Date.UTC(2026, 5, 29, 0, 0, 0); // Mon 29 Jun 2026 00:00 UTC

function day(over: Partial<IPerDay> & { day: number }): IPerDay {
  return {
    dayISO: new Date(over.day).toISOString().slice(0, 10),
    activeMs: 0,
    agentMs: 0,
    windows: [],
    ...over,
  };
}

const config: IPageWorkTime["config"] = {
  tGap: 15 * MIN,
  agentTGap: 15 * MIN,
  pIn: 0,
  pOut: 0,
  pSingle: 30 * 1000,
  excludeGit: false,
  dedupRoundMs: 1000,
};

function payload(over: Partial<IPageWorkTime>): IPageWorkTime {
  return {
    workMs: 0,
    agentOnlyMs: 0,
    perDay: [],
    config,
    tz: "UTC",
    ...over,
  };
}

describe("toBlocks", () => {
  it("maps work+agent windows to time-of-day segments (hour fractions)", () => {
    const d = day({
      day: DAY0,
      activeMs: 90 * MIN,
      windows: [
        { start: DAY0 + 9 * HOUR, end: DAY0 + 10 * HOUR + 30 * MIN, class: "work" },
        { start: DAY0 + 22 * HOUR, end: DAY0 + 23 * HOUR, class: "agent_only" },
      ],
    });
    const blocks = toBlocks(d);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ start: 9, end: 10.5, kind: "work" });
    expect(blocks[1]).toMatchObject({ start: 22, end: 23, kind: "agent" });
    // real epoch preserved for the DST-safe tooltip
    expect(blocks[0].startEpoch).toBe(DAY0 + 9 * HOUR);
  });

  it("clamps out-of-day fractions to [0,24]", () => {
    const d = day({
      day: DAY0,
      windows: [{ start: DAY0 - HOUR, end: DAY0 + 25 * HOUR, class: "work" }],
    });
    const [b] = toBlocks(d);
    expect(b.start).toBe(0);
    expect(b.end).toBe(24);
  });
});

describe("toTimelineDay", () => {
  it("draws the now-line only on today's row", () => {
    const today = day({ day: DAY0, activeMs: HOUR });
    const noon = DAY0 + 12 * HOUR;
    const asToday = toTimelineDay(today, t, noon);
    expect(asToday.isToday).toBe(true);
    expect(asToday.nowFraction).toBeCloseTo(0.5, 5);

    const past = day({ day: DAY0 - DAY_MS, activeMs: HOUR });
    const asPast = toTimelineDay(past, t, noon);
    expect(asPast.isToday).toBe(false);
    expect(asPast.nowFraction).toBeUndefined();
  });

  it("labels an empty day and totals it as —", () => {
    const empty = day({ day: DAY0 });
    const d = toTimelineDay(empty, t, DAY0 + 12 * HOUR);
    expect(d.isEmpty).toBe(true);
    expect(d.totalLabel).toBe("—");
  });
});

describe("buildRows (empty-run collapsing)", () => {
  it("collapses a run of >= EMPTY_RUN_COLLAPSE empty days in place", () => {
    const perDay: IPerDay[] = [
      day({ day: DAY0, activeMs: HOUR }),
      ...Array.from({ length: EMPTY_RUN_COLLAPSE }, (_, i) =>
        day({ day: DAY0 + (i + 1) * DAY_MS }),
      ),
      day({ day: DAY0 + (EMPTY_RUN_COLLAPSE + 1) * DAY_MS, activeMs: HOUR }),
    ];
    const rows = buildRows(perDay, t, 0);
    expect(rows.map((r) => r.type)).toEqual(["day", "gap", "day"]);
    const gap = rows[1];
    expect(gap.type === "gap" && gap.count).toBe(EMPTY_RUN_COLLAPSE);
  });

  it("keeps a short empty run as individual dimmed day rows", () => {
    const perDay: IPerDay[] = [
      day({ day: DAY0, activeMs: HOUR }),
      day({ day: DAY0 + DAY_MS }),
      day({ day: DAY0 + 2 * DAY_MS, activeMs: HOUR }),
    ];
    const rows = buildRows(perDay, t, 0);
    expect(rows.map((r) => r.type)).toEqual(["day", "day", "day"]);
  });
});

describe("summaryLabels", () => {
  it("derives totalLabel/agentLabel from ms via the shared formatter", () => {
    const { total, agent } = summaryLabels(
      payload({ workMs: 4 * HOUR + 27 * MIN, agentOnlyMs: 80 * MIN }),
      t,
    );
    expect(total).toBe("≈ 4h 25m");
    expect(agent).toBe("≈ 1h 20m");
  });

  it("agent-only page: agent estimate fills the main slot, no secondary line", () => {
    const { total, agent } = summaryLabels(
      payload({ workMs: 0, agentOnlyMs: 80 * MIN }),
      t,
    );
    expect(total).toBe("agent: ≈ 1h 20m");
    expect(agent).toBeUndefined();
  });

  it("human-only page: no agent line", () => {
    const { agent } = summaryLabels(payload({ workMs: HOUR, agentOnlyMs: 0 }), t);
    expect(agent).toBeUndefined();
  });
});

describe("formatBlockTooltip", () => {
  it("formats start–end from the real epoch in the data tz + duration", () => {
    const d = day({
      day: DAY0,
      windows: [{ start: DAY0 + 9 * HOUR, end: DAY0 + 10 * HOUR + 30 * MIN, class: "work" }],
    });
    const [b] = toBlocks(d);
    const label = formatBlockTooltip(b, "UTC", "en-US", t);
    expect(label).toBe("09:00 – 10:30 · 1h 30m");
  });
});
