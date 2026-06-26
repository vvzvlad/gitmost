import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { UIMessage } from "@ai-sdk/react";

// Stub react-i18next (the component reads `useTranslation`). Mirrors the stub in
// reasoning-block.test.tsx.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Spy on `renderChatMarkdown` so we can count parse calls per text. We keep every
// OTHER named export of markdown.ts intact via `importActual`, and override only
// `renderChatMarkdown` with a `vi.fn()` that returns simple HTML so the component
// still renders. This is the seam that proves the MarkdownPart memo works: a
// finalized text part must NOT be re-parsed on a later streamed delta.
// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory runs.
const { renderChatMarkdownSpy } = vi.hoisted(() => ({
  renderChatMarkdownSpy: vi.fn((text: string) => `<p>${text}</p>`),
}));
vi.mock("@/features/ai-chat/utils/markdown.ts", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/ai-chat/utils/markdown.ts")
  >("@/features/ai-chat/utils/markdown.ts");
  return { ...actual, renderChatMarkdown: renderChatMarkdownSpy };
});

import MessageItem from "./message-item";
import { messageSignature } from "@/features/ai-chat/utils/message-signature.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

const msg = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: "m1", role: "assistant", parts }) as UIMessage;

// Mirror MessageList: snapshot the signature at (parent) render time and pass it
// as the memo key. The signature must NOT be recomputed inside the memo from the
// live (mutable) message — see message-item.tsx.
const renderRow = (message: UIMessage) =>
  render(
    <MantineProvider>
      <MessageItem message={message} signature={messageSignature(message)} />
    </MantineProvider>,
  );

/** Count how many spy calls parsed exactly `text` (filtering by the first arg). */
const callsFor = (text: string) =>
  renderChatMarkdownSpy.mock.calls.filter((c) => c[0] === text).length;

describe("MessageItem markdown memoization", () => {
  it("does not re-parse finalized text parts when only a tail part grows", () => {
    renderChatMarkdownSpy.mockClear();

    // Two finalized text parts.
    const first = msg([
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
    ]);
    const { rerender } = renderRow(first);

    // Both finalized parts parsed exactly once on the initial render.
    expect(callsFor("alpha")).toBe(1);
    expect(callsFor("beta")).toBe(1);

    // A streamed delta: a NEW message object where only a third tail part grows;
    // the first two parts' text is byte-identical.
    const next = msg([
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
      { type: "text", text: "gamm" },
    ]);
    rerender(
      <MantineProvider>
        <MessageItem message={next} signature={messageSignature(next)} />
      </MantineProvider>,
    );

    // The finalized parts hit the MarkdownPart memo: still parsed at most once
    // each across BOTH renders (the resilient invariant). The only new parse is
    // for the changed/added tail part.
    expect(callsFor("alpha")).toBe(1);
    expect(callsFor("beta")).toBe(1);
    expect(callsFor("gamm")).toBe(1);
  });

  // REGRESSION (empty-render bug): the AI SDK streams a turn by MUTATING the same
  // `parts` IN PLACE and reusing the message object. A row that mounted empty
  // (reasoning-first providers render nothing at first) must still stream its text
  // in once the parent hands down a fresh signature snapshot. Before the fix the
  // memo recomputed the signature from the (mutated) message — identical on both
  // sides — and froze the row at its empty render, so the answer never appeared.
  it("streams text in after the row mounted empty and parts mutated in place", () => {
    renderChatMarkdownSpy.mockClear();
    // Reuse ONE message object across renders (as the SDK does).
    const message = msg([{ type: "text", text: "" }]);
    const { rerender, queryByText } = render(
      <MantineProvider>
        <MessageItem message={message} signature={messageSignature(message)} />
      </MantineProvider>,
    );
    // Empty text part: nothing visible rendered yet.
    expect(queryByText("streamed answer")).toBeNull();

    // SDK delta: mutate the SAME part in place, then re-render with a NEW snapshot.
    (message.parts[0] as { text: string }).text = "streamed answer";
    rerender(
      <MantineProvider>
        <MessageItem message={message} signature={messageSignature(message)} />
      </MantineProvider>,
    );

    // The grown text now renders (the memo did NOT freeze the empty mount).
    expect(callsFor("streamed answer")).toBe(1);
    expect(queryByText("streamed answer")).not.toBeNull();
  });
});
