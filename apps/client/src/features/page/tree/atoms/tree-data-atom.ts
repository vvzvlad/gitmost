import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import { SpaceTreeNode } from "@/features/page/tree/types";
import { appendNodeChildren } from "../utils";
import {
  OPEN_TREE_NODES_KEY_PREFIX,
  scopeKeyAtom,
} from "./open-tree-nodes-atom";
import {
  PAGE_META_KEY_PREFIX,
  disablePageMetaPersistence,
  dropPendingPageMetaWrites,
} from "@/features/page/atoms/page-meta-cache-atom";

// The sidebar tree is persisted to localStorage so a page reload can paint the
// last-known tree IMMEDIATELY (no blank sidebar while the root query runs) and
// then reconcile with the server in the background. localStorage is a BOOT
// CACHE only — the in-memory atom stays the source of truth while the app runs.

// Trailing-debounce machinery for the localStorage writes. The tree is
// rewritten on every lazy load / drag / socket event; serializing a large tree
// on each update would burn CPU and thrash the storage quota, so writes are
// coalesced (~500 ms per burst) and only the latest value per key is flushed.
const WRITE_DEBOUNCE_MS = 500;

// Single source of truth for the tree-cache localStorage key prefix. The `v1`
// segment versions the cached node shape (bump it when SpaceTreeNode changes
// incompatibly). Shared by the storage key construction below AND the logout
// sweep in clearPersistedTreeCaches() so the two can never drift apart.
export const TREE_DATA_KEY_PREFIX = "treeData:v1:";

// Size guard: skip persisting trees whose JSON exceeds ~4M chars. localStorage
// quota is typically ~5 MB per origin; a huge tree must not evict everything
// else or spam QuotaExceededError on every debounce tick.
const MAX_SERIALIZED_LENGTH = 4_000_000;

const pendingWrites = new Map<string, SpaceTreeNode[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writeFailureWarned = false;

// Persistence kill-switch, armed by clearPersistedTreeCaches(). Once set, the
// debounced setItem and the flush become no-ops so nothing can be written back
// to localStorage AFTER the logout sweep: a websocket tree event landing while
// `await logout()` is still in flight would otherwise re-queue a write that
// the `beforeunload` flush (fired by the redirect) silently resurrects.
// Intentionally never reset: every caller of clearPersistedTreeCaches()
// immediately navigates away with a full page load
// (window.location.replace/href), so this module instance is torn down anyway.
// Only PERSISTENCE stops — the in-memory atoms keep working, so the UI stays
// intact during the brief pre-redirect window.
let persistenceDisabled = false;

function writeNow(key: string, value: SpaceTreeNode[]): void {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_SERIALIZED_LENGTH) {
      // Warn ONCE, like the quota branch below: a >4M-char tree re-serializes on
      // every ~500ms debounce tick while it's edited, so an un-gated warn would
      // spam the console on each flush.
      if (!writeFailureWarned) {
        writeFailureWarned = true;
        console.warn("[tree] cached tree too large to persist; skipping", key);
      }
      return;
    }
    localStorage.setItem(key, serialized);
  } catch (err) {
    // QuotaExceededError, private mode, jsdom shims without working storage…
    // The cache is best-effort: warn once, keep the in-memory tree working.
    if (!writeFailureWarned) {
      writeFailureWarned = true;
      console.warn("[tree] failed to persist tree cache", err);
    }
  }
}

// Exported so tests can force the debounced write synchronously; production
// code must never need it (the beforeunload hook below covers reloads).
export function flushPendingTreeDataWrites(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (persistenceDisabled) {
    // Belt-and-braces: after logout nothing may reach localStorage, even via
    // the beforeunload flush racing the redirect. Drop anything queued.
    pendingWrites.clear();
    return;
  }
  for (const [key, value] of pendingWrites) {
    writeNow(key, value);
  }
  pendingWrites.clear();
}

