import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

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

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

function renderBlock(props: { text: string; tokens?: number }) {
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
});
