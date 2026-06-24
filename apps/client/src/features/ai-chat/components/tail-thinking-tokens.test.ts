import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { tailThinkingTokens } from "@/features/ai-chat/components/message-list.tsx";

/**
 * Pure-helper tests for `tailThinkingTokens`: the live thinking-token count the
 * standalone typing indicator shows. It is the reasoning split of the tail
 * assistant message (estimate while streaming, authoritative once usage arrives).
 */
const msg = (
  role: "user" | "assistant",
  parts: unknown[],
  metadata?: unknown,
): UIMessage =>
  ({ id: Math.random().toString(), role, parts, metadata }) as UIMessage;

describe("tailThinkingTokens", () => {
  it("is 0 when there are no messages", () => {
    expect(tailThinkingTokens([])).toBe(0);
  });

  it("is 0 when the tail message is the user's", () => {
    expect(tailThinkingTokens([msg("user", [{ type: "text", text: "q" }])])).toBe(0);
  });

  it("is 0 when the assistant has produced no reasoning yet", () => {
    expect(
      tailThinkingTokens([msg("assistant", [{ type: "text", text: "answer" }])]),
    ).toBe(0);
  });

  it("estimates reasoning tokens from streamed reasoning text", () => {
    // 8 chars -> 2 tokens.
    expect(
      tailThinkingTokens([
        msg("assistant", [{ type: "reasoning", text: "12345678" }]),
      ]),
    ).toBe(2);
  });

  it("uses authoritative usage.reasoningTokens once the server attaches it", () => {
    expect(
      tailThinkingTokens([
        msg("assistant", [{ type: "reasoning", text: "x" }], {
          usage: { outputTokens: 100, reasoningTokens: 42 },
        }),
      ]),
    ).toBe(42);
  });
});
