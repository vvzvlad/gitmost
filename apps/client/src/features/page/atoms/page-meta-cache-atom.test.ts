import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStore, getDefaultStore } from "jotai";
import { QueryClient } from "@tanstack/react-query";
import type { IPage } from "@/features/page/types/page.types";
import type { ICurrentUser } from "@/features/user/types/user.types";

// The page-meta boot cache hydrates from localStorage ONCE per (module, scope)
// — `getOnInit: true` on an atomFamily member. Every test therefore imports a
// FRESH module instance after seeding storage / the feature flag, exactly like
// the tree-data-atom suite it mirrors.

const SCOPE_KEY = "pageMeta:v1:w1:u1";
const ANON_KEY = "pageMeta:v1:anon:anon";
const DEBOUNCE_MS = 500;

async function freshImport() {
  vi.resetModules();
  const metaModule = await import("./page-meta-cache-atom");
  const treeModule = await import(
    "@/features/page/tree/atoms/tree-data-atom"
  );
  const userModule = await import("@/features/user/atoms/current-user-atom");
  return {
    ...metaModule,
    clearPersistedTreeCaches: treeModule.clearPersistedTreeCaches,
    currentUserAtom: userModule.currentUserAtom,
  };
}

function currentUser(workspaceId: string, userId: string): ICurrentUser {
  return {
    user: { id: userId },
    workspace: { id: workspaceId },
  } as unknown as ICurrentUser;
}

function page(overrides: Partial<IPage> = {}): Partial<IPage> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slugId: "slug1",
    title: "Roadmap",
    icon: "🚀",
    spaceId: "space-1",
    space: { slug: "engineering" } as IPage["space"],
    permissions: { canEdit: true, hasRestriction: false },
    deletedAt: null as unknown as Date,
    updatedAt: "2026-07-01T10:00:00.000Z" as unknown as Date,
    content: "SHOULD NEVER BE CACHED",
    ...overrides,
  };
}

function persistedMetaKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && key.startsWith("pageMeta:")) keys.push(key);
  }
  return keys;
}

beforeEach(() => {
  localStorage.clear();
  // The cache is default-off; the flag is mirrored from the server into
  // window.CONFIG (process.env in DEV/test — see lib/config.ts).
  process.env.LOCAL_FIRST_ENABLED = "true";
});

