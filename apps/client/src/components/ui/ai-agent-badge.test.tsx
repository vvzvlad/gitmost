import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { AiAgentBadge } from "./ai-agent-badge";

// MantineProvider reads window.matchMedia (color scheme) on mount, which jsdom
// does not implement. Provide a minimal stub so the provider can render.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

function renderBadge(props: { authorName?: string; aiChatId?: string | null }) {
  return render(
    <MantineProvider>
      <AiAgentBadge {...props} />
    </MantineProvider>,
  );
}

describe("AiAgentBadge", () => {
  it("renders the AI-agent label", () => {
    renderBadge({ authorName: "Bot" });
    expect(screen.getByText("AI-agent")).toBeDefined();
  });

  it("is clickable (accessible button) when aiChatId is present", () => {
    renderBadge({ authorName: "Bot", aiChatId: "chat-1" });
    const badge = screen.getByRole("button");
    expect(badge).toBeDefined();
    expect(badge.textContent).toContain("AI-agent");
    // Clicking does not throw — the deep-link handler runs against the default
    // jotai store. (Asserting the badge exposes an interactive role is the
    // observable contract; the atom side-effects are covered by the history UI.)
    fireEvent.click(badge);
  });

  it("is a plain non-clickable label when aiChatId is null (external MCP agent)", () => {
    renderBadge({ authorName: "Bot", aiChatId: null });
    expect(screen.getByText("AI-agent")).toBeDefined();
    // No interactive role is exposed when there is no chat to deep-link into.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is non-clickable when aiChatId is absent", () => {
    renderBadge({ authorName: "Bot" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
