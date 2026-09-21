import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import {
  aiChatWindowGeomAtom,
  aiChatWindowOpenAtom,
  aiChatWindowMinimizedAtom,
  type AiChatWindowGeom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// AiChatWindow's layout-effect owns the two central #662 gotchas that have NO
// atom-level coverage: the geometry-clobber-on-first-open-after-reload (gotcha 1)
// and the size-clamp of a geometry saved on a larger monitor (gotcha 4). Both
// live entirely in this component, so they are exercised by rendering the REAL
// component with a restored geom seeded into the store and asserting the box the
// effect commits (its inline left/top/width/height), NOT by reading the atom.

// ---------------------------------------------------------------------------
// Mocks: keep every heavy child / network hook inert so only the window chrome +
// its layout-effect run. Mirrors use-open-ai-chat.test.tsx / chat-thread.test.tsx.
// ---------------------------------------------------------------------------
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
}));

// The window lives in a pathless layout route. Drive both router hooks: a
// non-page location + a null page match (so usePageMetaQuery stays disabled).
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/home", search: "", hash: "", state: null }),
  useMatch: () => null,
}));

// Heavy children — the thread engine + conversation list — are replaced by inert
// markers so no useChat store / query fires. ChatThread is rendered in the body.
vi.mock("@/features/ai-chat/components/chat-thread.tsx", () => ({
  default: () => <div data-testid="chat-thread" />,
}));
vi.mock("@/features/ai-chat/components/conversation-list.tsx", () => ({
  default: () => <div data-testid="conversation-list" />,
}));

// The thread-identity lifecycle hook: return a settled shape (history loaded, a
// stable key) so the body renders the ChatThread branch, not the loader.
vi.mock("@/features/ai-chat/hooks/use-chat-session.ts", () => ({
  useChatSession: () => ({
    threadKey: "test-key",
    waitingForHistory: false,
    startFreshThread: vi.fn(),
    onTurnFinished: vi.fn(),
    onServerChatId: vi.fn(),
    cancelPendingAdoption: vi.fn(),
  }),
}));

// Chat-list / roles / messages queries — all idle. Keep the RQ-key helpers as
// real-ish functions (used in the invalidate closures, never in this test path).
vi.mock("@/features/ai-chat/queries/ai-chat-query.ts", () => ({
  AI_CHATS_RQ_KEY: ["ai-chats"],
  AI_CHAT_MESSAGES_RQ_KEY: (id: string) => ["ai-chat-messages", id],
  useAiChatsQuery: () => ({ data: undefined }),
  useAiRolesQuery: () => ({ data: undefined }),
  useAiChatMessagesQuery: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  exportAiChat: vi.fn(),
  getAiChatMessagesDelta: vi.fn(),
  stopRun: vi.fn(),
}));

// usePageMetaQuery would otherwise pull page-query -> main.tsx createRoot side
// effects; stub it (it is disabled anyway — useMatch returns null).
vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageMetaQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/use-clipboard", () => ({
  useClipboard: () => ({ copy: vi.fn(), copied: false }),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

// jsdom has no ResizeObserver; the window's resize-persist effect constructs one.
// A no-op stub lets the effect mount without capturing sizes (irrelevant here).
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import AiChatWindow from "./ai-chat-window";

// CSS-mirrored constants from ai-chat-window.tsx (kept in sync there).
const EDGE_MARGIN = 8;
const DEFAULT_WIDTH = 540;
// Deterministic viewport, independent of the jsdom default.
const VIEWPORT_W = 1200;
const VIEWPORT_H = 900;

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
}

// Seed a restored chrome + geom into an explicit store (this is exactly the
// post-reload state getOnInit produces), then render the real window.
function renderWindow(opts: {
  geom: AiChatWindowGeom | null;
  open?: boolean;
  minimized?: boolean;
}) {
  const store = createStore();
  store.set(aiChatWindowOpenAtom, opts.open ?? true);
  store.set(aiChatWindowMinimizedAtom, opts.minimized ?? false);
  store.set(aiChatWindowGeomAtom, opts.geom);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <Provider store={store}>
          <AiChatWindow />
        </Provider>
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { store };
}