afterEach(() => {
  delete process.env.LOCAL_FIRST_ENABLED;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pageMetaCacheAtom (localStorage boot cache)", () => {
  it("writes through under BOTH aliases and re-hydrates a fresh module (reload)", async () => {
    vi.useFakeTimers();
    const { writePageMetaAtom, pageMetaCacheAtom, currentUserAtom } =
      await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    store.set(writePageMetaAtom, page());

    // Trailing-debounced, like the tree cache: nothing persisted yet.
    expect(localStorage.getItem(SCOPE_KEY)).toBeNull();
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);

    const blob = JSON.parse(localStorage.getItem(SCOPE_KEY)!);
    expect(Object.keys(blob).sort()).toEqual(
      ["11111111-1111-4111-8111-111111111111", "slug1"].sort(),
    );
    expect(blob["slug1"].title).toBe("Roadmap");
    expect(blob["slug1"].icon).toBe("🚀");
    // The entry carries ONLY what the chrome reads: no page CONTENT, and — since
    // edit rights are fail-closed on the live response — no permissions either.
    expect(Object.keys(blob["slug1"]).sort()).toEqual(
      ["icon", "id", "lastAccess", "slugId", "title"].sort(),
    );
    expect(JSON.stringify(blob)).not.toContain("SHOULD NEVER BE CACHED");
    expect(JSON.stringify(blob)).not.toContain("canEdit");

    // A fresh module (fresh family -> getOnInit re-reads storage) + fresh store:
    // the reload scenario. The entry is available SYNCHRONOUSLY, no network.
    const second = await freshImport();
    const store2 = createStore();
    store2.set(second.currentUserAtom, currentUser("w1", "u1"));
    expect(store2.get(second.pageMetaCacheAtom)["slug1"].title).toBe("Roadmap");
  });

  it("reconciles: a changed title from the network overwrites the cached entry", async () => {
    const { writePageMetaAtom, pageMetaCacheAtom, currentUserAtom } =
      await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    store.set(writePageMetaAtom, page());
    store.set(writePageMetaAtom, page({ title: "Roadmap 2027", icon: "🗺️" }));

    const cache = store.get(pageMetaCacheAtom);
    expect(cache["slug1"].title).toBe("Roadmap 2027");
    expect(cache["11111111-1111-4111-8111-111111111111"].title).toBe(
      "Roadmap 2027",
    );
  });

  it("is scoped per (workspace, user): another account sees no entries", async () => {
    const { writePageMetaAtom, pageMetaCacheAtom, currentUserAtom } =
      await freshImport();
    const store = createStore();

    store.set(currentUserAtom, currentUser("w1", "u1"));
    store.set(writePageMetaAtom, page());
    expect(store.get(pageMetaCacheAtom)["slug1"]).toBeDefined();

    store.set(currentUserAtom, currentUser("w2", "u2"));
    expect(store.get(pageMetaCacheAtom)["slug1"]).toBeUndefined();

    store.set(currentUserAtom, currentUser("w1", "u1"));
    expect(store.get(pageMetaCacheAtom)["slug1"].title).toBe("Roadmap");
  });

  it("fail-closed while the user is unresolved: no anon read, no anon write", async () => {
    // A blob planted under the anon scope must never be served…
    localStorage.setItem(
      ANON_KEY,
      JSON.stringify({
        slug1: { id: "x", slugId: "slug1", title: "Leaked", lastAccess: 1 },
      }),
    );

    const { writePageMetaAtom, pageMetaCacheAtom } = await freshImport();
    const store = createStore(); // no currentUser -> scope "anon:anon"

    expect(store.get(pageMetaCacheAtom)).toEqual({});

    // …and a write landing before `/me` resolves must not persist real titles.
    store.set(writePageMetaAtom, page());
    expect(store.get(pageMetaCacheAtom)).toEqual({});
    expect(localStorage.getItem(ANON_KEY)).toBe(
      JSON.stringify({
        slug1: { id: "x", slugId: "slug1", title: "Leaked", lastAccess: 1 },
      }),
    );
  });

  it("LOCAL_FIRST_ENABLED=false: neither reads nor writes (today's behavior)", async () => {
    const seeded = JSON.stringify({
      slug1: {
        id: "11111111-1111-4111-8111-111111111111",
        slugId: "slug1",
        title: "Roadmap",
        lastAccess: 1,
      },
    });
    localStorage.setItem(SCOPE_KEY, seeded);
    process.env.LOCAL_FIRST_ENABLED = "false";

    const off = await freshImport();
    const offStore = createStore();
    offStore.set(off.currentUserAtom, currentUser("w1", "u1"));

    expect(offStore.get(off.pageMetaCacheAtom)).toEqual({});
    offStore.set(off.writePageMetaAtom, page({ title: "Written while off" }));
    expect(offStore.get(off.pageMetaCacheAtom)).toEqual({});
    expect(localStorage.getItem(SCOPE_KEY)).toBe(seeded);

    // Non-vacuity: the very same seed IS served with the flag on.
    process.env.LOCAL_FIRST_ENABLED = "true";
    const on = await freshImport();
    const onStore = createStore();
    onStore.set(on.currentUserAtom, currentUser("w1", "u1"));
    expect(onStore.get(on.pageMetaCacheAtom)["slug1"].title).toBe("Roadmap");
  });

  it("degrades silently on corrupt JSON and on non-entry shapes", async () => {
    localStorage.setItem(SCOPE_KEY, "{not json at all!!");
    const corrupt = await freshImport();
    const store = createStore();
    store.set(corrupt.currentUserAtom, currentUser("w1", "u1"));
    expect(store.get(corrupt.pageMetaCacheAtom)).toEqual({});

    // Valid JSON of a wrong shape, and a blob whose entries are junk.
    localStorage.setItem(SCOPE_KEY, JSON.stringify(["not", "a", "map"]));
    const wrongShape = await freshImport();
    const store2 = createStore();
    store2.set(wrongShape.currentUserAtom, currentUser("w1", "u1"));
    expect(store2.get(wrongShape.pageMetaCacheAtom)).toEqual({});

    localStorage.setItem(
      SCOPE_KEY,
      JSON.stringify({ slug1: { title: "no ids" }, slug2: null, slug3: 42 }),
    );
    const junkEntries = await freshImport();
    const store3 = createStore();
    store3.set(junkEntries.currentUserAtom, currentUser("w1", "u1"));
    expect(store3.get(junkEntries.pageMetaCacheAtom)).toEqual({});
  });

  it("survives a QuotaExceededError: the in-memory cache keeps working", async () => {
    vi.useFakeTimers();
    const { writePageMetaAtom, pageMetaCacheAtom, currentUserAtom } =
      await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    // Installed AFTER the user is set (currentUserAtom persists itself too — the
    // subject under test here is the page-meta write path).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => {
      store.set(writePageMetaAtom, page());
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    }).not.toThrow();

    // Persistence failed, but the chrome still has its metadata this session.
    expect(store.get(pageMetaCacheAtom)["slug1"].title).toBe("Roadmap");
    expect(warn).toHaveBeenCalledTimes(1);

    // Warned ONCE, not on every flush.
    store.set(writePageMetaAtom, page({ title: "again" }));
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a FAILED persist keeps the value queued: a re-read cannot clobber the newer in-memory entry", async () => {
    vi.useFakeTimers();
    const {
      writePageMetaAtom,
      pageMetaCacheAtom,
      flushPendingPageMetaWrites,
      currentUserAtom,
    } = await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    // A first, SUCCESSFUL persist puts an old title on disk.
    store.set(writePageMetaAtom, page({ title: "Old on disk" }));
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    expect(JSON.parse(localStorage.getItem(SCOPE_KEY)!)["slug1"].title).toBe(
      "Old on disk",
    );

    // Storage now refuses writes (quota). The rename below never reaches disk.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItem = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
    store.set(writePageMetaAtom, page({ title: "Newer, unpersistable" }));
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);

    // jotai re-reads storage in onMount — i.e. on every remount of the first
    // subscriber. The failed write must still be served from the pending queue;
    // otherwise this read serves the OLD blob still sitting on disk back into the
    // in-memory atom and the newer title is lost (the "in-memory atom is the
    // source of truth" claim).
    const unsubscribe = store.sub(pageMetaCacheAtom, () => undefined);
    expect(store.get(pageMetaCacheAtom)["slug1"].title).toBe(
      "Newer, unpersistable",
    );
    unsubscribe();

    // Still queued -> the next flush RETRIES it once storage recovers.
    setItem.mockRestore();
    flushPendingPageMetaWrites();
    expect(JSON.parse(localStorage.getItem(SCOPE_KEY)!)["slug1"].title).toBe(
      "Newer, unpersistable",
    );
  });

  it("LRU-evicts the least-recently-written pages over the cap, leaving the tree cache alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    localStorage.setItem("treeData:v1:w1:u1", JSON.stringify([{ id: "t" }]));

    const { writePageMetaAtom, pageMetaCacheAtom, currentUserAtom } =
      await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    // 301 distinct pages, each written 1s after the previous (MAX_CACHED_PAGES
    // is 300), so page-0 is the least-recently-used.
    for (let i = 0; i < 301; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 6, 1, 0, 0, i)));
      store.set(
        writePageMetaAtom,
        page({ id: `id-${i}`, slugId: `slug-${i}`, title: `Page ${i}` }),
      );
    }

    const cache = store.get(pageMetaCacheAtom);
    expect(cache["slug-0"]).toBeUndefined();
    expect(cache["id-0"]).toBeUndefined();
    expect(cache["slug-1"]).toBeDefined();
    expect(cache["slug-300"]).toBeDefined();
    // 300 pages x 2 aliases.
    expect(Object.keys(cache).length).toBe(600);

    // The sidebar tree cache is a separate key and is never touched.
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    expect(localStorage.getItem("treeData:v1:w1:u1")).toBe(
      JSON.stringify([{ id: "t" }]),
    );
  });

  it("keeps a just-written entry across a remount inside the debounce window", async () => {
    vi.useFakeTimers();
    const { writePageMetaAtom, pageMetaCacheAtom, currentUserAtom } =
      await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    store.set(writePageMetaAtom, page()); // queued, NOT flushed yet

    // jotai re-reads storage in the atom's onMount, which happens every time the
    // first component subscribes — i.e. on every navigation back into a page.
    // Without the pending-write lookup in the storage adapter this read would
    // return the last FLUSHED blob (empty) and silently drop the entry.
    const unsubscribe = store.sub(pageMetaCacheAtom, () => undefined);
    expect(store.get(pageMetaCacheAtom)["slug1"]).toBeDefined();
    unsubscribe();

    vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    expect(JSON.parse(localStorage.getItem(SCOPE_KEY)!)["slug1"].title).toBe(
      "Roadmap",
    );
  });

  it("removePageMetaAtom drops BOTH aliases", async () => {
    const { writePageMetaAtom, removePageMetaAtom, pageMetaCacheAtom, currentUserAtom } =
      await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));
    store.set(writePageMetaAtom, page());

    store.set(removePageMetaAtom, "slug1");

    expect(store.get(pageMetaCacheAtom)).toEqual({});
  });

  it("derivePageChromeCanEdit re-derives the page.tsx rule from raw fields", async () => {
    const { derivePageChromeCanEdit } = await freshImport();
    expect(
      derivePageChromeCanEdit({
        deletedAt: null,
        permissions: { canEdit: true, hasRestriction: false },
      }),
    ).toBe(true);
    // A trashed page is never editable, even with canEdit permissions.
    expect(
      derivePageChromeCanEdit({
        deletedAt: new Date("2026-07-01T00:00:00.000Z"),
        permissions: { canEdit: true, hasRestriction: false },
      }),
    ).toBe(false);
    expect(
      derivePageChromeCanEdit({ deletedAt: null, permissions: null }),
    ).toBe(false);
    expect(derivePageChromeCanEdit(undefined)).toBe(false);
  });
});

