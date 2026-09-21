import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStore } from "jotai";

// These atoms hydrate from localStorage at atom construction (getOnInit reads
// synchronously at module eval). To exercise hydration deterministically each
// test seeds the localStorage stub (from vitest.setup.ts) and then re-imports the
// atom module FRESH — a static ESM import would evaluate before any beforeEach.
async function freshHelper() {
  vi.resetModules();
  return await import("./jotai-helper");
}
async function freshSidebar() {
  vi.resetModules();
  return await import("@/components/layouts/global/hooks/atoms/sidebar-atom");
}
async function freshAiChat() {
  vi.resetModules();
  return await import("@/features/ai-chat/atoms/ai-chat-atom");
}
async function freshOpenTree() {
  vi.resetModules();
  return await import("@/features/page/tree/atoms/open-tree-nodes-atom");
}

// Run `fn` while `window.localStorage` throws on access (Chrome "Block all cookies"
// / corporate site-data policy / sandboxed iframe). getOnInit reads storage during
// `await import`, so the throw must be in place across the whole import.
async function withThrowingLocalStorage<T>(fn: () => Promise<T>): Promise<T> {
  const orig = Object.getOwnPropertyDescriptor(window, "localStorage")!;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError: site data blocked");
    },
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(window, "localStorage", orig);
  }
}

beforeEach(() => {
  localStorage.clear();
});

describe("createUiStorage fail-soft guards", () => {
  it("omits subscribe (no cross-tab sync; guards the unstable_withStorageValidator trap)", async () => {
    const { createUiStorage } = await freshHelper();
    const isBool = (v: unknown): v is boolean => typeof v === "boolean";
    // NOT a cross-tab assertion: this defends against a refactor to jotai's
    // unstable_withStorageValidator, which spreads {...storage} and copies
    // `subscribe` back in.
    expect(createUiStorage(isBool).subscribe).toBeUndefined();
  });

  it("a throwing validator degrades to the initial value instead of throwing", async () => {
    const { createUiStorage } = await freshHelper();
    localStorage.setItem("k", JSON.stringify(true));
    const throwing = ((): never => {
      throw new Error("boom");
    }) as unknown as (v: unknown) => v is boolean;
    const storage = createUiStorage<boolean>(throwing);
    expect(() => storage.getItem("k", false)).not.toThrow();
    expect(storage.getItem("k", false)).toBe(false);
  });

  it("a throwing setItem (quota) is swallowed, never propagated", async () => {
    const { createUiStorage } = await freshHelper();
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      },
    });
    try {
      const isBool = (v: unknown): v is boolean => typeof v === "boolean";
      const storage = createUiStorage<boolean>(isBool);
      expect(() => storage.setItem("k", true)).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", orig);
    }
  });
});

describe("sidebar chrome atoms round-trip and migrate", () => {
  it("reads a raw pre-existing 'false' / '420' (upgrade without cleanup) as boolean / number", async () => {
    // Values deliberately NOT the defaults, so a validator that always rejects
    // (and always returns the default) would fail this.
    localStorage.setItem("showSidebar", "false");
    localStorage.setItem("sidebarWidth", "420");
    const store = createStore();
    const { desktopSidebarAtom, sidebarWidthAtom } = await freshSidebar();
    expect(store.get(desktopSidebarAtom)).toBe(false);
    const w = store.get(sidebarWidthAtom);
    expect(w).toBe(420);
    expect(typeof w).toBe("number");
  });

  it("garbage / out-of-range sidebarWidth degrades to the default 300", async () => {
    localStorage.setItem("sidebarWidth", "{{{");
    const store = createStore();
    let mod = await freshSidebar();
    expect(store.get(mod.sidebarWidthAtom)).toBe(300);

    localStorage.setItem("sidebarWidth", "99999");
    mod = await freshSidebar();
    expect(createStore().get(mod.sidebarWidthAtom)).toBe(300);
  });

  it("blocked site-data does not throw at import and yields defaults", async () => {
    await withThrowingLocalStorage(async () => {
      const store = createStore();
      const { desktopSidebarAtom, sidebarWidthAtom } = await freshSidebar();
      expect(store.get(desktopSidebarAtom)).toBe(true);
      expect(store.get(sidebarWidthAtom)).toBe(300);
    });
  });
});

describe("asideState (right panel) persistence", () => {
  it("round-trips {tab, isAsideOpen}", async () => {
    localStorage.setItem(
      "asideState:v1",
      JSON.stringify({ tab: "comments", isAsideOpen: true }),
    );
    const store = createStore();
    const { asideStateAtom } = await freshSidebar();
    expect(store.get(asideStateAtom)).toEqual({
      tab: "comments",
      isAsideOpen: true,
    });
  });

  it("rejects tab:'' / unknown tab / garbage -> closed default", async () => {
    for (const raw of [
      JSON.stringify({ tab: "", isAsideOpen: true }),
      JSON.stringify({ tab: "zzz", isAsideOpen: true }),
      "{{{",
    ]) {
      localStorage.setItem("asideState:v1", raw);
      const mod = await freshSidebar();
      expect(createStore().get(mod.asideStateAtom)).toEqual({
        tab: "",
        isAsideOpen: false,
      });
    }
  });
});