// The outer, position:fixed window box (winRef) carrying the inline geometry.
// Structure: window div > dragBar div > <span> title. closest("div") on the span
// yields the dragBar; its parent is the window box.
function windowBox(): HTMLElement {
  const title = screen.getByText("AI chat");
  const dragBar = title.closest("div")!;
  return dragBar.parentElement as HTMLElement;
}

const px = (el: HTMLElement, prop: "left" | "top" | "width" | "height") =>
  parseFloat(el.style[prop]);

describe("AiChatWindow — persisted geometry / minimized restore (#662)", () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(VIEWPORT_W, VIEWPORT_H);
  });
  afterEach(cleanup);

  it("minimized:true survives a simulated reload (restored collapsed stays collapsed)", () => {
    // Post-reload state: chrome restored open+minimized. The layout-effect must
    // NOT reset minimized on OPEN (only on CLOSE), so the collapsed window stays
    // collapsed — its title exposes the keyboard "Expand" affordance.
    renderWindow({
      geom: { left: 100, top: 120, width: 400, height: 400 },
      open: true,
      minimized: true,
    });
    // Non-vacuity: if the effect regressed to reset minimized on open, the title
    // would be a plain label with no "Expand" aria-label and this would throw.
    expect(screen.getByLabelText("Expand")).toBeTruthy();
  });

  it("does NOT clobber a restored geometry on first open (gotcha 1)", () => {
    // A geometry saved on this same viewport (clamp is a no-op) must be rendered
    // as-is; the default top-right placement must NOT overwrite it.
    const saved = { left: 100, top: 120, width: 400, height: 400 };
    renderWindow({ geom: saved, open: true });

    const el = windowBox();
    // The restored geom is honoured verbatim...
    expect(px(el, "left")).toBe(100);
    expect(px(el, "top")).toBe(120);
    expect(px(el, "width")).toBe(400);
    expect(px(el, "height")).toBe(400);
    // ...and specifically is NOT the default top-right placement, which the old
    // clobber wrote (left = innerWidth - DEFAULT_WIDTH - 24 = 636). If the effect
    // regressed to setGeom(computeInitialGeom()) this assertion goes RED.
    expect(px(el, "left")).not.toBe(VIEWPORT_W - DEFAULT_WIDTH - 24);
  });

  it("clamps a geometry saved on a bigger monitor to the viewport (gotcha 4)", () => {
    // Saved on a 3000x2000 screen; restored here on 1200x900. Both size and
    // position must be pulled back on-screen: width/height clamp to
    // innerW/H - 2*EDGE and left/top recompute so the box stays fully visible.
    renderWindow({
      geom: { left: 10, top: 10, width: 3000, height: 2000 },
      open: true,
    });

    const el = windowBox();
    expect(px(el, "width")).toBe(VIEWPORT_W - 2 * EDGE_MARGIN); // 1184
    expect(px(el, "height")).toBe(VIEWPORT_H - 2 * EDGE_MARGIN); // 884
    // With the box now filling (viewport - 2*EDGE), the only on-screen position
    // is EDGE_MARGIN in both axes (maxLeft/maxTop collapse to EDGE).
    expect(px(el, "left")).toBe(EDGE_MARGIN);
    expect(px(el, "top")).toBe(EDGE_MARGIN);
    // The box must NOT still be the un-clamped saved width (off-screen).
    expect(px(el, "width")).not.toBe(3000);
  });

  it("renders nothing until a geometry exists (first-ever open computes it)", () => {
    // With geom null the guard returns null on the first render; the layout-effect
    // then computes the top-right default and the window appears. Assert it lands
    // at the computed default (proves the null branch takes computeInitialGeom()).
    renderWindow({ geom: null, open: true });
    const el = windowBox();
    expect(px(el, "left")).toBe(VIEWPORT_W - DEFAULT_WIDTH - 24); // 636
    expect(px(el, "top")).toBe(60);
    expect(px(el, "width")).toBe(DEFAULT_WIDTH);
  });
});