describe("installPageMetaEviction (403/404 kills the cached chrome)", () => {
  it("evicts the page on a 404 and on a 403, but keeps it on a 500", async () => {
    const { writePageMetaAtom, pageMetaCacheAtom, installPageMetaEviction, currentUserAtom } =
      await freshImport();
    // The subscriber is global (not mounted): it writes to jotai's DEFAULT store,
    // the one the app uses (there is no <Provider>).
    const store = getDefaultStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    const queryClient = new QueryClient();
    const unsubscribe = installPageMetaEviction(queryClient);

    const fail = async (key: string, status: number) => {
      await queryClient
        .fetchQuery({
          queryKey: ["pages", key],
          queryFn: () => Promise.reject({ status }),
          retry: false,
        })
        .catch(() => undefined);
    };

    // A server error must NOT throw away a good cache entry (non-vacuity guard:
    // the two assertions below would both pass if eviction never ran).
    store.set(writePageMetaAtom, page());
    await fail("slug1", 500);
    expect(store.get(pageMetaCacheAtom)["slug1"]).toBeDefined();

    // Page deleted -> 404 -> both aliases go, so the next visit is a clean miss
    // instead of stale chrome.
    await fail("slug1", 404);
    expect(store.get(pageMetaCacheAtom)["slug1"]).toBeUndefined();
    expect(
      store.get(pageMetaCacheAtom)["11111111-1111-4111-8111-111111111111"],
    ).toBeUndefined();

    // Access revoked -> 403, addressed by the page's uuid alias this time.
    store.set(writePageMetaAtom, page());
    await fail("11111111-1111-4111-8111-111111111111", 403);
    expect(store.get(pageMetaCacheAtom)).toEqual({});

    unsubscribe();
    store.set(currentUserAtom, null as unknown as ICurrentUser);
  });
});

