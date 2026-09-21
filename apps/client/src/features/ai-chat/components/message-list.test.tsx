import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { UIMessage } from "@ai-sdk/react";

// Stub react-i18next (MessageList and TypingIndicator read `useTranslation`).
// Mirrors the t-mock pattern used by the other component tests in this folder
// (reasoning-block.test.tsx, message-item-memo.test.tsx).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Spy on `renderChatMarkdown` exactly as message-item-memo.test.tsx does: keep
// every OTHER named export of markdown.ts intact via `importActual`, and override
// only `renderChatMarkdown` with a `vi.fn()` that returns simple HTML. This makes
// assertions synchronous (no async marked + DOMPurify pass) and lets us count
// parses by argument. `vi.hoisted` so the spy exists when the hoisted `vi.mock`
// factory runs.
const { renderChatMarkdownSpy } = vi.hoisted(() => ({
  renderChatMarkdownSpy: vi.fn((text: string) => `<p>${text}</p>`),
}));
vi.mock("@/features/ai-chat/utils/markdown.ts", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/ai-chat/utils/markdown.ts")
  >("@/features/ai-chat/utils/markdown.ts");
  return { ...actual, renderChatMarkdown: renderChatMarkdownSpy };
});

// IMPORTANT: do NOT mock MessageItem and do NOT mock messageSignature — exercising
// the REAL MessageList -> real MessageItem -> real messageSignature wiring is the
// whole point of this file (it closes the parent-side coverage gap left by the
// memo tests, which simulate the parent by hardcoding `signature={...}` in their
// harness). Use the relative import for the component under test, mirroring how
// message-list.tsx itself imports `MessageItem from "./message-item"`.
import MessageList from "./message-list";

// matchMedia / localStorage / sessionStorage (read by MantineProvider and app
// code) are stubbed globally in vitest.setup.ts — do NOT re-stub those here.
//
// MessageList renders Mantine's ScrollArea, which constructs a `ResizeObserver`.
// jsdom does not implement it, so install a minimal no-op stub BEFORE rendering.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

// One assistant message wrapping the given `parts`. Reused across renders in the
// regression test to model how the AI SDK hands back the SAME message object.
// Pass an explicit `id` when a test renders several rows at once.
const msg = (parts: UIMessage["parts"], id = "m1"): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;

