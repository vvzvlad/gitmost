import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { aiChatWindowOpenAtom } from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// #662 #19: persisting the AI-chat open-state means a user who left the window
// open reloads with a STALE `ai.chat: true` hydrated from disk. The kill-switch
// must SUPPRESS the window (gate both the mount latch and the render): when the
// fresh workspace arrives with `ai.chat: false` the window must tear down, and a
// transient `workspace === null` (the sign-in RESET window) must not crash.

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/home", search: "", hash: "", state: null }),
}));

// Mantine AppShell (+ any child) constructs a ResizeObserver; jsdom lacks it.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

// Heavy shell children -> inert markers.
vi.mock("@/components/settings/settings-sidebar.tsx", () => ({
  default: () => <div />,
}));
vi.mock("@/features/space/components/sidebar/space-sidebar.tsx", () => ({
  SpaceSidebar: () => <div />,
}));
vi.mock("@/components/layouts/global/app-header.tsx", () => ({
  AppHeader: () => <div />,
}));
vi.mock("@/components/layouts/global/global-sidebar.tsx", () => ({
  default: () => <div />,
}));
vi.mock("@/features/editor/gitmost/gitmost-global-bridge.tsx", () => ({
  default: () => <div />,
}));
vi.mock("@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts", () => ({
  useToggleSidebar: () => () => {},
}));

// The lazy-imported window: a detectable marker (React.lazy needs a default).
vi.mock("@/features/ai-chat/components/ai-chat-window.tsx", () => ({
  default: () => <div data-testid="ai-chat-window" />,
}));
vi.mock("@/components/layouts/global/aside.tsx", () => ({
  default: () => <div data-testid="aside" />,
}));

import GlobalAppShell from "./global-app-shell";

type Chat = boolean | undefined;
const userWith = (chat: Chat) =>
  ({
    user: { id: "u1" },
    workspace: { id: "w1", settings: { ai: { chat } } },
  }) as never;

function renderShell(seed: (s: ReturnType<typeof createStore>) => void) {
  const store = createStore();
  store.set(aiChatWindowOpenAtom, true); // restored-open (persisted)
  seed(store);
  render(
    <Queryless store={store}>
      <GlobalAppShell>
        <div data-testid="page-body" />
      </GlobalAppShell>
    </Queryless>,
  );
  return { store };
}

function Queryless({
  store,
  children,
}: {
  store: ReturnType<typeof createStore>;
  children: React.ReactNode;
}) {
  return (
    <MantineProvider>
      <Provider store={store}>{children}</Provider>
    </MantineProvider>
  );
}

describe("GlobalAppShell — ai.chat kill-switch gate (#662 #19)", () => {
  afterEach(cleanup);

  it("mounts the window when ai.chat is true (restored open)", async () => {
    renderShell((s) => s.set(currentUserAtom, userWith(true)));
    expect(await screen.findByTestId("ai-chat-window")).toBeTruthy();
  });

  it("tears the window down when ai.chat flips true -> false", async () => {
    const { store } = renderShell((s) => s.set(currentUserAtom, userWith(true)));
    // Latch armed + rendered while allowed.
    expect(await screen.findByTestId("ai-chat-window")).toBeTruthy();

    // Fresh /me lands with the kill-switch OFF: the render gate (not just the
    // one-way latch) must suppress the still-mounted window.
    await act(async () => {
      store.set(currentUserAtom, userWith(false));
    });
    expect(screen.queryByTestId("ai-chat-window")).toBeNull();
  });

  it("handles workspace === null without crashing (still allowed -> mounts)", async () => {
    // A transient null workspace (sign-in RESET) is NOT a positive `false`, so it
    // must not tear down / crash. `undefined !== false` -> allowed.
    renderShell((s) => s.set(currentUserAtom, null));
    // The shell rendered (page body present) and the window mounts, no throw.
    expect(screen.getByTestId("page-body")).toBeTruthy();
    expect(await screen.findByTestId("ai-chat-window")).toBeTruthy();
  });
});