// Logout hygiene: the tree cache stores PAGE TITLES, so leaving it behind
// would keep them readable in localStorage on a shared machine after logout.
// Sweep by key prefix (not just the current scope) so stale scopes — old
// users, the `anon:anon` fallback — are purged too. Pending debounced writes
// are DISCARDED first (not flushed): a queued write firing after the sweep
// would silently resurrect a removed key.
//
// The page-meta boot cache (#563) stores titles/icons too and shares this exact
// lifecycle, so it is swept by the SAME function (covering all call sites — the
// logout button and the SIGN-IN in use-auth.ts, and the 401 forced logout in
// api-client.ts).
//
// `freezeWrites` (default true) additionally arms both caches' persistence
// kill-switch, so nothing can be written back AFTER the sweep. That is correct
// for LOGOUT, where every caller immediately does a full-page navigation and
// tears this module down. SIGN-IN must pass `false`: it continues in the same
// SPA session (`navigate()`, no reload), so freezing would leave both boot caches
// unable to persist anything for the entire session the user just started.
export function clearPersistedTreeCaches(options?: {
  freezeWrites?: boolean;
}): void {
  const freezeWrites = options?.freezeWrites ?? true;
  // Disable persistence FIRST so no write can be queued (or flushed) between
  // the sweep below and the full-page navigation every logout caller performs.
  if (freezeWrites) {
    persistenceDisabled = true;
    disablePageMetaPersistence();
  } else {
    dropPendingPageMetaWrites();
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingWrites.clear();
  try {
    // Collect matching keys BEFORE removing: deleting while iterating
    // `localStorage.key(i)` shifts the indices and skips entries.
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key !== null &&
        (key.startsWith(TREE_DATA_KEY_PREFIX) ||
          key.startsWith(OPEN_TREE_NODES_KEY_PREFIX) ||
          key.startsWith(PAGE_META_KEY_PREFIX))
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // Best-effort: disabled storage / jsdom shims must never break logout.
  }
}

// Flush the pending debounced write on unload so a reload right after a tree
// change doesn't lose the newest state (the debounce would otherwise eat it).
if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener("beforeunload", flushPendingTreeDataWrites);
}

// Custom sync storage for the tree cache. Deliberately NO `subscribe` key:
// cross-tab sync would REPLACE this tab's tree wholesale and clobber in-flight
// lazy loads; websockets already keep every open tab live. Each tab keeps its
// own in-memory tree — localStorage only seeds the next boot.
const treeDataStorage = {
  // KNOWN LATENT BUG (not fixed here — behavior predates #563 and a tree write is
  // idempotently repaired by the next tree event / root refetch, so the blast
  // radius is a stale sidebar rather than lost data): this `getItem` reads only
  // what was FLUSHED to localStorage, ignoring `pendingWrites`. jotai re-reads
  // storage in the atom's onMount — i.e. every time the first subscriber mounts,
  // not just at init — so a sidebar remount INSIDE the 500 ms debounce window
  // resurrects the last flushed blob and silently drops the queued write.
  // Likewise, a write that FAILED to persist (quota/oversize) is dropped from the
  // queue by flushPendingTreeDataWrites() below, after which the next onMount
  // re-read serves the older on-disk blob back over the newer in-memory tree —
  // contradicting the "in-memory atom is the source of truth" claim above.
  // The page-meta boot cache (page-meta-cache-atom.ts) fixes BOTH in its own
  // storage adapter; porting the fix here needs its own tests (follow-up issue).
  getItem: (key: string, initialValue: SpaceTreeNode[]): SpaceTreeNode[] => {
    // Defensive: jsdom test shims may lack methods, stored JSON may be
    // corrupted or of a wrong shape. Any failure falls back to the empty tree.
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initialValue;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SpaceTreeNode[]) : initialValue;
    } catch {
      return initialValue;
    }
  },
  setItem: (key: string, newValue: SpaceTreeNode[]): void => {
    // After logout the cache must stay purged: neither queue the write nor arm
    // a new flush timer (see persistenceDisabled above). The in-memory atom
    // value is unaffected — only the localStorage mirror is frozen.
    if (persistenceDisabled) return;
    pendingWrites.set(key, newValue);
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPendingTreeDataWrites, WRITE_DEBOUNCE_MS);
  },
  removeItem: (key: string): void => {
    pendingWrites.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      /* best-effort cache — ignore */
    }
  },
};

// One persisted tree per (workspace, user) — same scoping rationale as the
// open-map atom (accounts sharing a browser origin must not leak trees).
// `getOnInit: true` reads localStorage synchronously at atom init, so the very
// first render already has the cached tree — no blank-then-jump sidebar.
const treeDataFamily = atomFamily((scopeKey: string) =>
  atomWithStorage<SpaceTreeNode[]>(
    `${TREE_DATA_KEY_PREFIX}${scopeKey}`,
    [],
    treeDataStorage,
    { getOnInit: true },
  ),
);

// Public facade — same read value (SpaceTreeNode[]) and same setter shape
// (value OR functional updater) as the previous in-memory atom, transparently
// routed to the persisted tree of the current workspace/user.
export const treeDataAtom = atom(
  (get) => get(treeDataFamily(get(scopeKeyAtom))),
  (
    get,
    set,
    update: SpaceTreeNode[] | ((prev: SpaceTreeNode[]) => SpaceTreeNode[]),
  ) => {
    const target = treeDataFamily(get(scopeKeyAtom));
    const next =
      typeof update === "function"
        ? (update as (prev: SpaceTreeNode[]) => SpaceTreeNode[])(get(target))
        : update;
    set(target, next);
  },
);

// Atom
export const appendNodeChildrenAtom = atom(
  null,
  (
    get,
    set,
    { parentId, children }: { parentId: string; children: SpaceTreeNode[] }
  ) => {
    const currentTree = get(treeDataAtom);
    const updatedTree = appendNodeChildren(currentTree, parentId, children);
    set(treeDataAtom, updatedTree);
  }
);
