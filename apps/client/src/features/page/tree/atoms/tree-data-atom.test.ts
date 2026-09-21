import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpaceTreeNode } from "@/features/page/tree/types";
import type { ICurrentUser } from "@/features/user/types/user.types";

// The persisted tree-data atom hydrates from localStorage ONCE, at family-atom
// creation (`getOnInit: true`). To exercise hydration deterministically each
// test imports a FRESH module instance (fresh atomFamily) after seeding the
// storage stub from vitest.setup.ts. jotai itself is externalized by vitest, so
// `createStore` can stay a static import — atoms are plain objects and any
// store works with any module instance.
import { createStore } from "jotai";

// Storage key for the default scope: no currentUser -> "anon:anon" (see
// scopeKeyAtom in open-tree-nodes-atom.ts) with the `v1` cache-shape version.
const ANON_KEY = "treeData:v1:anon:anon";
const DEBOUNCE_MS = 500;

async function freshImport() {
  vi.resetModules();
  const treeDataModule = await import("./tree-data-atom");
  const userModule = await import(
    "@/features/user/atoms/current-user-atom"
  );
  return {
    treeDataAtom: treeDataModule.treeDataAtom,
    flushPendingTreeDataWrites: treeDataModule.flushPendingTreeDataWrites,
    clearPersistedTreeCaches: treeDataModule.clearPersistedTreeCaches,
    currentUserAtom: userModule.currentUserAtom,
  };
}

function node(id: string): SpaceTreeNode {
  return {
    id,
    slugId: `slug-${id}`,
    name: id,
    position: "a0",
    spaceId: "space-1",
    parentPageId: null as unknown as string,
    hasChildren: false,
    children: [],
  };
}

// Every persisted tree key currently in storage — asserting on the whole
// prefix (not one known key) catches writes that resurrect under ANY scope.
function persistedTreeDataKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && key.startsWith("treeData:v1:")) keys.push(key);
  }
  return keys;
}