describe("MessageList", () => {
  it("wires the real MessageItem and supplies a valid signature end-to-end", () => {
    renderChatMarkdownSpy.mockClear();
    const { queryByText } = render(
      <MantineProvider>
        <MessageList
          messages={[msg([{ type: "text", text: "hello world" }])]}
          isStreaming={false}
        />
      </MantineProvider>,
    );
    // The assistant text renders, which proves MessageList mounted the real
    // MessageItem and handed it a valid `signature` prop (computed from the real
    // `messageSignature`) — the full parent -> child -> markdown path is live.
    expect(queryByText("hello world")).not.toBeNull();
  });

  // REGRESSION (PR #224, the empty-render freeze). The AI SDK streams a turn by
  // MUTATING the same `parts` array IN PLACE and handing back a NEW array each
  // delta that REUSES the same message object. The fix moved the content signature
  // to the PARENT: MessageList must recompute `messageSignature(message)` FRESH on
  // every render and forward it as the immutable `signature` prop, so MessageItem's
  // memo (which compares that prop snapshot) sees it change and re-renders the row.
  //
  // This test exercises the PARENT half that the memo tests only simulate: if
  // MessageList ever cached/memoized the signature keyed on the message object's
  // identity (which stays stable across deltas while its `parts` mutate in place),
  // the snapshot would never change, MessageItem's memo would skip every delta, and
  // the row would freeze at its empty mount — exactly the regression class. That
  // would make this test fail. See message-item.tsx (`signature` prop +
  // `arePropsEqual`) and message-list.tsx (the `signature={messageSignature(...)}`
  // snapshot at render time).
  it("reflects in-place part mutation of a reused message object across renders", () => {
    renderChatMarkdownSpy.mockClear();
    // Reuse ONE message object across renders (as the SDK does). The empty text
    // part means MessageItem renders nothing visible initially.
    const message = msg([{ type: "text", text: "" }]);
    const { rerender, queryByText } = render(
      <MantineProvider>
        <MessageList messages={[message]} isStreaming />
      </MantineProvider>,
    );
    // Nothing streamed yet.
    expect(queryByText("streamed answer")).toBeNull();

    // SDK delta: mutate the SAME part in place on the SAME message object...
    (message.parts[0] as { text: string }).text = "streamed answer";
    // ...then re-render with a NEW array literal that still holds the SAME mutated
    // message object (this mirrors useChat handing back a fresh array of reused
    // message objects on each delta).
    rerender(
      <MantineProvider>
        <MessageList messages={[message]} isStreaming />
      </MantineProvider>,
    );

    // The grown text now renders: MessageList re-snapshotted the signature, so the
    // row re-rendered instead of freezing at its empty mount.
    expect(queryByText("streamed answer")).not.toBeNull();
    expect(
      renderChatMarkdownSpy.mock.calls.some((c) => c[0] === "streamed answer"),
    ).toBe(true);
  });

  // REGRESSION (stranded reasoning part): the AI SDK sets a reasoning part's
  // state to "done" ONLY on the `reasoning-end` chunk — `finish-step`/`finish`
  // do NOT finalize it. A manual Stop during the thinking phase (or a provider
  // that never emits `reasoning-end`) therefore leaves the part at
  // `state:"streaming"` forever. MessageItem must derive ReasoningBlock's
  // `streaming` from part state AND turn liveness (MessageList's `isStreaming`,
  // forwarded as `turnStreaming`): while the turn streams the expanded block
  // shows chunked plain text (no parse); once the turn ends — even though the
  // part is still `state:"streaming"` — the block finalizes and does its
  // one-time markdown parse. Note the message signature does NOT change across
  // that flip, so this also exercises the `turnStreaming` memo comparison in
  // arePropsEqual (without it the row would never re-render).
  it("finalizes a reasoning part stranded at state:'streaming' when the turn ends", () => {
    renderChatMarkdownSpy.mockClear();
    const reasoningText = "**bold** thinking";
    // Reasoning part stranded mid-stream + a non-empty answer part (a
    // reasoning-only message renders nothing — see message-content.ts).
    const message = msg([
      { type: "reasoning", text: reasoningText, state: "streaming" },
      { type: "text", text: "partial answer" },
    ]);
    const parsesOfReasoning = () =>
      renderChatMarkdownSpy.mock.calls.filter((c) => c[0] === reasoningText)
        .length;

    const { rerender, getByRole, queryByText } = render(
      <MantineProvider>
        <MessageList messages={[message]} isStreaming />
      </MantineProvider>,
    );
    // Expand the reasoning block (its toggle is the only button in the list).
    fireEvent.click(getByRole("button"));
    // Turn live + part streaming -> ReasoningBlock received streaming=true:
    // the body is chunked plain text (raw markdown syntax), NOT parsed.
    expect(queryByText(/bold/)).not.toBeNull();
    expect(parsesOfReasoning()).toBe(0);

    // The turn ends WITHOUT `reasoning-end`: the part object is untouched
    // (still state:"streaming"), only the turn-level flag flips.
    rerender(
      <MantineProvider>
        <MessageList messages={[message]} isStreaming={false} />
      </MantineProvider>,
    );
    // ReasoningBlock now received streaming=false and did its one-time parse.
    expect(parsesOfReasoning()).toBe(1);
  });

  // REGRESSION (turn-global liveness leaking into earlier rows): `isStreaming`
  // is turn-global, so forwarding it to EVERY row would re-mark a reasoning
  // part stranded at `state:"streaming"` in a PREVIOUS message (see the test
  // above) as live again whenever a LATER turn streams — an expanded stranded
  // block would flip markdown -> raw plain text -> markdown across turn
  // boundaries, re-parsing each time. MessageList must gate `turnStreaming`
  // to the TAIL row only.
  it("keeps a stranded reasoning part in an earlier message finalized while a later turn streams", () => {
    renderChatMarkdownSpy.mockClear();
    const reasoningText = "**bold** thinking";
    // First (earlier) assistant message: its turn was stopped during the
    // thinking phase, leaving the reasoning part at state:"streaming".
    const first = msg(
      [
        { type: "reasoning", text: reasoningText, state: "streaming" },
        { type: "text", text: "first answer" },
      ],
      "m1",
    );
    // Second assistant message: the LATER turn, currently streaming.
    const second = msg([{ type: "text", text: "second answer" }], "m2");
    const parsesOfReasoning = () =>
      renderChatMarkdownSpy.mock.calls.filter((c) => c[0] === reasoningText)
        .length;

    const { rerender, getByRole, queryByText } = render(
      <MantineProvider>
        <MessageList messages={[first, second]} isStreaming />
      </MantineProvider>,
    );
    // Expand the first row's reasoning block (the only toggle in the list —
    // the second message has no reasoning or tool parts).
    fireEvent.click(getByRole("button"));
    // The turn is live but the first row is NOT the tail: its ReasoningBlock
    // received streaming=false, so the stranded part stays finalized and does
    // its one-time markdown parse instead of dropping to chunked plain text.
    expect(queryByText(/bold/)).not.toBeNull();
    expect(parsesOfReasoning()).toBe(1);

    // A later-turn delta re-renders the list; the earlier block must neither
    // flip back to streaming nor re-parse.
    (second.parts[0] as { text: string }).text = "second answer grows";
    rerender(
      <MantineProvider>
        <MessageList messages={[first, second]} isStreaming />
      </MantineProvider>,
    );
    expect(parsesOfReasoning()).toBe(1);
  });
});
