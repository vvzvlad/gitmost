import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDefaultStore } from "jotai";
import { QueryClient } from "@tanstack/react-query";
import type { IndexeddbPersistence } from "y-indexeddb";
import type { ICurrentUser } from "@/features/user/types/user.types";

/**
 * #564 guard 3 / #626 / #640 — access revoked (403) or page deleted (404) must
 * TOMBSTONE the page (so the next visit opens no local persistence) and destroy
 * its LOCAL ydoc on disk, whether or not the editor is still mounted.
 */

const PAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLUG_ID = "slugid1";
const SCOPE_STORAGE_KEY = "pageMeta:v1:w1:u1";
const SCOPE = "w1:u1";

let localFirstEnabled = true;

// Full mock (NOT importOriginal): the real @/lib/config pulls in
// @/lib/utils -> page-icon -> lucide-react/dynamic, which is unresolved in the
// test env (one of the repo's ~38 pre-existing lucide load failures). Provide
// every config function the transitive graph reads.
vi.mock("@/lib/config", () => ({
  isLocalFirstEnabled: () => localFirstEnabled,
  isClientTelemetryEnabled: () => false,
  getOfflineGraceMs: () => 30 * 24 * 60 * 60 * 1000,
}));

function currentUser(): ICurrentUser {
  return {
    user: { id: "u1" },
    workspace: { id: "w1" },
  } as unknown as ICurrentUser;
}

function seedBootCache(pageId: string, slugId: string): void {
  const entry = {
    id: pageId,
    slugId,
    title: "Revoked page",
    icon: null,
    lastAccess: Date.now(),
  };
  localStorage.setItem(
    SCOPE_STORAGE_KEY,
    JSON.stringify({ [pageId]: entry, [slugId]: entry }),
  );
}

/** Fresh module instances, so the boot cache re-hydrates from localStorage. */
async function freshImport(opts?: { signedIn?: boolean }) {
  vi.resetModules();
  const userModule = await import("@/features/user/atoms/current-user-atom");
  if (opts?.signedIn ?? true) {
    getDefaultStore().set(userModule.currentUserAtom, currentUser());
  } else {
    getDefaultStore().set(userModule.currentUserAtom, null);
  }
  return import("./page-ydoc-eviction");
}

function fakePersistence() {
  return {
    clearData: vi.fn(async () => {}),
  } as unknown as IndexeddbPersistence & {
    clearData: ReturnType<typeof vi.fn>;
  };
}

let deleteDatabase: ReturnType<typeof vi.fn>;

/** A delete request that fires `onsuccess` on the next microtask. */
function successReq(): any {
  const req: any = {};
  Promise.resolve().then(() => req.onsuccess?.());
  return req;
}

