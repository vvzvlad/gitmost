import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// Spy on the markdown renderer so we can assert it is NOT called while the block
// is collapsed (the #302 fix) and IS called once on expand. The count/fallback
// tests don't depend on real markdown, so a light stub is safe.
vi.mock("@/features/ai-chat/utils/markdown.ts", () => ({
  renderChatMarkdown: vi.fn((md: string) => `<p>${md}</p>`),
}));

// Stub react-i18next so `t` returns the key with `{{count}}` interpolated. This
// keeps the assertions on the component's OWN count logic (authoritative vs
// estimate) rather than on translation, and mirrors the t-mock pattern used by
// other component tests in the repo.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts && typeof opts.count === "number"
        ? key.replace("{{count}}", String(opts.count))
        : key,
  }),
}));

import ReasoningBlock from "./reasoning-block";
import { estimateTokens } from "@/features/ai-chat/utils/count-stream-tokens.ts";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

function renderBlock(props: {
  text: string;
  tokens?: number;
  streaming?: boolean;
}) {
  return render(
    <MantineProvider>
      <ReasoningBlock {...props} />
    </MantineProvider>,
  );
}

describe("ReasoningBlock", () => {
  it("shows the authoritative count in the header when tokens > 0", () => {
    // Text "thinking…" estimates to ceil(9/4) = 3, but the authoritative 42
    // must win, so the header shows 42 (and NOT the 3-token estimate).
    renderBlock({ text: "thinking…", tokens: 42 });
    expect(screen.getByText("Thinking · 42 tokens")).toBeDefined();
    expect(screen.queryByText("Thinking · 3 tokens")).toBeNull();
  });

  it("falls back to the text-length estimate when no authoritative tokens", () => {
    const text = "some reasoning prose that streams in";
    const estimate = estimateTokens(text);
    renderBlock({ text });
    expect(estimate).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${estimate} tokens`))).toBeDefined();
  });

  it("header-only when text is empty but an authoritative count is present", () => {
    renderBlock({ text: "", tokens: 17 });
    expect(screen.getByText(/17 tokens/)).toBeDefined();
    // No disclosure body to expand: the toggle button is disabled.
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the reasoning body (markdown or raw-text fallback)", () => {
    renderBlock({ text: "**bold** reasoning", tokens: 5 });
    // The toggle is enabled because there IS body text to expand.
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // The body prose renders (markdown -> sanitized html, or raw-text fallback);
    // either way the text is present in the document.
    expect(screen.getByText(/reasoning/)).toBeDefined();
  });

  it("does not parse the reasoning markdown while collapsed; parses on expand (#302)", () => {
    const renderSpy = vi.mocked(renderChatMarkdown);
    renderSpy.mockClear();
    renderBlock({ text: "**bold** reasoning", tokens: 5 });
    // Collapsed is the default. The expensive markdown parse (marked + DOMPurify)
    // must NOT run for the hidden body — that O(n^2) re-parse on every streamed
    // delta is exactly what froze the chat (#302). The collapsed body shows the
    // cheap raw-text fallback instead.
    expect(renderSpy).not.toHaveBeenCalled();
    // Expanding parses the current text exactly once (a user-initiated click).
    fireEvent.click(screen.getByRole("button"));
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it("does not parse while expanded and STREAMING; shows chunked plain text", () => {
    const renderSpy = vi.mocked(renderChatMarkdown);
    renderSpy.mockClear();
    renderBlock({
      text: "первый абзац размышлений\n\nвторой абзац растёт",
      tokens: 5,
      streaming: true,
    });
    fireEvent.click(screen.getByRole("button"));
    // Expanded + still streaming: NO markdown parse and NO innerHTML swaps per
    // delta — the body is chunked plain text (only the tail chunk updates).
    // This is the O(n²) hole #302 left open (Safari whole-tab freeze).
    expect(renderSpy).not.toHaveBeenCalled();
    // Both paragraph chunks' raw text is present in the body.
    expect(screen.getByText(/первый абзац размышлений/)).toBeDefined();
    expect(screen.getByText(/второй абзац растёт/)).toBeDefined();
  });

  it("parses exactly once when streaming flips to done while expanded", () => {
    const renderSpy = vi.mocked(renderChatMarkdown);
    renderSpy.mockClear();
    const { rerender } = renderBlock({
      text: "**bold** reasoning",
      tokens: 5,
      streaming: true,
    });
    fireEvent.click(screen.getByRole("button"));
    expect(renderSpy).not.toHaveBeenCalled();

    // Finalization: the part's state flips streaming→done, the parent
    // re-renders the row (the flip changes the message signature), and the
    // block does its ONE markdown parse of the now-stable text.
    rerender(
      <MantineProvider>
        <ReasoningBlock text="**bold** reasoning" tokens={5} streaming={false} />
      </MantineProvider>,
    );
    expect(renderSpy).toHaveBeenCalledTimes(1);
    // The parsed html branch rendered (the mock wraps the input in <p>…</p>).
    expect(screen.getByText(/reasoning/)).toBeDefined();

    // Further re-renders with unchanged props do not re-parse.
    rerender(
      <MantineProvider>
        <ReasoningBlock text="**bold** reasoning" tokens={5} streaming={false} />
      </MantineProvider>,
    );
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});
