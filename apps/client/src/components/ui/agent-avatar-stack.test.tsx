import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { AgentAvatarStack } from "./agent-avatar-stack";
import { avatarStyle } from "@/lib/avatar-palette";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

type Props = React.ComponentProps<typeof AgentAvatarStack>;

// The DOM normalizes an inline hex `background-color` to `rgb(...)`. Push the
// expected color through the same CSSOM path so the comparison stays exact and
// non-vacuous (an empty string — i.e. no inline background, as in the pre-fix
// Avatar approach — can never match a real color). NOTE: jsdom's CSSOM does not
// round-trip a `linear-gradient` in the `background` shorthand, which is why the
// glyph carries an explicit solid `background-color` we assert on here.
function normalizeColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  return probe.style.backgroundColor;
}

function renderStack(props: Props) {
  const store = createStore();
  store.set(aiChatDraftAtom, "leftover draft from another chat");
  const utils = render(
    <Provider store={store}>
      <MantineProvider>
        <AgentAvatarStack {...props} />
      </MantineProvider>
    </Provider>,
  );
  return { store, ...utils };
}

describe("AgentAvatarStack", () => {
  // aiChatWindowOpenAtom now persists to localStorage (getOnInit), and its onMount
  // re-reads storage — so a setWindowOpen(true) from one test (the deep-link case)
  // would leak into the next, since a fresh createStore does not isolate the shared
  // localStorage. Clear it between tests (#662).
  beforeEach(() => {
    localStorage.clear();
  });

  it("internal chat WITH role: Lucide glyph + human launcher badge in front", () => {
    const { container } = renderStack({
      agent: { name: "Researcher", emoji: '{"name":"microscope"}', avatarUrl: null },
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
    });

    // A valid IconRef renders the Lucide glyph (priority 2), NOT the sparkles
    // fallback, and never leaks the raw stored JSON.
    expect(container.querySelector(".tabler-icon-sparkles")).toBeNull();
    expect(container.textContent ?? "").not.toContain('{"name"');
    // Label: bold role name + dimmed "· launcher".
    expect(screen.getByText("Researcher")).toBeDefined();
    expect(screen.getByText(/·/)).toBeDefined();
    expect(screen.getByText("Alice")).toBeDefined();
  });

  it("emoji glyph applies its per-agent gradient as an inline DOM background", () => {
    // Pins the actual fix: the hashed gradient must reach the DOM as an inline
    // `background` on the glyph Box. The pre-fix `Avatar variant="filled"` set no
    // inline background (Mantine's --avatar-bg overrode it), so this fails there.
    const agent = { name: "Researcher", emoji: '{"name":"microscope"}', avatarUrl: null };
    const { container } = renderStack({
      agent,
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
    });

    const glyph = container.querySelector<HTMLElement>(
      '[data-testid="agent-glyph"]',
    );
    expect(glyph).not.toBeNull();
    const expected = normalizeColor(avatarStyle(agent.name).bg);
    // Non-vacuous: the pre-fix Avatar set no inline background at all.
    expect(expected).not.toBe("");
    expect(glyph!.style.backgroundColor).toBe(expected);
    // (The gradient overlay is a browser-only enhancement — jsdom's CSSOM does
    // not round-trip linear-gradient — so its stops/angle are covered by the
    // avatarStyle unit tests above, not asserted on the DOM here.)
  });

  it("agents with distinct styles reach the DOM as distinct backgrounds", () => {
    // "Researcher" and "Нарратор" hash to different palette entries, so their
    // applied DOM backgrounds must differ — pins "distinct colors reach the DOM".
    expect(avatarStyle("Researcher").bg).not.toBe(avatarStyle("Нарратор").bg);

    const a = renderStack({
      agent: { name: "Researcher", emoji: '{"name":"microscope"}', avatarUrl: null },
      launcher: null,
      aiChatId: null,
    });
    const b = renderStack({
      agent: { name: "Нарратор", emoji: '{"name":"book-open"}', avatarUrl: null },
      launcher: null,
      aiChatId: null,
    });

    const glyphA = a.container.querySelector<HTMLElement>(
      '[data-testid="agent-glyph"]',
    );
    const glyphB = b.container.querySelector<HTMLElement>(
      '[data-testid="agent-glyph"]',
    );
    expect(glyphA!.style.backgroundColor).not.toBe("");
    // Different base colors reach the DOM (the serialized rgb values differ).
    expect(glyphA!.style.backgroundColor).not.toBe(glyphB!.style.backgroundColor);
  });

  it("showName=false: renders only the avatars, no inline name label", () => {
    const { container } = renderStack({
      agent: { name: "Researcher", emoji: '{"name":"microscope"}', avatarUrl: null },
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
      showName: false,
    });

    // The agent glyph is still rendered (Lucide, not the sparkles fallback)...
    expect(container.querySelector('[data-testid="agent-glyph"]')).not.toBeNull();
    expect(container.querySelector(".tabler-icon-sparkles")).toBeNull();
    // ...but neither the agent NOR the launcher inline name label is rendered
    // (they live only in the hover tooltip, which is not mounted in the initial
    // DOM) — guards against suppressing only the agent name and leaking the
    // launcher name.
    expect(screen.queryByText("Researcher")).toBeNull();
    expect(screen.queryByText("Alice")).toBeNull();
  });

  it("internal chat WITHOUT role: sparkles fallback + 'AI agent' + launcher", () => {
    const { container } = renderStack({
      agent: { name: "AI agent", avatarUrl: null },
      launcher: { name: "Bob", avatarUrl: null },
      aiChatId: "chat-2",
    });

    // No avatarUrl and no emoji => sparkles glyph (priority 3).
    expect(container.querySelector(".tabler-icon-sparkles")).not.toBeNull();
    expect(screen.getByText("AI agent")).toBeDefined();
    expect(screen.getByText("Bob")).toBeDefined();
  });

  it("external MCP: agent avatar only, NO human launcher badge", () => {
    const { container } = renderStack({
      agent: { name: "MCP Bot", avatarUrl: "http://example.test/a.png" },
      launcher: null,
      aiChatId: null,
    });

    // avatarUrl provided (priority 1) => not the sparkles fallback.
    expect(container.querySelector(".tabler-icon-sparkles")).toBeNull();
    expect(screen.getByText("MCP Bot")).toBeDefined();
    // No human behind => no "·" separator is rendered.
    expect(screen.queryByText(/·/)).toBeNull();
    // No internal chat => the stack is not an interactive deep-link button.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("click deep-links into the chat when aiChatId is present", () => {
    const { store } = renderStack({
      agent: { name: "Researcher", emoji: '{"name":"microscope"}', avatarUrl: null },
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
    });

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(store.get(activeAiChatIdAtom)).toBe("chat-1");
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
    expect(store.get(aiChatDraftAtom)).toBe(""); // draft cleared on switch
  });

  it("click is a no-op / not interactive without a chat target", () => {
    const onActivate = vi.fn();
    renderStack({
      agent: { name: "MCP Bot", avatarUrl: "http://example.test/a.png" },
      launcher: null,
      aiChatId: null,
      onActivate,
    });
    expect(screen.queryByRole("button")).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();
  });
});