beforeEach(() => {
  localFirstEnabled = true;
  localStorage.clear();
  deleteDatabase = vi.fn(() => successReq());
  vi.stubGlobal("indexedDB", { deleteDatabase });
  // A minimal BroadcastChannel so the purge broadcast does not throw.
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

async function failPageQuery(
  queryClient: QueryClient,
  key: string,
  status: number,
) {
  await queryClient
    .fetchQuery({
      queryKey: ["pages", key],
      queryFn: async () => {
        throw Object.assign(new Error("nope"), { status });
      },
      retry: false,
    })
    .catch(() => undefined);
}

describe("pageYdocDbName / pageYdocRoomName (#640 invariant 1)", () => {
  it("DB name is scope-namespaced; ROOM name is NOT", async () => {
    const mod = await freshImport();
    expect(mod.pageYdocDbName(SCOPE, PAGE_ID)).toBe(`page.${SCOPE}.${PAGE_ID}`);
    // The collab room name must stay `page.<pageId>` — a single dot segment — so
    // the server's `documentName.split('.')[1]` resolves the pageId, not the
    // workspaceId. Namespacing it would break every collab connection.
    expect(mod.pageYdocRoomName(PAGE_ID)).toBe(`page.${PAGE_ID}`);
    expect(mod.pageYdocRoomName(PAGE_ID).split(".").length).toBe(2);
  });

  it("the DB name differs across scopes; the room name does not", async () => {
    const mod = await freshImport();
    expect(mod.pageYdocDbName("wA:uA", PAGE_ID)).not.toBe(
      mod.pageYdocDbName("wB:uB", PAGE_ID),
    );
    expect(mod.pageYdocRoomName(PAGE_ID)).toBe(mod.pageYdocRoomName(PAGE_ID));
  });
});

describe("evictPageYdoc", () => {
  it("clears the IDB data of a MOUNTED page (clearData destroys + deletes)", async () => {
    const mod = await freshImport();
    const persistence = fakePersistence();
    mod.registerPageYdoc({
      dbName: mod.pageYdocDbName(SCOPE, PAGE_ID),
      persistence,
      keys: [PAGE_ID, SLUG_ID],
    });

    await expect(mod.evictPageYdoc(SLUG_ID)).resolves.toBe(true);
    expect(persistence.clearData).toHaveBeenCalledTimes(1);
  });

  it("deletes the IDB database directly when the page is no longer mounted", async () => {
    const mod = await freshImport();
    const persistence = fakePersistence();
    mod.registerPageYdoc({
      dbName: mod.pageYdocDbName(SCOPE, PAGE_ID),
      persistence,
      keys: [PAGE_ID, SLUG_ID],
    });
    mod.unregisterPageYdoc(mod.pageYdocDbName(SCOPE, PAGE_ID));

    await expect(mod.evictPageYdoc(SLUG_ID)).resolves.toBe(true);
    expect(persistence.clearData).not.toHaveBeenCalled();
    expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`);
  });

  it("evicts a slugId this session never opened, via the persisted boot cache", async () => {
    seedBootCache(PAGE_ID, SLUG_ID);
    const mod = await freshImport();

    await expect(mod.evictPageYdoc(SLUG_ID)).resolves.toBe(true);
    expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`);
  });

  it("evicts a never-opened page by pageId; a slugId known to NOTHING is a no-op", async () => {
    const mod = await freshImport();
    await expect(mod.evictPageYdoc(PAGE_ID)).resolves.toBe(true);
    expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`);

    deleteDatabase.mockClear();
    await expect(mod.evictPageYdoc("never-seen-slug")).resolves.toBe(false);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  // #640, acceptance 8 — anon-scope eviction must NOT run in vain.
  it("QUEUES an eviction under an anon scope, then drains it once the scope resolves", async () => {
    const mod = await freshImport({ signedIn: false });
    const userModule = await import("@/features/user/atoms/current-user-atom");
    mod.installYdocScopeResolveDrain();

    // Signed out → scope is anon:anon. A 403 must not compute a
    // `page.anon:anon.<id>` name (matching no real DB) and falsely succeed.
    await expect(mod.evictPageYdoc(PAGE_ID)).resolves.toBe(false);
    expect(deleteDatabase).not.toHaveBeenCalled();

    // Scope resolves → the queued eviction runs against the REAL scope.
    getDefaultStore().set(userModule.currentUserAtom, currentUser());
    await vi.waitFor(() =>
      expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`),
    );
  });
});

describe("tombstones on 403/404 (#640 acceptance 4)", () => {
  it("a 403 tombstones the page under both aliases → next construction is blocked", async () => {
    seedBootCache(PAGE_ID, SLUG_ID);
    const mod = await freshImport();
    const tomb = await import("./page-ydoc-tombstones");

    await mod.evictPageYdoc(SLUG_ID);

    // The construction gate must now refuse BOTH the pageId- and slugId-derived
    // DB names, so the editor opens a remote-only ydoc and creates no database.
    expect(tomb.canOpenLocalYdoc(`page.${SCOPE}.${PAGE_ID}`)).toBe(false);
    expect(tomb.canOpenLocalYdoc(`page.${SCOPE}.${SLUG_ID}`)).toBe(false);
  });

  it("a successful page fetch lifts the tombstone (#640 acceptance 5)", async () => {
    const mod = await freshImport();
    const tomb = await import("./page-ydoc-tombstones");

    await mod.evictPageYdoc(PAGE_ID);
    expect(tomb.canOpenLocalYdoc(`page.${SCOPE}.${PAGE_ID}`)).toBe(false);

    // Access returned (restored from trash / regranted): proof, so lift it.
    mod.clearPageTombstoneOnAccess({ id: PAGE_ID, slugId: SLUG_ID });
    expect(tomb.canOpenLocalYdoc(`page.${SCOPE}.${PAGE_ID}`)).toBe(true);
    expect(tomb.canOpenLocalYdoc(`page.${SCOPE}.${SLUG_ID}`)).toBe(true);
  });
});

