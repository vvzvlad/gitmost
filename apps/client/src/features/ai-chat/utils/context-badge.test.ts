import { describe, expect, it } from "vitest";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";
import { selectContextBadge } from "@/features/ai-chat/utils/context-badge.ts";

/**
 * Pure-helper tests for the header context badge selection. Covers the two
 * non-obvious rules: numerator and denominator are each taken from the most
 * recent row carrying THAT value (they may live on different rows), and a fresh
 * row with a zero/absent value must NOT shadow an older positive one.
 */
const row = (metadata: IAiChatMessageRow["metadata"]): IAiChatMessageRow => ({
  id: Math.random().toString(),
  role: "assistant",
  content: null,
  metadata,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("selectContextBadge", () => {
  it("returns zeros for empty / nullish input", () => {
    expect(selectContextBadge(undefined)).toEqual({
      contextTokens: 0,
      maxContextTokens: 0,
    });
    expect(selectContextBadge(null)).toEqual({
      contextTokens: 0,
      maxContextTokens: 0,
    });
    expect(selectContextBadge([])).toEqual({
      contextTokens: 0,
      maxContextTokens: 0,
    });
  });

  it("reads both figures from the most recent row that carries them", () => {
    expect(
      selectContextBadge([
        row({ contextTokens: 100, maxContextTokens: 200000 }),
        row({ contextTokens: 1500, maxContextTokens: 200000 }),
      ]),
    ).toEqual({ contextTokens: 1500, maxContextTokens: 200000 });
  });

  it("falls back to legacy usage total for older rows without contextTokens", () => {
    expect(
      selectContextBadge([
        row({ usage: { inputTokens: 30, outputTokens: 70 } }),
      ]),
    ).toEqual({ contextTokens: 100, maxContextTokens: 0 });

    expect(
      selectContextBadge([row({ usage: { totalTokens: 250 } })]),
    ).toEqual({ contextTokens: 250, maxContextTokens: 0 });
  });

  it("takes numerator and denominator from different rows", () => {
    // Freshest row (an error turn) carries contextTokens but no max; the older
    // completed turn carries the max. Each is picked from its own latest row.
    expect(
      selectContextBadge([
        row({ contextTokens: 800, maxContextTokens: 200000 }),
        row({ contextTokens: 1200, error: "402: nope" }),
      ]),
    ).toEqual({ contextTokens: 1200, maxContextTokens: 200000 });
  });

  it("does not let a fresh zero/absent max shadow an older positive max", () => {
    expect(
      selectContextBadge([
        row({ contextTokens: 100, maxContextTokens: 200000 }),
        row({ contextTokens: 1200, maxContextTokens: 0 }),
      ]),
    ).toEqual({ contextTokens: 1200, maxContextTokens: 200000 });
  });

  it("skips rows with null metadata", () => {
    expect(
      selectContextBadge([
        row({ contextTokens: 500, maxContextTokens: 200000 }),
        row(null),
      ]),
    ).toEqual({ contextTokens: 500, maxContextTokens: 200000 });
  });

  it("reports current > max as-is (no clamp)", () => {
    expect(
      selectContextBadge([row({ contextTokens: 250000, maxContextTokens: 200000 })]),
    ).toEqual({ contextTokens: 250000, maxContextTokens: 200000 });
  });
});
