import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import {
  estimateTokens,
  liveTurnTokens,
} from "@/features/ai-chat/utils/count-stream-tokens.ts";

const msg = (parts: unknown[], metadata?: unknown): UIMessage =>
  ({
    id: Math.random().toString(),
    role: "assistant",
    parts,
    metadata,
  }) as UIMessage;

describe("estimateTokens", () => {
  it("returns 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("ceils chars/4 so any non-empty text is at least 1 token", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("12345678")).toBe(2);
  });
});

describe("liveTurnTokens — estimate path", () => {
  it("is all zeros for an undefined message", () => {
    expect(liveTurnTokens(undefined)).toEqual({
      reasoning: 0,
      output: 0,
      authoritative: false,
    });
  });

  it("is all zeros for a parts-less message", () => {
    expect(liveTurnTokens({ id: "x", role: "assistant" } as UIMessage)).toEqual({
      reasoning: 0,
      output: 0,
      authoritative: false,
    });
  });

  it("estimates output from text parts", () => {
    // 8 chars -> 2 tokens.
    const r = liveTurnTokens(msg([{ type: "text", text: "12345678" }]));
    expect(r).toEqual({ reasoning: 0, output: 2, authoritative: false });
  });

  it("estimates reasoning from reasoning parts (kept separate from output)", () => {
    const r = liveTurnTokens(
      msg([
        { type: "reasoning", text: "12345678" },
        { type: "text", text: "abcd" },
      ]),
    );
    expect(r).toEqual({ reasoning: 2, output: 1, authoritative: false });
  });

  it("accumulates across multiple text + reasoning parts (multi-step)", () => {
    const r = liveTurnTokens(
      msg([
        { type: "reasoning", text: "abcd" }, // 1
        { type: "text", text: "abcd" }, // 1
        { type: "tool-getPage", state: "output-available" }, // ignored
        { type: "reasoning", text: "abcd" }, // 1
        { type: "text", text: "abcdefgh" }, // 2
      ]),
    );
    expect(r).toEqual({ reasoning: 2, output: 3, authoritative: false });
  });

  it("ignores non text/reasoning parts (tools, step-start)", () => {
    const r = liveTurnTokens(
      msg([
        { type: "step-start" },
        { type: "tool-getPage", state: "input-available" },
      ]),
    );
    expect(r).toEqual({ reasoning: 0, output: 0, authoritative: false });
  });
});

describe("liveTurnTokens — authoritative path", () => {
  it("returns authoritative usage verbatim, splitting reasoning out of output", () => {
    // outputTokens INCLUDES reasoning in the AI SDK shape -> answer = 100 - 30.
    const r = liveTurnTokens(
      msg([{ type: "text", text: "estimate would be tiny" }], {
        usage: { inputTokens: 500, outputTokens: 100, reasoningTokens: 30 },
      }),
    );
    expect(r).toEqual({ reasoning: 30, output: 70, authoritative: true });
  });

  it("treats missing reasoningTokens as 0 and keeps full output", () => {
    const r = liveTurnTokens(
      msg([{ type: "text", text: "x" }], {
        usage: { inputTokens: 10, outputTokens: 42 },
      }),
    );
    expect(r).toEqual({ reasoning: 0, output: 42, authoritative: true });
  });

  it("never returns a negative output when reasoning exceeds reported output", () => {
    const r = liveTurnTokens(
      msg([], { usage: { outputTokens: 10, reasoningTokens: 40 } }),
    );
    expect(r).toEqual({ reasoning: 40, output: 0, authoritative: true });
  });

  it("falls back to the estimate when metadata has no usage object", () => {
    const r = liveTurnTokens(
      msg([{ type: "text", text: "abcd" }], { chatId: "c1" }),
    );
    expect(r).toEqual({ reasoning: 0, output: 1, authoritative: false });
  });
});