describe("installPageYdocEviction (global page-query error subscriber)", () => {
  it("destroys the local ydoc on 403 and on 404", async () => {
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    const revoked = fakePersistence();
    mod.registerPageYdoc({
      dbName: mod.pageYdocDbName(SCOPE, PAGE_ID),
      persistence: revoked,
      keys: [PAGE_ID, SLUG_ID],
    });
    await failPageQuery(queryClient, SLUG_ID, 403);
    await vi.waitFor(() => expect(revoked.clearData).toHaveBeenCalledTimes(1));

    const deleted = fakePersistence();
    const otherPage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mod.registerPageYdoc({
      dbName: mod.pageYdocDbName(SCOPE, otherPage),
      persistence: deleted,
      keys: [otherPage],
    });
    await failPageQuery(queryClient, otherPage, 404);
    await vi.waitFor(() => expect(deleted.clearData).toHaveBeenCalledTimes(1));

    unsubscribe();
  });

  it("destroys the ydoc of a REVOKED page that never mounted in this session", async () => {
    seedBootCache(PAGE_ID, SLUG_ID);
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    await failPageQuery(queryClient, SLUG_ID, 403);

    await vi.waitFor(() =>
      expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`),
    );
    unsubscribe();
  });

  // #640, acceptance 10 — deletion is OUT of the flag gate now.
  it("STILL deletes when the local-first flag is OFF", async () => {
    seedBootCache(PAGE_ID, SLUG_ID);
    localFirstEnabled = false;
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    await failPageQuery(queryClient, SLUG_ID, 403);

    await vi.waitFor(() =>
      expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`),
    );
    unsubscribe();
  });

  it("leaves the ydoc alone on other failures (500, offline) and on other queries", async () => {
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    const persistence = fakePersistence();
    mod.registerPageYdoc({
      dbName: mod.pageYdocDbName(SCOPE, PAGE_ID),
      persistence,
      keys: [PAGE_ID, SLUG_ID],
    });

    await failPageQuery(queryClient, SLUG_ID, 500);
    await queryClient
      .fetchQuery({
        queryKey: ["pages", SLUG_ID, "other"],
        queryFn: async () => {
          throw new Error("network down");
        },
        retry: false,
      })
      .catch(() => undefined);

    await new Promise((r) => setTimeout(r, 0));
    expect(persistence.clearData).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();

    unsubscribe();
  });
});

/** An indexedDB stub whose `databases()` resolves to the given name list. */
function idbWithDatabases(names: string[]) {
  const del = vi.fn(() => successReq());
  return {
    del,
    idb: {
      deleteDatabase: del,
      databases: vi.fn(async () => names.map((name) => ({ name }))),
    },
  };
}

describe("purgePageYdocDatabases (#640 acceptance 2)", () => {
  it("deletes ONLY page.-prefixed databases and AWAITS completion", async () => {
    const mod = await freshImport();
    const { del, idb } = idbWithDatabases([
      "page.w1:u1.pageA",
      "page.w2:u2.pageB",
      "keyval-store",
      "someOtherDb",
    ]);
    vi.stubGlobal("indexedDB", idb);

    await mod.purgePageYdocDatabases();

    expect(del).toHaveBeenCalledWith("page.w1:u1.pageA");
    expect(del).toHaveBeenCalledWith("page.w2:u2.pageB");
    expect(del).not.toHaveBeenCalledWith("keyval-store");
    expect(del).not.toHaveBeenCalledWith("someOtherDb");
  });

  it("deletes via the registry when databases() is unavailable (Firefox)", async () => {
    const mod = await freshImport();
    mod.rememberYdocDbName("page.w1:u1.pageA");
    mod.rememberYdocDbName("not-a-page-db");
    const del = vi.fn(() => successReq());
    vi.stubGlobal("indexedDB", { deleteDatabase: del });

    await expect(mod.purgePageYdocDatabases()).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith("page.w1:u1.pageA");
    expect(del).not.toHaveBeenCalledWith("not-a-page-db");
    expect(localStorage.getItem("pageYdoc.dbNames.v1")).toBeNull();
  });

  // #640, acceptance 3 — a blocked deletion increments a metric, never a warn.
  it("counts a BLOCKED deletion to an always-on safety metric", async () => {
    const mod = await freshImport();
    const metrics = await import("@/lib/telemetry/safety-metrics");
    metrics.resetSafetyMetricsForTests();

    mod.rememberYdocDbName("page.w1:u1.pageA");
    const del = vi.fn(() => {
      const req: any = {};
      // Another tab holds the db open: onblocked fires; the broadcast then lets
      // it close and onsuccess follows, settling the awaited delete.
      Promise.resolve().then(() => {
        req.onblocked?.();
        req.onsuccess?.();
      });
      return req;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase: del });

    await mod.purgePageYdocDatabases();

    expect(metrics.getSafetyMetric("ydoc_delete_blocked")).toBe(1);
  });
});

