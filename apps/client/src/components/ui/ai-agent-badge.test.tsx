import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { AiAgentBadge } from "./ai-agent-badge";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

function renderBadge(props: { authorName?: string; aiChatId?: string | null }) {
  return render(
    <MantineProvider>
      <AiAgentBadge {...props} />
    </MantineProvider>,
  );
}

// Render a clickable badge inside an explicit jotai store, with a leftover draft
// and an onActivate + parent-click spy, so the deep-link side effects are
// assertable. Returns the store and spies.
function setupClickable() {
  const store = createStore();
  store.set(aiChatDraftAtom, "leftover draft from another chat");
  const onActivate = vi.fn();
  const onParentClick = vi.fn();
  render(
    <Provider store={store}>
      <MantineProvider>
        <div onClick={onParentClick}>
          <AiAgentBadge authorName="Bot" aiChatId="chat-1" onActivate={onActivate} />
        </div>
      </MantineProvider>
    </Provider>,
  );
  return { store, onActivate, onParentClick, badge: screen.getByRole("button") };
}

function expectDeepLinked(store: ReturnType<typeof createStore>, onActivate: ReturnType<typeof vi.fn>) {
  expect(store.get(activeAiChatIdAtom)).toBe("chat-1");
  expect(store.get(aiChatWindowOpenAtom)).toBe(true);
  expect(store.get(aiChatDraftAtom)).toBe(""); // draft cleared
  expect(onActivate).toHaveBeenCalledTimes(1); // caller closes its own modal etc.
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
  });

  it("click deep-links: sets active chat, clears draft, opens window, fires onActivate, stops propagation", () => {
    const { store, onActivate, onParentClick, badge } = setupClickable();
    fireEvent.click(badge);
    expectDeepLinked(store, onActivate);
    expect(onParentClick).not.toHaveBeenCalled(); // stopPropagation contained the click
  });

  it.each(["Enter", " "])(
    "keyboard %j activates the deep-link (same side effects as click)",
    (key) => {
      const { store, onActivate, badge } = setupClickable();
      fireEvent.keyDown(badge, { key });
      expectDeepLinked(store, onActivate);
    },
  );

  it("an unrelated key does NOT activate the badge", () => {
    const { store, onActivate, badge } = setupClickable();
    fireEvent.keyDown(badge, { key: "Tab" });
    expect(store.get(activeAiChatIdAtom)).toBeNull();
    expect(store.get(aiChatWindowOpenAtom)).toBe(false);
    expect(store.get(aiChatDraftAtom)).toBe("leftover draft from another chat");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it.each([{ aiChatId: null }, {}])(
    "is a plain non-clickable label without a chat target (%o)",
    (props) => {
      renderBadge({ authorName: "Bot", ...props });
      expect(screen.getByText("AI-agent")).toBeDefined();
      // No interactive role is exposed when there is no chat to deep-link into.
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});
