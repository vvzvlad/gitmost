import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";

// Integration test for the SHARED, window-based auto-reload budget (invariant a):
// the reactive chunk-load boundary and the proactive version-coherence path both
// route through the REAL @/lib/reload-guard, so at most one automatic reload
// happens per RELOAD_WINDOW_MS across BOTH paths combined. Only the two paths'
// side-effecting collaborators are mocked — the reload guard is intentionally
// REAL so this exercises the actual shared sessionStorage budget.
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("@/i18n.ts", () => ({ default: { t: (k: string) => k } }));

import { handleError } from "@/components/chunk-load-error-boundary";
import {
  triggerGuardedReload,
  useVersionReloadOnNavigation,
  __resetGuardedReloadForTests,
} from "./guarded-reload";
import { RELOAD_WINDOW_MS } from "@/lib/reload-guard";

const CHUNK_ERROR = { name: "ChunkLoadError", message: "boom" };
const T0 = 1_000_000_000_000;

let reload: ReturnType<typeof vi.fn>;
let nowMock: ReturnType<typeof vi.spyOn>;

// Harness mounted inside a router: installs the navigation hook and exposes
// `navigate` so a test can drive an in-app router navigation (the point where the
// proactive path fires its armed reload).
let doNavigate: (to: string) => void;
function Harness() {
  useVersionReloadOnNavigation();
  doNavigate = useNavigate();
  return null;
}
function mountHarness() {
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <Harness />
    </MemoryRouter>,
  );
}
function navigateTo(path: string) {
  act(() => {
    doNavigate(path);
  });
}
function setNow(t: number) {
  nowMock.mockReturnValue(t);
}

beforeEach(() => {
  sessionStorage.clear();
  __resetGuardedReloadForTests();
  vi.clearAllMocks();
  nowMock = vi.spyOn(Date, "now").mockReturnValue(T0);
  vi.stubGlobal("APP_VERSION", "test-A");
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("shared window-based reload budget (invariant a)", () => {
  it("a chunk-load reload spends the budget: a version-coherence mismatch within the window shows the banner but does NOT reload", () => {
    // Path 1 (reactive): a stale-chunk 404 auto-reloads once and stamps the window.
    handleError(CHUNK_ERROR);
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();

    // Path 2 (proactive), 1 min later — still inside the window. The shared budget
    // is spent, so the version mismatch degrades to the banner and never reloads.
    setNow(T0 + 60_000);
    mountHarness();
    triggerGuardedReload("test-B");
    navigateTo("/next");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a version-coherence reload spends the SAME budget: a chunk-load error within the window does NOT reload", () => {
    // Path 2 (proactive) first: real mismatch → arm → fire on navigation.
    mountHarness();
    triggerGuardedReload("test-B");
    navigateTo("/next");
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();

    // Path 1 (reactive), 2 min later — inside the window. Budget already spent by
    // the proactive path, so the stale-chunk error must NOT trigger a second reload.
    setNow(T0 + 2 * 60_000);
    handleError(CHUNK_ERROR);
    expect(reload).not.toHaveBeenCalled();
  });

  it("recovers after the window: a reload strictly older than the window is allowed again (second deploy)", () => {
    // First auto-reload (reactive) stamps the window.
    handleError(CHUNK_ERROR);
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();

    // A second deploy arrives after the window has fully elapsed → the proactive
    // path is allowed to reload again (window, not a permanent one-shot).
    __resetGuardedReloadForTests();
    setNow(T0 + RELOAD_WINDOW_MS + 1);
    mountHarness();
    triggerGuardedReload("test-B");
    navigateTo("/next");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reactive path fails closed when storage READS but cannot WRITE (quota / Safari private): no unguarded reload", () => {
    // getItem→null makes hasAutoReloaded() report the budget as available, so
    // handleError passes the first guard and reaches `if (!markAutoReloaded())
    // return;`. setItem throws → the stamp cannot stick, so markAutoReloaded()
    // returns false and that guard MUST bail — otherwise the reactive path would
    // reload on every stale-chunk error with no persisted budget (an unguarded
    // loop). This is the asymmetric gap: the proactive path's equivalent is
    // covered by guarded-reload.test.tsx "does NOT reload when the flag write
    // fails".
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
      clear: () => {},
    });
    try {
      handleError(CHUNK_ERROR);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sessionStorage unavailable: neither path performs an unguarded reload", () => {
    // The real guard fails toward NOT reloading when storage throws.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
      clear: () => {},
    });
    try {
      handleError(CHUNK_ERROR);
      expect(reload).not.toHaveBeenCalled();

      mountHarness();
      triggerGuardedReload("test-B");
      navigateTo("/next");
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
