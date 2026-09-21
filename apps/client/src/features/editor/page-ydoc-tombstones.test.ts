import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock config: the real one pulls @/lib/utils -> page-icon -> lucide-react/dynamic,
// unresolved in the test env (pre-existing). safety-metrics reads only
// isClientTelemetryEnabled.
vi.mock("@/lib/config", () => ({
  isClientTelemetryEnabled: () => false,
  isLocalFirstEnabled: () => true,
  getOfflineGraceMs: () => 30 * 24 * 60 * 60 * 1000,
}));

import {
  canOpenLocalYdoc,
  isTombstoned,
  addTombstones,
  removeTombstones,
  isLocalPaintDisabledForSession,
  resetTombstonesForTests,
} from "./page-ydoc-tombstones";
import {
  getSafetyMetric,
  resetSafetyMetricsForTests,
} from "@/lib/telemetry/safety-metrics";

const TOMBSTONE_KEY = "pageYdoc.tombstones.v1";
const DB_BY_ID = "page.w1:u1.aaaaaaaa";
const DB_BY_SLUG = "page.w1:u1.slug1";

beforeEach(() => {
  localStorage.clear();
  resetTombstonesForTests();
  resetSafetyMetricsForTests();
  vi.stubGlobal("indexedDB", { deleteDatabase: vi.fn(() => ({}) as any) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("tombstone denylist (#640 part 5)", () => {
  it("blocks construction once tombstoned, under both aliases, and lifts on proof", () => {
    expect(canOpenLocalYdoc(DB_BY_ID)).toBe(true);

    // 403/404 arrives on `["pages", <id|slugId>]`; the caller tombstones BOTH
    // alias-derived DB names so a slugId-only case cannot fail OPEN.
    addTombstones([DB_BY_ID, DB_BY_SLUG]);
    expect(canOpenLocalYdoc(DB_BY_ID)).toBe(false);
    expect(canOpenLocalYdoc(DB_BY_SLUG)).toBe(false);
    expect(isTombstoned(DB_BY_ID)).toBe(true);

    // ONLY proof of access-return lifts it.
    removeTombstones([DB_BY_ID, DB_BY_SLUG]);
    expect(canOpenLocalYdoc(DB_BY_ID)).toBe(true);
    expect(canOpenLocalYdoc(DB_BY_SLUG)).toBe(true);
  });

  it("is persisted in localStorage (read fresh on every check, not cached)", () => {
    addTombstones([DB_BY_ID]);
    // The raw blob holds the tombstone, so a fresh read (next construction
    // attempt / reload) still refuses it.
    expect(localStorage.getItem(TOMBSTONE_KEY)).toContain(DB_BY_ID);
    expect(canOpenLocalYdoc(DB_BY_ID)).toBe(false);
  });
});

describe("tombstone store is FAIL-CLOSED (#640 acceptance 6)", () => {
  it("a corrupt store disables the local-paint path for the whole session + meters it", () => {
    localStorage.setItem(TOMBSTONE_KEY, "{ this is not valid json");

    // Fail-CLOSED (NOT the neighbouring caches' fail-open "corrupt -> empty ->
    // draw everything"): every page is refused local paint, and the degraded
    // mode is metered.
    expect(canOpenLocalYdoc(DB_BY_ID)).toBe(false);
    expect(canOpenLocalYdoc("page.w1:u1.anything")).toBe(false);
    expect(isLocalPaintDisabledForSession()).toBe(true);
    expect(getSafetyMetric("ydoc_local_paint_disabled")).toBe(1);
  });

  it("a failed tombstone WRITE meters the failure and fail-closes the session", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    addTombstones([DB_BY_ID]);

    expect(getSafetyMetric("ydoc_tombstone_write_failed")).toBe(1);
    expect(getSafetyMetric("ydoc_local_paint_disabled")).toBe(1);
    expect(isLocalPaintDisabledForSession()).toBe(true);
    // With the session disabled, construction is refused everywhere.
    setItem.mockRestore();
    expect(canOpenLocalYdoc("page.w1:u1.whatever")).toBe(false);
  });

  it("cap overflow FAIL-CLOSES the session — never an unconfirmed LRU drop", () => {
    // Seed the store at the cap (1000). An LRU eviction here would fire a
    // best-effort deleteDatabase (blockable by another tab) and drop the guard
    // regardless — resurrecting revoked content after the next login. Overflow
    // must fail-close instead.
    const full: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) full[`page.w1:u1.p${i}`] = i;
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(full));
    const del = vi.fn(() => ({}) as any);
    vi.stubGlobal("indexedDB", { deleteDatabase: del });

    addTombstones(["page.w1:u1.overflow"]); // 1001 -> overflow

    expect(isLocalPaintDisabledForSession()).toBe(true);
    expect(getSafetyMetric("ydoc_local_paint_disabled")).toBeGreaterThan(0);
    // No unconfirmed LRU delete was attempted (the forbidden pattern).
    expect(del).not.toHaveBeenCalled();
    // Session disabled => everything is denied local paint (fail-closed).
    expect(canOpenLocalYdoc("page.w1:u1.p0")).toBe(false);
  });
});
