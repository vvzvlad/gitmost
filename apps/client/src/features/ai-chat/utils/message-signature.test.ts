import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { messageSignature } from "@/features/ai-chat/utils/message-signature.ts";

/**
 * Pure-helper tests for `messageSignature`, the cheap per-message content
 * signature that drives MessageItem's memo (a streaming row's signature must
 * change on every delta so it re-renders, while a finalized row's stays stable
 * so it is skipped). Each test exercises ONE change signal and asserts it flips
 * the signature; a content-identical clone must keep an EQUAL signature.
 *
 * The signature embeds `message.id` and `message.role`, so the `msg` factory
 * uses a FIXED id/role here (not `Math.random()`): otherwise two messages with
 * identical content would get different signatures and the negative case would
 * be impossible to express.
 */
const msg = (
  parts: UIMessage["parts"],
  metadata?: unknown,
): UIMessage =>
  ({
    id: "m1",
    role: "assistant",
    parts,
    metadata,
  }) as UIMessage;

describe("messageSignature", () => {
  it("changes when a text part grows", () => {
    const before = msg([{ type: "text", text: "alpha" }]);
    const after = msg([{ type: "text", text: "alpha beta" }]);
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("changes when a new part is appended", () => {
    const before = msg([{ type: "text", text: "alpha" }]);
    const after = msg([
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
    ]);
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("changes when a part's state flips", () => {
    const before = msg([
      { type: "tool-getPage", state: "input-streaming" } as never,
    ]);
    const after = msg([
      { type: "tool-getPage", state: "output-available" } as never,
    ]);
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("changes when a tool part gains an output", () => {
    const before = msg([
      { type: "tool-getPage", state: "output-available" } as never,
    ]);
    const after = msg([
      {
        type: "tool-getPage",
        state: "output-available",
        output: { ok: true },
      } as never,
    ]);
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("changes when a part gains an errorText", () => {
    const before = msg([
      { type: "tool-getPage", state: "output-error" } as never,
    ]);
    const after = msg([
      {
        type: "tool-getPage",
        state: "output-error",
        errorText: "boom",
      } as never,
    ]);
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("changes when usage.reasoningTokens arrives on finish-step (text/state already frozen)", () => {
    // The specifically-commented edge case: the authoritative turn total lands on
    // the final finish-step AFTER the reasoning text length and state are frozen.
    // Only the token count appears between these two snapshots, so the signature
    // MUST still flip — otherwise the "Thinking · N tokens" header would never
    // snap from the live estimate to the exact figure.
    const before = msg([
      { type: "reasoning", text: "thinking", state: "done" } as never,
    ]);
    const after = msg(
      [{ type: "reasoning", text: "thinking", state: "done" } as never],
      { usage: { reasoningTokens: 42 } },
    );
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("changes when metadata.error appears", () => {
    const before = msg([{ type: "text", text: "answer" }]);
    const after = msg([{ type: "text", text: "answer" }], { error: "boom" });
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("changes when metadata.finishReason changes (e.g. to 'aborted')", () => {
    const before = msg([{ type: "text", text: "answer" }], {
      finishReason: "stop",
    });
    const after = msg([{ type: "text", text: "answer" }], {
      finishReason: "aborted",
    });
    expect(messageSignature(before)).not.toBe(messageSignature(after));
  });

  it("is UNCHANGED for a content-identical clone (different object, same values)", () => {
    // A finalized row that is re-created as a fresh object (different parts array
    // by reference, same parts by value) must keep an EQUAL signature, so the
    // memo skips re-rendering it.
    const a = msg([
      { type: "text", text: "alpha" },
      { type: "tool-getPage", state: "output-available", output: { ok: true } } as never,
    ]);
    const b = msg([
      { type: "text", text: "alpha" },
      { type: "tool-getPage", state: "output-available", output: { ok: true } } as never,
    ]);
    expect(a).not.toBe(b);
    expect(messageSignature(a)).toBe(messageSignature(b));
  });
});
