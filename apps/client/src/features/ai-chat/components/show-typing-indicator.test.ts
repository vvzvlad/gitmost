import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { showTypingIndicator } from "@/features/ai-chat/components/message-list.tsx";

/**
 * Pure-helper tests for the typing-indicator bridging logic that the internal
 * chat and the public share widget now share. This is the behavior that decides
 * whether the animated "AI agent is typing…" placeholder shows in the gap
 * between sending and the first streamed token.
 */
const msg = (
  role: "user" | "assistant",
  parts: UIMessage["parts"],
): UIMessage => ({ id: Math.random().toString(), role, parts }) as UIMessage;

describe("showTypingIndicator", () => {
  it("is hidden when not streaming", () => {
    expect(showTypingIndicator([], false)).toBe(false);
    expect(
      showTypingIndicator([msg("assistant", [{ type: "text", text: "hi" }])], false),
    ).toBe(false);
  });

  it("shows while streaming with no messages yet (just submitted)", () => {
    expect(showTypingIndicator([], true)).toBe(true);
  });

  it("shows while streaming when the last message is still the user's", () => {
    expect(
      showTypingIndicator([msg("user", [{ type: "text", text: "q" }])], true),
    ).toBe(true);
  });

  it("shows while streaming when the assistant row has no visible content", () => {
    expect(
      showTypingIndicator([msg("assistant", [{ type: "text", text: "" }])], true),
    ).toBe(true);
    expect(
      showTypingIndicator([msg("assistant", [{ type: "text", text: "   " }])], true),
    ).toBe(true);
  });

  it("hides once the assistant streams non-empty text", () => {
    expect(
      showTypingIndicator([msg("assistant", [{ type: "text", text: "answer" }])], true),
    ).toBe(false);
  });

  it("hides once a tool part appears (even before any text)", () => {
    const toolPart = { type: "tool-searchPages" } as unknown as UIMessage["parts"][number];
    expect(
      showTypingIndicator([msg("assistant", [toolPart])], true),
    ).toBe(false);
  });
});
