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

/**
 * Per-part-kind coupling guard for the load-bearing invariant documented at the
 * top of message-signature.ts: the signature MUST sample every VISIBLE field the
 * MessageItem render body draws, or the memo freezes a stale row. This is an
 * executable lock for the part kinds rendered TODAY — read alongside
 * `MessageItem` (message-item.tsx) and the `assistantMessageHasVisibleContent`
 * helper (message-content.ts), which "mirrors MessageItem's render decisions
 * EXACTLY". For each kind, mutating a field the render body DRAWS must flip the
 * signature. If a new visible field is rendered without being added here AND to
 * the signature, the corresponding assertion below should fail — that is the
 * guard. (This intentionally stops short of the render-descriptor refactor:
 * adding a part kind or a visible field still requires a human to extend both
 * the signature and this block.)
 */
describe("messageSignature ↔ render coupling (per visible part kind)", () => {
  describe("text part — render draws part.text (MarkdownPart text={part.text})", () => {
    it("flips when the visible text changes", () => {
      // Streaming is append-only, so the visible text only grows; the signature
      // samples its length, so the growth is the change signal.
      const before = msg([{ type: "text", text: "answer" }]);
      const after = msg([{ type: "text", text: "answer extended" }]);
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });
  });

  describe("reasoning part — render draws text + tokens (ReasoningBlock)", () => {
    it("flips when the visible reasoning text changes", () => {
      const before = msg([
        { type: "reasoning", text: "think", state: "streaming" } as never,
      ]);
      const after = msg([
        { type: "reasoning", text: "think harder", state: "streaming" } as never,
      ]);
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });

    it("flips when the visible token count (metadata.usage.reasoningTokens) lands", () => {
      // The header's "Thinking · N tokens" reads reasoningTokensForPart, fed by
      // metadata.usage.reasoningTokens — a VISIBLE field that arrives on the final
      // finish-step after text length and state are frozen.
      const before = msg([
        { type: "reasoning", text: "think", state: "done" } as never,
      ]);
      const after = msg(
        [{ type: "reasoning", text: "think", state: "done" } as never],
        { usage: { reasoningTokens: 99 } },
      );
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });
  });

  describe("tool-* part — render draws state/errorText/citations (ToolCallCard)", () => {
    it("flips when the run state changes (running ↔ done icon + label)", () => {
      // toolRunState(part.state) selects the spinner/check/error icon.
      const before = msg([
        { type: "tool-getPage", state: "input-available" } as never,
      ]);
      const after = msg([
        { type: "tool-getPage", state: "output-available" } as never,
      ]);
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });

    it("flips when output arrives (drives the rendered citation links)", () => {
      // toolCitations reads part.output to render the "/p/{id}" anchors.
      const before = msg([
        { type: "tool-getPage", state: "output-available" } as never,
      ]);
      const after = msg([
        {
          type: "tool-getPage",
          state: "output-available",
          output: { id: "page-1", title: "Doc" },
        } as never,
      ]);
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });

    it("flips when errorText appears (the visible red error detail line)", () => {
      const before = msg([
        { type: "tool-getPage", state: "output-error" } as never,
      ]);
      const after = msg([
        {
          type: "tool-getPage",
          state: "output-error",
          errorText: "permission denied",
        } as never,
      ]);
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });
  });

  describe("metadata banners — render draws error / aborted notices", () => {
    it("flips when metadata.error appears (ChatErrorAlert banner)", () => {
      const before = msg([{ type: "text", text: "answer" }]);
      const after = msg([{ type: "text", text: "answer" }], { error: "boom" });
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });

    it("flips when metadata.finishReason becomes 'aborted' (ChatStoppedNotice)", () => {
      const before = msg([{ type: "text", text: "answer" }], {
        finishReason: "stop",
      });
      const after = msg([{ type: "text", text: "answer" }], {
        finishReason: "aborted",
      });
      expect(messageSignature(before)).not.toBe(messageSignature(after));
    });
  });
});
