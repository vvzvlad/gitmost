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

/**
 * Tests for `arePropsEqual`, the `React.memo` comparator for MessageItem. It must
 * return false on any visible prop/content change (so the row re-renders) and
 * true when nothing visible changed (so a finalized row is skipped). A FIXED
 * message id is used so a content-identical clone yields an equal signature.
 */
const msg = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: "m1", role: "assistant", parts }) as UIMessage;

const props = (
  message: UIMessage,
  over: Record<string, unknown> = {},
) => ({
  message,
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

  it("returns true on the identity fast path (same message object, equal props)", () => {
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
});
