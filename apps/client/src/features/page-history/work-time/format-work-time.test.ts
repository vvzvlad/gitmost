import { describe, it, expect } from "vitest";
import {
  formatHeadline,
  formatDayTotal,
  formatGapMinutes,
} from "./format-work-time";

const MIN = 60 * 1000;
// Fake translator: renders the key with {{tokens}} substituted, so the tests
// assert the rounding + branch selection without depending on the i18n catalogue.
const t = (key: string, opts?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ""));

describe("formatHeadline", () => {
  it("prefixes ≈ and rounds to a 5-minute step", () => {
    expect(formatHeadline(4 * 60 * MIN + 27 * MIN, t)).toBe("≈ 4h 25m");
    expect(formatHeadline(90 * MIN, t)).toBe("≈ 1h 30m");
  });

  it("shows hours only / minutes only cleanly", () => {
    expect(formatHeadline(120 * MIN, t)).toBe("≈ 2h");
    expect(formatHeadline(35 * MIN, t)).toBe("≈ 35m");
  });

  it("floors a tiny non-zero estimate to 5m, never 0", () => {
    expect(formatHeadline(2 * MIN, t)).toBe("≈ 5m");
  });

  it("empty string for zero (widget hidden)", () => {
    expect(formatHeadline(0, t)).toBe("");
  });
});

describe("formatDayTotal", () => {
  it('renders "h m" and shows — for empty days', () => {
    expect(formatDayTotal(3 * 60 * MIN + 17 * MIN, t)).toBe("3h 17m");
    expect(formatDayTotal(0, t)).toBe("—");
  });
});

describe("formatGapMinutes", () => {
  it("converts the tGap ms threshold to whole minutes", () => {
    expect(formatGapMinutes(15 * MIN)).toBe(15);
  });
});
