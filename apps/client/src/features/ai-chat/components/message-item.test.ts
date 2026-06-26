import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@ai-sdk/react";

// Stub react-i18next: importing the component module pulls in `useTranslation`,
// and we only exercise the pure `arePropsEqual` comparator (no rendering), so a
// minimal `t` that echoes the key is enough. Mirrors the stub in
// reasoning-block.test.tsx.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { arePropsEqual } from "./message-item";
import { messageSignature } from "@/features/ai-chat/utils/message-signature.ts";

/**
 * Tests for `arePropsEqual`, the `React.memo` comparator for MessageItem. It must
 * return false on any visible prop/content change (so the row re-renders) and
 * true when nothing visible changed (so a finalized row is skipped). The memo key
 * is the `signature` PROP — an immutable snapshot the PARENT (MessageList) takes
 * per render via `messageSignature(message)`. A FIXED message id is used so a
 * content-identical clone yields an equal signature.
 */
const msg = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: "m1", role: "assistant", parts }) as UIMessage;

// Build the props the parent would pass, INCLUDING the snapshot signature it
// computes during its own render (the load-bearing part — see message-item.tsx:
// the signature must never be recomputed inside arePropsEqual).
const props = (
  message: UIMessage,
  over: Record<string, unknown> = {},
) => ({
  message,
  signature: messageSignature(message),
  showCitations: true,
  neutralizeInternalLinks: false,
  assistantName: "AI",
  ...over,
});

describe("arePropsEqual", () => {
  it("returns false when showCitations differs", () => {
    const m = msg([{ type: "text", text: "answer" }]);
    expect(
      arePropsEqual(props(m), props(m, { showCitations: false })),
    ).toBe(false);
  });

  it("returns false when neutralizeInternalLinks differs", () => {
    const m = msg([{ type: "text", text: "answer" }]);
    expect(
      arePropsEqual(props(m), props(m, { neutralizeInternalLinks: true })),
    ).toBe(false);
  });

  it("returns false when assistantName differs", () => {
    const m = msg([{ type: "text", text: "answer" }]);
    expect(
      arePropsEqual(props(m), props(m, { assistantName: "Other" })),
    ).toBe(false);
  });

  it("returns true for equal snapshot + equal props (finalized row skipped)", () => {
    const m = msg([{ type: "text", text: "answer" }]);
    expect(arePropsEqual(props(m), props(m))).toBe(true);
  });

  it("returns true for the same content in a different message object", () => {
    const a = msg([{ type: "text", text: "answer" }]);
    const b = msg([{ type: "text", text: "answer" }]);
    expect(a).not.toBe(b);
    expect(arePropsEqual(props(a), props(b))).toBe(true);
  });

  it("returns false when content changed in a different message object", () => {
    const a = msg([{ type: "text", text: "answer" }]);
    const b = msg([{ type: "text", text: "answer grown" }]);
    expect(arePropsEqual(props(a), props(b))).toBe(false);
  });

  // REGRESSION (empty-render bug): the AI SDK streams deltas by mutating the SAME
  // `parts` in place and handing back a message wrapper that SHARES them. So the
  // PREVIOUS and NEXT props can carry the SAME (mutated) message object, and
  // recomputing `messageSignature(message)` inside the comparator would read
  // identical (latest) content on BOTH sides → always "equal" → the memo skips
  // every streamed update and the assistant row freezes at its initial empty
  // render. The comparator MUST instead trust the immutable `signature` SNAPSHOT
  // the parent captured at each render. This fails against the old implementation
  // (a `prev.message === next.message` fast path + a signature recomputed from the
  // live objects).
  it("re-renders when parts were mutated in place but the snapshot changed", () => {
    const message = msg([{ type: "text", text: "" }]); // empty (renders null)
    const prevSig = messageSignature(message); // snapshot BEFORE the delta
    // SDK streams a delta by mutating the shared part IN PLACE:
    (message.parts[0] as { text: string }).text = "hello world";
    const nextSig = messageSignature(message); // snapshot AFTER the delta
    expect(prevSig).not.toBe(nextSig);
    // Same object reference on both sides (the SDK reuses it), differing snapshots.
    const base = {
      message,
      showCitations: true,
      neutralizeInternalLinks: false,
      assistantName: "AI",
    };
    expect(
      arePropsEqual(
        { ...base, signature: prevSig },
        { ...base, signature: nextSig },
      ),
    ).toBe(false);
  });
});
