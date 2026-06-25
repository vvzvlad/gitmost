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

describe("liveTurnTokens — combined authoritative + estimate (#163)", () => {
  it("ticks the in-flight step above the completed-steps authoritative base", () => {
    // The authoritative usage is the sum over COMPLETED steps (step 1). The
    // CURRENT step is streaming and its text is NOT in `usage` yet, but it IS in
    // the parts -> the running estimate must push the live figure above the base
    // so the badge keeps growing between step boundaries.
    const longText = "x".repeat(800); // 800 chars -> 200 est output tokens
    const r = liveTurnTokens(
      msg([{ type: "text", text: longText }], {
        usage: { inputTokens: 500, outputTokens: 40 }, // step-1 base: 40 output
      }),
    );
    // max(authOutput=40, estOutput=200) = 200 -> the counter ticks, not frozen.
    expect(r.output).toBe(200);
    expect(r.authoritative).toBe(true);
  });

  it("ticks reasoning of the in-flight step above the authoritative reasoning base", () => {
    const longReasoning = "r".repeat(400); // 400 chars -> 100 est reasoning
    const r = liveTurnTokens(
      msg([{ type: "reasoning", text: longReasoning }], {
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 20 },
      }),
    );
    // reasoning: max(20, 100) = 100 ; output: max(max(0,20-20)=0, 0) = 0.
    expect(r.reasoning).toBe(100);
    expect(r.output).toBe(0);
    expect(r.authoritative).toBe(true);
  });

  it("snaps to the authoritative figure once it exceeds the rough estimate", () => {
    // Short on-screen text (estimate tiny) but a large authoritative output:
    // the exact figure wins at the boundary (the counter never under-reports).
    const r = liveTurnTokens(
      msg([{ type: "text", text: "abcd" }], {
        usage: { inputTokens: 10, outputTokens: 5000 },
      }),
    );
    expect(r.output).toBe(5000);
  });

  it("is monotonic: max never drops below the authoritative base when the estimate is smaller", () => {
    // Mirrors the legacy 'verbatim' tests: estimate < authoritative -> unchanged.
    const r = liveTurnTokens(
      msg([{ type: "text", text: "tiny" }], {
        usage: { inputTokens: 500, outputTokens: 100, reasoningTokens: 30 },
      }),
    );
    expect(r).toEqual({ reasoning: 30, output: 70, authoritative: true });
  });
});
