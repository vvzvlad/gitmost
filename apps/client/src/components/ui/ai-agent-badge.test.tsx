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
import { historyAtoms } from "@/features/page-history/atoms/history-atoms.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

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
  });

  it("deep-links on click: sets the active chat, clears the draft, opens the AI-chat window, closes the history modal — and stops propagation", () => {
    const store = createStore();
    // Pre-set the state the click must change, so the assertions are meaningful.
    store.set(historyAtoms, true); // history modal open
    store.set(aiChatDraftAtom, "leftover draft from another chat");
    const onParentClick = vi.fn();

    render(
      <Provider store={store}>
        <MantineProvider>
          {/* Parent click handler must NOT fire — the badge stops propagation. */}
          <div onClick={onParentClick}>
            <AiAgentBadge authorName="Bot" aiChatId="chat-1" />
          </div>
        </MantineProvider>
      </Provider>,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(store.get(activeAiChatIdAtom)).toBe("chat-1");
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
    expect(store.get(aiChatDraftAtom)).toBe(""); // draft cleared
    expect(store.get(historyAtoms)).toBe(false); // history modal closed
    expect(onParentClick).not.toHaveBeenCalled(); // stopPropagation contained the click
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
