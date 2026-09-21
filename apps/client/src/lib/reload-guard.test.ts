import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hasAutoReloaded,
  markAutoReloaded,
  shouldAutoReload,
  recordReloadBreadcrumb,
  takeReloadBreadcrumb,
  RELOAD_WINDOW_MS,
} from "./reload-guard";

// The shared budget is a single sessionStorage timestamp keyed here; both the
// reactive chunk-load boundary and the proactive version-coherence path read and
// stamp it, so at most one auto-reload happens per RELOAD_WINDOW_MS across BOTH.
const RELOAD_AT_KEY = "chunk-reload-at";
const NOW = 1_000_000_000_000;

describe("reload-guard", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("hasAutoReloaded is false before any reload, true within the window after mark", () => {
    expect(hasAutoReloaded(NOW)).toBe(false);
    expect(markAutoReloaded(NOW)).toBe(true);
    // Same key both paths share; stores the reload timestamp, not a flag.
    expect(sessionStorage.getItem(RELOAD_AT_KEY)).toBe(String(NOW));
    // Inside the window → budget spent → true (fall through to manual UI).
    expect(hasAutoReloaded(NOW)).toBe(true);
    expect(hasAutoReloaded(NOW + RELOAD_WINDOW_MS)).toBe(true);
  });

  it("hasAutoReloaded is false again once the window has elapsed (a later deploy recovers)", () => {
    markAutoReloaded(NOW);
    // Strictly older than the window → a new deploy's mismatch may reload again.
    expect(hasAutoReloaded(NOW + RELOAD_WINDOW_MS + 1)).toBe(false);
  });

  it("hasAutoReloaded returns true when reading storage throws (fail toward not reloading)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    try {
      expect(hasAutoReloaded()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hasAutoReloaded treats an unparseable stored timestamp as never-reloaded", () => {
    sessionStorage.setItem(RELOAD_AT_KEY, "not-a-number");
    expect(hasAutoReloaded(NOW)).toBe(false);
  });

  it("markAutoReloaded returns false when writing storage throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    try {
      expect(markAutoReloaded()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records and then takes a breadcrumb once (cleared on read)", () => {
    recordReloadBreadcrumb({
      path: "proactive",
      serverVersion: "test-B",
      clientVersion: "test-A",
    });
    const crumb = takeReloadBreadcrumb();
    expect(crumb).toMatchObject({
      path: "proactive",
      serverVersion: "test-B",
      clientVersion: "test-A",
    });
    expect(typeof crumb?.at).toBe("number");
    // Cleared on read → a second take returns null.
    expect(takeReloadBreadcrumb()).toBeNull();
  });

  it("takeReloadBreadcrumb returns null when nothing was recorded", () => {
    expect(takeReloadBreadcrumb()).toBeNull();
  });

  it("recordReloadBreadcrumb swallows a storage-write error (diagnostics only)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
    });
    try {
      expect(() =>
        recordReloadBreadcrumb({ path: "chunk-boundary" }),
      ).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// The pure window gate replaces the old one-shot flag: it must permit recovery
// across several deploys in one tab (each > window apart) while still stopping an
// infinite reload loop when a lazy chunk is permanently broken (a second failure
// < window). Moved here from the chunk-load boundary now that it is the shared
// guard both paths route through.
describe("shouldAutoReload", () => {
  const WINDOW = RELOAD_WINDOW_MS;

  it("allows a reload when we have never auto-reloaded", () => {
    expect(shouldAutoReload(NOW, null, WINDOW)).toBe(true);
  });

  it("allows a reload when the last one was 6 minutes ago (outside the window)", () => {
    expect(shouldAutoReload(NOW, NOW - 6 * 60 * 1000, WINDOW)).toBe(true);
  });

  it("blocks a reload when the last one was 1 minute ago (inside the window)", () => {
    expect(shouldAutoReload(NOW, NOW - 1 * 60 * 1000, WINDOW)).toBe(false);
  });

  it("blocks a reload exactly at the window boundary (not strictly older)", () => {
    expect(shouldAutoReload(NOW, NOW - WINDOW, WINDOW)).toBe(false);
  });

  it("allows a reload when the stored timestamp is unparseable (NaN)", () => {
    expect(shouldAutoReload(NOW, NaN, WINDOW)).toBe(true);
  });
});