describe("logout purge", () => {
  it("clearPersistedTreeCaches sweeps pageMeta keys and freezes further writes", async () => {
    vi.useFakeTimers();
    localStorage.setItem("pageMeta:v1:old:scope", JSON.stringify({ a: 1 }));
    localStorage.setItem("currentUser", JSON.stringify({ user: { id: "u1" } }));

    const {
      writePageMetaAtom,
      clearPersistedTreeCaches,
      flushPendingPageMetaWrites,
      currentUserAtom,
    } = await freshImport();
    const store = createStore();
    store.set(currentUserAtom, currentUser("w1", "u1"));

    store.set(writePageMetaAtom, page());
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    expect(persistedMetaKeys().sort()).toEqual(
      ["pageMeta:v1:old:scope", SCOPE_KEY].sort(),
    );

    // Queue one more (debounced, not yet flushed) write, then log out.
    store.set(writePageMetaAtom, page({ title: "typed just before logout" }));
    clearPersistedTreeCaches();

    // Every scope's meta key is gone — including the stale one from an old user.
    expect(persistedMetaKeys()).toEqual([]);
    // Unrelated keys survive.
    expect(localStorage.getItem("currentUser")).not.toBeNull();

    // Kill-switch: neither the queued write nor a NEW one (a late websocket echo
    // racing the redirect) may resurrect a swept key.
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    store.set(writePageMetaAtom, page({ title: "late echo" }));
    vi.advanceTimersByTime(DEBOUNCE_MS + 50);
    flushPendingPageMetaWrites();
    expect(persistedMetaKeys()).toEqual([]);
  });
});
