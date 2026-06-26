import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/features/ai-chat/utils/count-stream-tokens.ts";

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
