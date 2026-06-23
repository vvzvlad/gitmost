import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { typingIndicatorShowsName } from "@/features/ai-chat/components/message-list.tsx";

/**
 * Pure-helper tests for whether the standalone "Thinking…" indicator renders its
 * own dimmed assistant-name label. It should only show the name while it stands
 * in for a not-yet-started assistant row; once an assistant row exists at the
 * tail, that row's MessageItem already shows the same name, so the indicator
 * must show only the dots to avoid a duplicate stacked label.
 */
const msg = (
  role: "user" | "assistant",
  parts: UIMessage["parts"],
): UIMessage => ({ id: Math.random().toString(), role, parts }) as UIMessage;

describe("typingIndicatorShowsName", () => {
  it("shows the name with no messages yet (standalone, just submitted)", () => {
    expect(typingIndicatorShowsName([])).toBe(true);
  });

  it("shows the name when the last message is still the user's", () => {
    expect(
      typingIndicatorShowsName([msg("user", [{ type: "text", text: "q" }])]),
    ).toBe(true);
  });

  it("hides the name when an assistant row exists at the tail", () => {
    expect(
      typingIndicatorShowsName([msg("assistant", [{ type: "text", text: "" }])]),
    ).toBe(false);
  });

  it("hides the name when the assistant row's last part is a tool", () => {
    const doneTool = { type: "tool-getPage", state: "output-available" } as unknown as UIMessage["parts"][number];
    expect(
      typingIndicatorShowsName([msg("assistant", [doneTool])]),
    ).toBe(false);
  });
});