describe("migratePageYdocDatabasesOnce (#640 acceptance 9)", () => {
  it("deletes legacy page.<pageId> via enumeration, leaves namespaced intact, runs once", async () => {
    const mod = await freshImport();
    const legacy = `page.${PAGE_ID}`;
    const namespaced = `page.w1:u1.${PAGE_ID}`;
    const { del, idb } = idbWithDatabases([legacy, namespaced, "keyval-store"]);
    vi.stubGlobal("indexedDB", idb);

    mod.migratePageYdocDatabasesOnce();

    await vi.waitFor(() => expect(del).toHaveBeenCalledWith(legacy));
    expect(del).not.toHaveBeenCalledWith(namespaced);
    expect(del).not.toHaveBeenCalledWith("keyval-store");
    expect(localStorage.getItem("pageYdoc.legacyPurged.v1")).toBe("1");

    del.mockClear();
    idb.databases.mockClear();
    mod.migratePageYdocDatabasesOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(idb.databases).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  // Firefox (no databases()): derive the legacy name from the raw page-meta blob.
  it("deletes a legacy DB derived from the page-meta cache when databases() is unavailable", async () => {
    seedBootCache(PAGE_ID, SLUG_ID);
    const mod = await freshImport();
    const del = vi.fn(() => successReq());
    vi.stubGlobal("indexedDB", { deleteDatabase: del });

    mod.migratePageYdocDatabasesOnce();

    await vi.waitFor(() =>
      expect(del).toHaveBeenCalledWith(`page.${PAGE_ID}`),
    );
    // The slugId-derived legacy name is also swept.
    expect(del).toHaveBeenCalledWith(`page.${SLUG_ID}`);
    expect(localStorage.getItem("pageYdoc.legacyPurged.v1")).toBe("1");
  });
});

// #641, part 7 — `hasLocalPageBody` is the fail-closed control page.tsx consults
// (synchronously, no IndexedDB open) to pick offline-local (render the cached
// body) vs offline-empty. It returns TRUE only when ALL of: the scope is resolved
// (not anon), the session is within OFFLINE_GRACE, the page is NOT tombstoned
// under EITHER alias (the security-critical revocation branch, #564/#640), AND
// the ydoc DB name is in the browser registry (the body was actually written on
// this device). Each `it` proves the OBSERVABLE decision and is NON-VACUOUS: the
// header of each case names which branch flips the result vs the positive case.
describe("hasLocalPageBody fail-closed control (#641 part 7)", () => {
  const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

  it("POSITIVE: resolved scope + registered db (not expired / not tombstoned) → true", async () => {
    const mod = await freshImport();
    mod.rememberYdocDbName(mod.pageYdocDbName(SCOPE, PAGE_ID));
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID)).toBe(true);
  });

  it("anon / unresolved scope → false (the anon guard is the discriminator)", async () => {
    const mod = await freshImport();
    // Register the anon-scoped name too, so the ONLY thing forcing false is the
    // anon guard — not a registry miss (that would make the test vacuous).
    mod.rememberYdocDbName(mod.pageYdocDbName("anon:anon", PAGE_ID));
    // Same page under a resolved scope IS reported present (control), so the anon
    // scope is the sole discriminator.
    mod.rememberYdocDbName(mod.pageYdocDbName(SCOPE, PAGE_ID));
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID)).toBe(true);
    expect(mod.hasLocalPageBody("anon:anon", PAGE_ID)).toBe(false);
  });

  it("session EXPIRED past OFFLINE_GRACE → false (session-boundary branch)", async () => {
    const mod = await freshImport();
    const sv = await import("@/features/user/session-verified");
    mod.rememberYdocDbName(mod.pageYdocDbName(SCOPE, PAGE_ID));

    // A fresh/within-grace stamp still reports the body present (control)...
    sv.recordSessionVerified(Date.now());
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID)).toBe(true);

    // ...but a stamp older than OFFLINE_GRACE fail-closes to false.
    sv.recordSessionVerified(Date.now() - OFFLINE_GRACE_MS - 60_000);
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID)).toBe(false);
  });

  it("tombstoned under the pageId-derived name → false (Ф4 revocation)", async () => {
    const mod = await freshImport();
    const tomb = await import("./page-ydoc-tombstones");
    mod.rememberYdocDbName(mod.pageYdocDbName(SCOPE, PAGE_ID));
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID, SLUG_ID)).toBe(true);

    tomb.addTombstones([mod.pageYdocDbName(SCOPE, PAGE_ID)]);
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID, SLUG_ID)).toBe(false);
  });

  it("tombstoned under the slugId ALIAS name ONLY (not the pageId name) → STILL false", async () => {
    // The security-critical alias branch: a revoked page addressed by slug must
    // not render its cached body even when the pageId-derived name is clean.
    const mod = await freshImport();
    const tomb = await import("./page-ydoc-tombstones");
    // The registry hit is on the pageId name, so the ONLY thing forcing false is
    // the alias tombstone (a registry miss would make this vacuous).
    mod.rememberYdocDbName(mod.pageYdocDbName(SCOPE, PAGE_ID));
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID, SLUG_ID)).toBe(true);

    tomb.addTombstones([mod.pageYdocDbName(SCOPE, SLUG_ID)]);
    // The pageId-derived name is NOT tombstoned...
    expect(tomb.canOpenLocalYdoc(mod.pageYdocDbName(SCOPE, PAGE_ID))).toBe(true);
    // ...yet the slug alias tombstone alone must still deny the local body.
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID, SLUG_ID)).toBe(false);
  });

  it("registry: db name KNOWN → true; ABSENT from the registry → false", async () => {
    const mod = await freshImport();
    // Absent from the registry (never opened on this device): the meta cache may
    // hold the chrome, but the BODY was never written here → false.
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID)).toBe(false);

    // Once the ydoc DB name is registered (opened here at least once) → true.
    mod.rememberYdocDbName(mod.pageYdocDbName(SCOPE, PAGE_ID));
    expect(mod.hasLocalPageBody(SCOPE, PAGE_ID)).toBe(true);
  });
});

