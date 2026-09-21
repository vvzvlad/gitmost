import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/features/ai-chat/utils/count-stream-tokens.ts";

describe("estimateTokens", () => {
  it("returns 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  // #490: migrated onto the shared @docmost/token-estimate module (chars/2.5, up
  // from the old client-only chars/4) so the client counter and the server replay
  // budgeter can never diverge.
  it("ceils chars/2.5 so any non-empty text is at least 1 token", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // 5 / 2.5 = 2
    expect(estimateTokens("x".repeat(10))).toBe(4); // 10 / 2.5 = 4
  });
});
