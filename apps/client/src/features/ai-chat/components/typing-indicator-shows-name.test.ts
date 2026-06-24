import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { typingIndicatorShowsName } from "@/features/ai-chat/components/message-list.tsx";

/**
 * Pure-helper tests for whether the standalone "Thinking…" indicator renders its
 * own dimmed assistant-name label. The indicator OWNS the name while the tail
 * assistant row has no visible content yet (an empty streaming text part, or
 * reasoning/step-start while the model is still thinking) — in that gap the
 * assistant MessageItem renders nothing, so the indicator stands in for the
 * nascent bubble (name + dots). It hides the name only once the tail assistant
 * row shows visible content, because then MessageItem draws the same name — this
 * avoids a duplicate stacked label and the layout jump that switching owners
 * mid-stream used to cause.
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

  it("shows the name when the tail assistant row has no visible content yet (empty text part)", () => {
    // The empty streaming text part has no visible content, so MessageItem renders
    // nothing and the indicator owns the name (the nascent bubble).
    expect(
      typingIndicatorShowsName([msg("assistant", [{ type: "text", text: "" }])]),
    ).toBe(true);
  });

  it("hides the name once the tail assistant row shows content (a tool part)", () => {
    const doneTool = { type: "tool-getPage", state: "output-available" } as unknown as UIMessage["parts"][number];
    expect(
      typingIndicatorShowsName([msg("assistant", [doneTool])]),
    ).toBe(false);
  });

  it("hides the name once the tail assistant row shows content (non-empty text)", () => {
    expect(
      typingIndicatorShowsName([msg("assistant", [{ type: "text", text: "answer" }])]),
    ).toBe(false);
  });
});