describe("AI chat window chrome persistence", () => {
  it("open + minimized survive reload via ONE key", async () => {
    localStorage.setItem(
      "ai-chat-window-chrome:v1",
      JSON.stringify({ open: true, minimized: true }),
    );
    const store = createStore();
    const { aiChatWindowOpenAtom, aiChatWindowMinimizedAtom } =
      await freshAiChat();
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
    expect(store.get(aiChatWindowMinimizedAtom)).toBe(true);
  });

  it("facade functional updater keeps both flags in the same key", async () => {
    const store = createStore();
    const { aiChatWindowOpenAtom, aiChatWindowMinimizedAtom } =
      await freshAiChat();
    store.set(aiChatWindowOpenAtom, true);
    // Functional form (toggleMinimize uses `m => !m`): a value-only setter would
    // write the function into the object and JSON.stringify would drop it.
    store.set(aiChatWindowMinimizedAtom, (m) => !m);
    const persisted = JSON.parse(
      localStorage.getItem("ai-chat-window-chrome:v1")!,
    );
    expect(persisted).toEqual({ open: true, minimized: true });
  });

  it("EXCLUDED atoms reset to defaults even when chrome is restored open", async () => {
    localStorage.setItem(
      "ai-chat-window-chrome:v1",
      JSON.stringify({ open: true, minimized: false }),
    );
    // Seed values under the excluded atoms' would-be keys to prove they are NOT
    // read back (these atoms are plain, non-persistent).
    localStorage.setItem("aiChatDraft", JSON.stringify("leftover"));
    localStorage.setItem("activeAiChatId", JSON.stringify("chat-9"));
    localStorage.setItem("selectedAiRoleId", JSON.stringify("role-9"));
    const store = createStore();
    const {
      aiChatWindowOpenAtom,
      aiChatDraftAtom,
      activeAiChatIdAtom,
      selectedAiRoleIdAtom,
    } = await freshAiChat();
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
    expect(store.get(aiChatDraftAtom)).toBe("");
    expect(store.get(activeAiChatIdAtom)).toBeNull();
    expect(store.get(selectedAiRoleIdAtom)).toBeNull();
  });
});

describe("AI chat window geometry persistence", () => {
  it("round-trips a saved geometry", async () => {
    const geom = { left: 100, top: 500, width: 540, height: 680 };
    localStorage.setItem("ai-chat-window-geom", JSON.stringify(geom));
    const store = createStore();
    const { aiChatWindowGeomAtom } = await freshAiChat();
    expect(store.get(aiChatWindowGeomAtom)).toEqual(geom);
  });

  it("null is a legal 'never placed yet' value (validator must not throw)", async () => {
    localStorage.setItem("ai-chat-window-geom", JSON.stringify(null));
    const store = createStore();
    const { aiChatWindowGeomAtom } = await freshAiChat();
    expect(store.get(aiChatWindowGeomAtom)).toBeNull();
  });

  it("garbage / partial geometry degrades to null", async () => {
    for (const raw of ["{{{", JSON.stringify({ left: 1, top: 2 })]) {
      localStorage.setItem("ai-chat-window-geom", raw);
      const mod = await freshAiChat();
      expect(createStore().get(mod.aiChatWindowGeomAtom)).toBeNull();
    }
  });
});

describe("open-tree-nodes-atom fail-soft under blocked site-data (#4)", () => {
  it("a localStorage that THROWS at construction (getOnInit) degrades to {} and does not throw at import", async () => {
    // The open-map atom reads localStorage synchronously at atom construction
    // (getOnInit). It is routed through `uiLocalStorage`, so a browser that blocks
    // site data (getItem throws while reading `window.localStorage`) must degrade
    // the map to its default `{}` instead of white-screening the whole app.
    await withThrowingLocalStorage(async () => {
      const store = createStore();
      const { openTreeNodesAtom } = await freshOpenTree();
      // The import itself must not throw, and the value degrades to the default.
      expect(store.get(openTreeNodesAtom)).toEqual({});
    });
  });

  it("without the guard a valid open-map still round-trips (guard is not a blanket reset)", async () => {
    // Non-default value so a guard that always returned the default would fail:
    // "anon:anon" is the logged-out scope key (workspace/user both absent).
    localStorage.setItem(
      "openTreeNodes:anon:anon",
      JSON.stringify({ "page-1": true }),
    );
    const store = createStore();
    const { openTreeNodesAtom } = await freshOpenTree();
    expect(store.get(openTreeNodesAtom)).toEqual({ "page-1": true });
  });
});

describe("no cross-tab sync — positive control (#7)", () => {
  // NOTE: a runtime `storage`-event control is impractical here — jsdom's
  // StorageEvent rejects a `storageArea` that is not a real `Storage`, and the
  // test-infra localStorage is an in-memory stub (vitest.setup.ts), so jotai's
  // default subscribe (which matches `e.storageArea === storage`) could never
  // fire. Instead we assert the mechanism directly: the DEFAULT jotai storage
  // exposes a `subscribe` (that IS the cross-tab channel), while the UI storage
  // deliberately omits it — so the no-cross-tab-sync is a real, intentional gap,
  // not an accident of the stub.
  it("default createJSONStorage HAS subscribe; createUiStorage omits it", async () => {
    const { createUiStorage } = await freshHelper();
    const { createJSONStorage } = await import("jotai/utils");
    const isBool = (v: unknown): v is boolean => typeof v === "boolean";

    const defaultStorage = createJSONStorage<boolean>(() => localStorage);
    expect(typeof defaultStorage.subscribe).toBe("function"); // cross-tab ON
    expect(createUiStorage(isBool).subscribe).toBeUndefined(); // cross-tab OFF
  });
});