describe("pageYdocRoomName vs pageYdocDbName (collab room != db name)", () => {
  // Mirrors the SERVER contract in apps/server/src/collaboration/
  // collaboration.util.ts: getPageId(documentName) = documentName.split(".")[1].
  // The collab ROOM name is what the client passes to HocuspocusProvider.name, so
  // it MUST resolve back to the pageId here. #626 wired the scoped DB name into the
  // room name, so the server resolved the scope instead of the pageId and rejected
  // every authenticated collab connection — this locks that regression out.
  const serverGetPageId = (documentName: string) => documentName.split(".")[1];

  it("room name resolves to the pageId under the server's getPageId contract", async () => {
    const mod = await freshImport();
    const room = mod.pageYdocRoomName(PAGE_ID);
    expect(room).toBe(`page.${PAGE_ID}`);
    expect(serverGetPageId(room)).toBe(PAGE_ID);
  });

  it("the SCOPED db name must NOT be used as the room name (it resolves to the scope)", async () => {
    const mod = await freshImport();
    const dbName = mod.pageYdocDbName(SCOPE, PAGE_ID);
    // The db name is deliberately 3-segment (page.<scope>.<pageId>); feeding it to
    // the collab room resolves the SCOPE, not the pageId — the #626 break.
    expect(serverGetPageId(dbName)).toBe(SCOPE);
    expect(serverGetPageId(dbName)).not.toBe(PAGE_ID);
    // The room name and the db name are distinct by construction.
    expect(mod.pageYdocRoomName(PAGE_ID)).not.toBe(dbName);
  });
});
