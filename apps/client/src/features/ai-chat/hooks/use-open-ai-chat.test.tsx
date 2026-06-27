import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { useOpenAiChatForCurrentPage } from "./use-open-ai-chat";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
  selectedAiRoleIdAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// useMatch is the only react-router-dom export the hook uses; drive its return
// per test to simulate "on a page" vs "off a page".
const useMatchMock = vi.fn();
vi.mock("react-router-dom", () => ({
  useMatch: () => useMatchMock(),
}));

// The bound-chat resolver is the network boundary; stub it per test.
const getBoundChatMock = vi.fn();
vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  getBoundChat: (pageId: string) => getBoundChatMock(pageId),
}));

// Put the hook on a page route by default ("doc-p1" -> page id "p1"); individual
// tests override useMatch to go off-page.
function onPage(pageSlug = "doc-p1") {
  useMatchMock.mockReturnValue({ params: { pageSlug } });
}
function offPage() {
  useMatchMock.mockReturnValue(null);
}

// Render the hook inside an explicit jotai store so atom side effects are
// assertable; the store is returned for setup + assertions.
function setup(seed?: (store: ReturnType<typeof createStore>) => void) {
  const store = createStore();
  seed?.(store);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const { result } = renderHook(() => useOpenAiChatForCurrentPage(), { wrapper });
  return { store, open: () => act(() => result.current()) };
}

describe("useOpenAiChatForCurrentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onPage();
  });

  it("on a page: resolves the bound chat, selects it, and opens the window", async () => {
    getBoundChatMock.mockResolvedValue("bound-chat-1");
    const { store, open } = setup((s) => s.set(aiChatDraftAtom, "stale draft"));

    await open();

    expect(getBoundChatMock).toHaveBeenCalledWith("p1");
    expect(store.get(activeAiChatIdAtom)).toBe("bound-chat-1");
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
    expect(store.get(aiChatDraftAtom)).toBe(""); // cleared on a real switch
  });

  it("on a page with no bound chat: opens a fresh chat (null)", async () => {
    getBoundChatMock.mockResolvedValue(null);
    const { store, open } = setup((s) => s.set(activeAiChatIdAtom, "previous"));

    await open();

    expect(store.get(activeAiChatIdAtom)).toBeNull();
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
  });

  it("off a page: keeps the current selection and does NOT resolve", async () => {
    offPage();
    const { store, open } = setup((s) => {
      s.set(activeAiChatIdAtom, "keep-me");
      s.set(aiChatDraftAtom, "untouched");
    });

    await open();

    expect(getBoundChatMock).not.toHaveBeenCalled();
    expect(store.get(activeAiChatIdAtom)).toBe("keep-me");
    expect(store.get(aiChatDraftAtom)).toBe("untouched"); // no switch -> kept
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
  });

  it("window already open: re-click does NOT re-resolve or switch chats", async () => {
    getBoundChatMock.mockResolvedValue("would-switch");
    const { store, open } = setup((s) => {
      s.set(aiChatWindowOpenAtom, true);
      s.set(activeAiChatIdAtom, "current");
    });

    await open();

    expect(getBoundChatMock).not.toHaveBeenCalled();
    expect(store.get(activeAiChatIdAtom)).toBe("current");
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
  });

  it("does NOT clear the draft when the resolved chat equals the current one", async () => {
    getBoundChatMock.mockResolvedValue("same");
    const { store, open } = setup((s) => {
      s.set(activeAiChatIdAtom, "same");
      s.set(aiChatDraftAtom, "in-progress");
    });

    await open();

    expect(store.get(aiChatDraftAtom)).toBe("in-progress"); // no switch
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
  });

  it("fail-soft: a resolve error opens a fresh chat (null)", async () => {
    getBoundChatMock.mockRejectedValue(new Error("network"));
    const { store, open } = setup((s) => s.set(activeAiChatIdAtom, "previous"));

    await open();

    expect(store.get(activeAiChatIdAtom)).toBeNull();
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
  });

  it("clears the picked role on a real switch", async () => {
    getBoundChatMock.mockResolvedValue("bound");
    const { store, open } = setup((s) => s.set(selectedAiRoleIdAtom, "role-1"));

    await open();

    expect(store.get(selectedAiRoleIdAtom)).toBeNull();
  });
});
