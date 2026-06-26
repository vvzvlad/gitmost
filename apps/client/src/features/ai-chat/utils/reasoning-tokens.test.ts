import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { reasoningTokensForPart } from "@/features/ai-chat/utils/reasoning-tokens.ts";

/**
 * Pure-helper tests for `reasoningTokensForPart`, the #151 anti-double-count
 * rule: the authoritative `usage.reasoningTokens` is the TURN TOTAL, so it may
 * only be attributed when the turn has exactly one reasoning part. With multiple
 * reasoning parts (or no authoritative usage) every part falls back to its own
 * per-part estimate, signalled here by `undefined`.
 */
const msg = (
  parts: UIMessage["parts"],
  metadata?: unknown,
): UIMessage =>
  ({
    id: Math.random().toString(),
    role: "assistant",
    parts,
    metadata,
  }) as UIMessage;

describe("reasoningTokensForPart", () => {
  it("single reasoning part -> the authoritative turn total", () => {
    const m = msg(
      [
        { type: "reasoning", text: "thinking…" } as never,
        { type: "text", text: "answer" },
      ],
      { usage: { reasoningTokens: 42 } },
    );
    expect(reasoningTokensForPart(m)).toBe(42);
  });

  it("multiple reasoning parts -> undefined (each estimates on its own)", () => {
    const m = msg(
      [
        { type: "reasoning", text: "step one" } as never,
        { type: "reasoning", text: "step two" } as never,
        { type: "text", text: "answer" },
      ],
      { usage: { reasoningTokens: 99 } },
    );
    // Even with an authoritative total, two reasoning parts must each estimate
    // (attributing the total to one would double-count against the other).
    expect(reasoningTokensForPart(m)).toBeUndefined();
  });

  it("no authoritative usage -> undefined even for a single reasoning part", () => {
    const m = msg([
      { type: "reasoning", text: "thinking…" } as never,
      { type: "text", text: "answer" },
    ]);
    expect(reasoningTokensForPart(m)).toBeUndefined();
  });
});
