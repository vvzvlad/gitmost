import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { assistantMessageHasVisibleContent } from "@/features/ai-chat/utils/message-content.ts";

/**
 * Pure-helper tests for `assistantMessageHasVisibleContent`, the single source of
 * truth shared by MessageItem (whether to render the bubble) and
 * typingIndicatorShowsName (whether the standalone indicator owns the name). It
 * must mirror MessageItem's render decisions exactly so exactly one element owns
 * the agent name during the pre-content "thinking" gap.
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

describe("assistantMessageHasVisibleContent", () => {
  it("is false for an empty text part", () => {
    expect(assistantMessageHasVisibleContent(msg([{ type: "text", text: "" }]))).toBe(false);
  });

  it("is false for a whitespace-only text part", () => {
    expect(assistantMessageHasVisibleContent(msg([{ type: "text", text: "   " }]))).toBe(false);
  });

  it("is true for a non-empty text part", () => {
    expect(assistantMessageHasVisibleContent(msg([{ type: "text", text: "answer" }]))).toBe(true);
  });

  it("is true for a tool part", () => {
    const toolPart = { type: "tool-getPage", state: "output-available" } as unknown as UIMessage["parts"][number];
    expect(assistantMessageHasVisibleContent(msg([toolPart]))).toBe(true);
  });

  it("is true when metadata.error is set (persisted error banner)", () => {
    expect(
      assistantMessageHasVisibleContent(msg([{ type: "text", text: "" }], { error: "boom" })),
    ).toBe(true);
  });

  it("is true when metadata.finishReason is 'aborted' (persisted stopped notice)", () => {
    expect(
      assistantMessageHasVisibleContent(msg([], { finishReason: "aborted" })),
    ).toBe(true);
  });

  it("is false for a message with no parts and no metadata", () => {
    expect(assistantMessageHasVisibleContent(msg([]))).toBe(false);
  });

  it("is false for an unsupported part kind (reasoning)", () => {
    const reasoning = { type: "reasoning", text: "let me think" } as unknown as UIMessage["parts"][number];
    expect(assistantMessageHasVisibleContent(msg([reasoning]))).toBe(false);
  });

  it("is true for a running tool part (input-available)", () => {
    // Tool visibility does not depend on tool state: MessageItem renders a
    // ToolCallCard for any tool part, so a still-running tool is visible.
    const runningTool = { type: "tool-getPage", state: "input-available" } as unknown as UIMessage["parts"][number];
    expect(assistantMessageHasVisibleContent(msg([runningTool]))).toBe(true);
  });

  it("is true for an empty leading text part followed by a non-empty one", () => {
    // An empty leading text part followed by a non-empty one is still visible
    // (mirrors the real streaming sequence where text arrives incrementally).
    expect(
      assistantMessageHasVisibleContent(
        msg([{ type: "text", text: "" }, { type: "text", text: "answer" }]),
      ),
    ).toBe(true);
  });

  it("is false for an empty completed turn (finishReason 'stop')", () => {
    // A completed turn with no text/tools and a non-aborted finishReason renders
    // nothing — this is intentional (hiding a dangling name-only row), distinct
    // from the `aborted`/`error` cases which DO render.
    expect(
      assistantMessageHasVisibleContent(msg([{ type: "text", text: "" }], { finishReason: "stop" })),
    ).toBe(false);
  });

  it("is false for a parts-less message (the `?? []` guard makes it safe)", () => {
    // The `?? []` guard makes a parts-less object safe instead of throwing.
    expect(
      assistantMessageHasVisibleContent({ id: "x", role: "assistant" } as unknown as UIMessage),
    ).toBe(false);
  });
});