function currentUser(workspaceId: string, userId: string): ICurrentUser {
  return {
    user: { id: userId },
    workspace: { id: workspaceId },
  } as unknown as ICurrentUser;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("treeDataAtom (localStorage-persisted)", () => {
  it("reads [] from a fresh store with empty storage", async () => {
    const { treeDataAtom } = await freshImport();
    const store = createStore();

    expect(store.get(treeDataAtom)).toEqual([]);
  });

  it("persists through the debounced setItem and hydrates a fresh module back", async () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(localStorage, "setItem");

    const { treeDataAtom } = await freshImport();
    const store = createStore();

    store.set(treeDataAtom, [node("a")]);
    // Second write inside the debounce window — must coalesce into ONE flush
    // carrying only the latest value.
    vi.advanceTimersByTime(DEBOUNCE_MS / 2);
    store.set(treeDataAtom, [node("a"), node("b")]);

    // Nothing flushed yet: the write is trailing-debounced.
    expect(localStorage.getItem(ANON_KEY)).toBeNull();

    vi.advanceTimersByTime(DEBOUNCE_MS + 100);

    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(ANON_KEY)!)).toEqual([
      node("a"),
      node("b"),
    ]);

    // A fresh module (fresh atom family -> getOnInit re-reads storage) and a
    // fresh store hydrate the persisted tree back — the reload scenario.
    const second = await freshImport();
    const store2 = createStore();
    expect(store2.get(second.treeDataAtom)).toEqual([node("a"), node("b")]);
  });

  it("reads [] (without throwing) when storage holds corrupted JSON", async () => {
    localStorage.setItem(ANON_KEY, "{definitely not JSON!!!");

    const { treeDataAtom } = await freshImport();
    const store = createStore();

    expect(store.get(treeDataAtom)).toEqual([]);
  });

  it("reads [] when storage holds valid JSON of a non-array shape", async () => {
    localStorage.setItem(ANON_KEY, JSON.stringify({ id: "not-a-tree" }));

    const { treeDataAtom } = await freshImport();
    const store = createStore();

    expect(store.get(treeDataAtom)).toEqual([]);
  });

  it("supports functional-updater writes", async () => {
    const { treeDataAtom } = await freshImport();
    const store = createStore();

    store.set(treeDataAtom, [node("a")]);
    store.set(treeDataAtom, (prev) => [...prev, node("b")]);

    expect(store.get(treeDataAtom).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("isolates trees between (workspace, user) scopes", async () => {
    const { treeDataAtom, currentUserAtom } = await freshImport();
    const store = createStore();

    store.set(currentUserAtom, currentUser("w1", "u1"));
    store.set(treeDataAtom, [node("a")]);
    expect(store.get(treeDataAtom).map((n) => n.id)).toEqual(["a"]);

    // Another account on the same browser origin must NOT see u1's tree.
    store.set(currentUserAtom, currentUser("w2", "u2"));
    expect(store.get(treeDataAtom)).toEqual([]);

    store.set(treeDataAtom, [node("b")]);
    expect(store.get(treeDataAtom).map((n) => n.id)).toEqual(["b"]);

    // Switching back resolves the original scope's tree untouched.
    store.set(currentUserAtom, currentUser("w1", "u1"));
    expect(store.get(treeDataAtom).map((n) => n.id)).toEqual(["a"]);
  });

  it("clearPersistedTreeCaches removes all tree keys and discards pending writes", async () => {
    vi.useFakeTimers();

    // Stale caches across scopes plus an UNRELATED key that must survive.
    localStorage.setItem("treeData:v1:a:b", JSON.stringify([node("stale")]));
    localStorage.setItem("openTreeNodes:a:b", JSON.stringify({ p1: true }));
    localStorage.setItem("currentUser", JSON.stringify({ user: { id: "b" } }));

    const { treeDataAtom, clearPersistedTreeCaches } = await freshImport();
    const store = createStore();

    // Queue a debounced write (not flushed yet) for the anon scope.
    store.set(treeDataAtom, [node("pending")]);
    expect(localStorage.getItem(ANON_KEY)).toBeNull();

    clearPersistedTreeCaches();

    // Both prefixed caches are swept; the unrelated key is untouched.
    expect(localStorage.getItem("treeData:v1:a:b")).toBeNull();
    expect(localStorage.getItem("openTreeNodes:a:b")).toBeNull();
    expect(localStorage.getItem("currentUser")).toBe(
      JSON.stringify({ user: { id: "b" } }),
    );

    // The queued write was DISCARDED, not merely delayed: the debounce timer
    // firing later must not resurrect a tree key after logout.
    vi.advanceTimersByTime(DEBOUNCE_MS + 100);
    expect(localStorage.getItem(ANON_KEY)).toBeNull();
  });

  it("clearPersistedTreeCaches discards queued writes even when flushed DIRECTLY", async () => {
    vi.useFakeTimers();

    const { treeDataAtom, clearPersistedTreeCaches, flushPendingTreeDataWrites } =
      await freshImport();
    const store = createStore();

    // Queue a debounced write, then clear. Calling the flush directly (not via
    // the debounce timer) isolates the pending-queue discard from the timer
    // cancel: if the queue survived, this flush would resurrect the key even
    // though the timer never fired.
    store.set(treeDataAtom, [node("pending")]);
    clearPersistedTreeCaches();
    flushPendingTreeDataWrites();

    expect(localStorage.getItem(ANON_KEY)).toBeNull();
    expect(persistedTreeDataKeys()).toEqual([]);
  });

  it("skips persisting a tree over the size cap and warns exactly once", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItemSpy = vi.spyOn(localStorage, "setItem");

    const { treeDataAtom, flushPendingTreeDataWrites } = await freshImport();
    const store = createStore();

    // One node whose name alone serializes to > MAX_SERIALIZED_LENGTH (~4M).
    const huge = node("big");
    huge.name = "x".repeat(4_000_001);

    store.set(treeDataAtom, [huge]);
    vi.advanceTimersByTime(DEBOUNCE_MS + 100);

    // The oversized serialization is skipped: the key is never written.
    expect(localStorage.getItem(ANON_KEY)).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalled();

    // Editing the still-oversized tree fires another debounced write, but the
    // "too large" warn is gated by the once-flag — no per-tick console spam.
    store.set(treeDataAtom, [huge, node("big2")]);
    vi.advanceTimersByTime(DEBOUNCE_MS + 100);
    flushPendingTreeDataWrites();

    expect(localStorage.getItem(ANON_KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[tree] cached tree too large to persist; skipping",
      ANON_KEY,
    );
  });

  it("disables persistence after clearPersistedTreeCaches: NEW writes never reach storage", async () => {
    vi.useFakeTimers();

    const { treeDataAtom, clearPersistedTreeCaches, flushPendingTreeDataWrites } =
      await freshImport();
    const store = createStore();

    clearPersistedTreeCaches();

    // The resurrection scenario: a websocket tree event lands while `await
    // logout()` is still in flight, AFTER the sweep. The write must not be
    // queued, must not arm a new debounce timer, and must not survive the
    // beforeunload flush fired by the logout redirect.
    store.set(treeDataAtom, [node("late")]);

    vi.advanceTimersByTime(DEBOUNCE_MS + 100);
    flushPendingTreeDataWrites(); // what the beforeunload handler runs

    expect(persistedTreeDataKeys()).toEqual([]);

    // Only PERSISTENCE is disabled: the in-memory atom keeps working, so the
    // UI stays intact during the brief pre-redirect window.
    expect(store.get(treeDataAtom).map((n) => n.id)).toEqual(["late"]);
  });
});
