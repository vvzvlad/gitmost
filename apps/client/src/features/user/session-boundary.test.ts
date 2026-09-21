import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock config: the real one pulls @/lib/utils -> page-icon -> lucide-react/dynamic,
// unresolved in the test env (pre-existing). Keep OFFLINE_GRACE at the real 30d.
vi.mock("@/lib/config", () => ({
  isLocalFirstEnabled: () => true,
  isClientTelemetryEnabled: () => false,
  getOfflineGraceMs: () => 30 * 24 * 60 * 60 * 1000,
}));

import {
  recordSessionVerified,
  isSessionExpired,
  getSessionVerifiedAt,
  clearSessionVerifiedForTests,
} from "./session-verified";
import { enforceOfflineSessionBoundary } from "./session-boundary";

const DAY = 24 * 60 * 60 * 1000;
const REGISTRY_KEY = "pageYdoc.dbNames.v1";
const TREE_KEY = "treeData:v1:w1:u1";
const META_KEY = "pageMeta:v1:w1:u1";

let deleteDatabase: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  clearSessionVerifiedForTests();
  deleteDatabase = vi.fn(() => {
    const req: any = {};
    Promise.resolve().then(() => req.onsuccess?.());
    return req;
  });
  vi.stubGlobal("indexedDB", { deleteDatabase });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage() {}
      close() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("session verification stamp (#640 part 6)", () => {
  it("records and reads the verified-at stamp", () => {
    const now = Date.now();
    recordSessionVerified(now);
    expect(getSessionVerifiedAt()).toBe(now);
  });

  it("is NOT expired when fresh or never stamped", () => {
    expect(isSessionExpired()).toBe(false); // no stamp
    recordSessionVerified(Date.now() - DAY);
    expect(isSessionExpired()).toBe(false); // 1 day old, well under 30d
  });

  it("IS expired past OFFLINE_GRACE (30d)", () => {
    recordSessionVerified(Date.now() - 31 * DAY);
    expect(isSessionExpired()).toBe(true);
  });
});

describe("enforceOfflineSessionBoundary (#640 acceptance 7)", () => {
  it("purges ydoc DBs and the boot caches when the session is expired — offline, no 401", () => {
    // A session verified 31 days ago and never since (the client has been
    // offline the whole time, so no 401 ever arrived).
    recordSessionVerified(Date.now() - 31 * DAY);
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(["page.w1:u1.pageA"]));
    localStorage.setItem(TREE_KEY, "[]");
    localStorage.setItem(META_KEY, "{}");

    const purged = enforceOfflineSessionBoundary();

    expect(purged).toBe(true);
    // The local ydoc body is deleted...
    expect(deleteDatabase).toHaveBeenCalledWith("page.w1:u1.pageA");
    // ...and the persisted chrome/tree caches are swept.
    expect(localStorage.getItem(TREE_KEY)).toBeNull();
    expect(localStorage.getItem(META_KEY)).toBeNull();
  });

  it("does nothing when the session is still within grace", () => {
    recordSessionVerified(Date.now() - DAY);
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(["page.w1:u1.pageA"]));
    localStorage.setItem(TREE_KEY, "[]");

    const purged = enforceOfflineSessionBoundary();

    expect(purged).toBe(false);
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(localStorage.getItem(TREE_KEY)).toBe("[]");
  });
});
