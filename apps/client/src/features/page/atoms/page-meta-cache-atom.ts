import { atom, getDefaultStore, useAtomValue } from "jotai";
import { atomFamily, atomWithStorage, selectAtom } from "jotai/utils";
import { useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { scopeKeyAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom";
import type { IPage } from "@/features/page/types/page.types";
import { isLocalFirstEnabled } from "@/lib/config";
import { isSessionExpired } from "@/features/user/session-verified";
import { reportClientMetric } from "@/lib/telemetry/vitals";
import { httpStatusOf } from "@/lib/http-error";

// Local-first phase 1 (#563): a localStorage BOOT CACHE of page METADATA, so a
// reload / repeat visit paints the page CHROME (title, breadcrumbs, header)
// WITHOUT waiting for that page's `/pages/info` round-trip, then reconciles with
// the server in the background. The BODY (editor/collab) is untouched and keeps
// its current network swap — that is phase 2.
//
// Scope of the win, precisely: the chrome no longer waits on `/pages/info`. It
// does still wait on `/me` — UserProvider renders nothing until the current user
// resolves and it wraps all authenticated routing — so this removes the SECOND
// of two sequential round-trips, not the first. Lifting the `/me` gate (a
// persisted current-user) is a separate change, out of scope for #563.
//
// This is a deliberate CLONE of the sidebar tree boot-cache
// (features/page/tree/atoms/tree-data-atom.ts): same `atomWithStorage` +
// `getOnInit: true` synchronous hydration, same per-(workspace,user) scope key
// (`scopeKeyAtom`), same trailing-debounced writes, same size guard, the same
// persistence kill-switch semantics, and the same logout prefix sweep (its
// `clearPersistedTreeCaches()` also sweeps this prefix). The in-memory atom is
// the source of truth while the app runs; localStorage only seeds the NEXT boot.
//
// TWO deliberate DIVERGENCES from that clone source (both fixes; the tree cache
// still carries the old behavior — see the note in tree-data-atom.ts):
//  1. `getItem` serves a still-pending debounced write instead of the last
//     FLUSHED blob, so a remount inside the debounce window cannot resurrect
//     stale storage and drop the newest entry (tree-data-atom.ts has this bug).
//  2. a FAILED persist (quota / oversize) keeps the value queued, so the
//     in-memory value stays the source of truth and a later onMount re-read
//     cannot clobber it with the older blob still sitting on disk.

// Trailing-debounce for the localStorage writes — a page meta write can fire on
// every query resolve / websocket page.updated echo, so writes are coalesced.
const WRITE_DEBOUNCE_MS = 500;

// Single source of truth for the meta-cache localStorage key prefix. The `v1`
// segment versions the cached entry shape (bump it when PageMetaEntry changes
// incompatibly — an old blob then simply misses and the page falls back to the
// skeleton). Exported so the logout sweep in clearPersistedTreeCaches() removes
// keys by the SAME prefix used to write them.
export const PAGE_META_KEY_PREFIX = "pageMeta:v1:";

// Size guard, same rationale/value as the tree cache: never let the meta blob
// eat the ~5 MB origin quota. Entries are tiny (~200 chars), so this is a
// backstop; MAX_CACHED_PAGES is the practical cap.
const MAX_SERIALIZED_LENGTH = 4_000_000;

// Practical LRU cap on distinct cached pages. Keeps the synchronous boot parse
// cheap (the whole blob is JSON.parse'd before first paint) — a 4M-char blob
// would defeat the very latency this cache exists to remove.
const MAX_CACHED_PAGES = 300;

// Do not rewrite an entry (and thus re-render / re-serialize) just to bump
// `lastAccess` when nothing else changed and the stamp is still fresh.
const LAST_ACCESS_REFRESH_MS = 60_000;

/**
 * The metadata the page CHROME needs — and NOTHING else. Every field here has a
 * reader: `title` + `icon` feed the document title / header, `id` lets the
 * breadcrumb locate the page in the (equally boot-cached) sidebar tree, `slugId`
 * is the second alias, `lastAccess` drives the LRU.
 *
 * Deliberately absent: any PERMISSION data. Edit rights are fail-closed — only a
 * LIVE `/pages/info` response can enable an edit affordance (see page.tsx), so a
 * cached `canEdit` would grant nothing and could only ever be a trap: a
 * permission downgrade produces no 403/404, so nothing would evict it. Storing
 * no authority at all makes that impossible to get wrong.
 * (Also absent: spaceId / spaceSlug / updatedAt — no reader.)
 */
export interface PageMetaEntry {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  /** Epoch ms of the last write-through; drives the LRU eviction. */
  lastAccess: number;
}

/**
 * One blob per scope: `{ [pageId | slugId]: PageMetaEntry }`. A single key (not
 * one key per page) so the cache has ONE shared size cap and one LRU, exactly
 * like the tree cache. Every page is stored under BOTH of its identifiers (uuid
 * and slugId) — mirroring the cross-alias write in page-query.ts — because
 * callers look pages up by either.
 */
export type PageMetaCache = Record<string, PageMetaEntry>;

const EMPTY_CACHE: PageMetaCache = Object.freeze({});

const pendingWrites = new Map<string, PageMetaCache>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writeFailureWarned = false;

// Persistence kill-switch, armed by disablePageMetaPersistence() — which
// clearPersistedTreeCaches() calls, so logout / 401 arms BOTH caches at once.
// Once set, queued and future writes never reach localStorage, so a late
// setQueryData (websocket echo landing while `await logout()` is in flight)
// cannot resurrect a swept key. Never reset: every caller navigates away with a
// full page load. Only PERSISTENCE stops — the in-memory atom keeps working.
let persistenceDisabled = false;

/**
 * Is the cache usable for this scope? Fail-closed on two conditions:
 *  - the operator flag is off (default-off rollout), and
 *  - the scope is not fully resolved yet (`anon` segment): `/me` is async and
 *    login is an SPA nav, so at t0 after a reload `scopeKeyAtom` is
 *    "anon:anon". Reading OR writing real page titles under `anon` would leak
 *    them across accounts on a shared browser, so both are skipped until the
 *    user is known.
 */
function isCacheUsable(scopeKey: string): boolean {
  if (!isLocalFirstEnabled()) return false;
  // #640, part 6 — refuse to draw local chrome once the session is past
  // OFFLINE_GRACE (30d since the last `/me`), offline or not. The boot purge
  // already deleted the blob; this live gate is belt-and-suspenders so nothing
  // repaints stale chrome until a fresh `/me` restamps the session.
  if (isSessionExpired()) return false;
  return !scopeKey.split(":").includes("anon");
}

/**
 * Is the scope resolved enough to DELETE a page's cached meta? (#640, part 7)
 * Deletion of revoked content must bypass the flag check — a revoked page's meta
 * surviving a flag-OFF deploy and resurfacing on flip is the exact inconsistency
 * this fixes. Only the anon scope (no scope to key by) blocks a delete.
 */
function isScopeResolvedForDelete(scopeKey: string): boolean {
  return !scopeKey.split(":").includes("anon");
}

function toEntry(page: Partial<IPage>, now: number): PageMetaEntry {
  return {
    id: page.id!,
    slugId: page.slugId!,
    title: page.title ?? null,
    icon: page.icon ?? null,
    lastAccess: now,
  };
}

/** Entry equality over everything EXCEPT the LRU stamp. */
function sameMeta(a: PageMetaEntry, b: PageMetaEntry): boolean {
  return (
    a.id === b.id &&
    a.slugId === b.slugId &&
    a.title === b.title &&
    a.icon === b.icon
  );
}

/** Distinct pages in the blob (entries are aliased under id AND slugId). */
function distinctEntries(cache: PageMetaCache): PageMetaEntry[] {
  const seen = new Set<string>();
  const entries: PageMetaEntry[] = [];
  for (const entry of Object.values(cache)) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function removeEntry(cache: PageMetaCache, entry: PageMetaEntry): void {
  delete cache[entry.id];
  if (entry.slugId) delete cache[entry.slugId];
}

/**
 * LRU-evict (oldest `lastAccess` first) until the blob is within BOTH caps. The
 * just-written page is never evicted, otherwise a visit could drop the very
 * entry it came to store.
 */
function evictToFit(cache: PageMetaCache, keepId: string): PageMetaCache {
  const isOver = (candidate: PageMetaCache, pageCount: number): boolean => {
    if (pageCount > MAX_CACHED_PAGES) return true;
    try {
      return JSON.stringify(candidate).length > MAX_SERIALIZED_LENGTH;
    } catch {
      return false;
    }
  };

  let pageCount = distinctEntries(cache).length;
  if (!isOver(cache, pageCount)) return cache;

  const next: PageMetaCache = { ...cache };
  // Oldest first; the page we just wrote is never a victim.
  const victims = distinctEntries(next)
    .filter((entry) => entry.id !== keepId)
    .sort((a, b) => a.lastAccess - b.lastAccess);

  while (victims.length > 0 && isOver(next, pageCount)) {
    removeEntry(next, victims.shift()!);
    pageCount -= 1;
  }
  return next;
}

/** @returns true when the value reached localStorage, false on any failure. */
function writeNow(key: string, value: PageMetaCache): boolean {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_SERIALIZED_LENGTH) {
      // Warn once: an oversized blob would otherwise warn on every flush tick.
      if (!writeFailureWarned) {
        writeFailureWarned = true;
        console.warn("[page-meta] cache too large to persist; skipping", key);
      }
      return false;
    }
    localStorage.setItem(key, serialized);
    return true;
  } catch (err) {
    // QuotaExceededError, private mode, jsdom shims without working storage…
    // Best-effort cache: warn once and keep the in-memory atom working.
    if (!writeFailureWarned) {
      writeFailureWarned = true;
      console.warn("[page-meta] failed to persist page meta cache", err);
    }
    return false;
  }
}

/** Exported for tests / the unload hook — production code never needs it. */
export function flushPendingPageMetaWrites(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (persistenceDisabled) {
    pendingWrites.clear();
    return;
  }
  for (const [key, value] of pendingWrites) {
    // A value that FAILED to persist (quota, oversize, storage disabled) stays
    // queued on purpose. Dropping it would leave the OLDER blob on disk as the
    // only record, and the next onMount re-read (`getItem` below) would then
    // serve that older blob back into the in-memory atom — clobbering newer
    // metadata this session already knows. Keeping it queued means `getItem`
    // keeps returning the newest value, so the in-memory atom really is the
    // source of truth, and the next flush retries the write.
    if (writeNow(key, value)) pendingWrites.delete(key);
  }
}

/**
 * Arm the persistence kill-switch and drop anything queued. Called by
 * clearPersistedTreeCaches() (logout + 401 forced logout) BEFORE it sweeps the
 * localStorage keys, so no in-flight debounce can resurrect a swept key.
 */
export function disablePageMetaPersistence(): void {
  persistenceDisabled = true;
  dropPendingPageMetaWrites();
}

/**
 * Drop everything queued WITHOUT arming the kill-switch. Used by the SIGN-IN
 * sweep, which — unlike logout — continues in the same SPA session: freezing
 * persistence there would silently disable the boot cache for the whole session
 * that just started.
 */
export function dropPendingPageMetaWrites(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingWrites.clear();
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener("beforeunload", flushPendingPageMetaWrites);
}

// Custom sync storage. Deliberately NO `subscribe`: cross-tab replacement would
// clobber this tab's in-memory map; each tab keeps its own and localStorage only
// seeds the next boot (same call as the tree cache).
const pageMetaStorage = {
  getItem: (key: string, initialValue: PageMetaCache): PageMetaCache => {
    // jotai re-reads storage in the atom's onMount, not only at init. Writes are
    // trailing-debounced, so a remount inside the debounce window (navigating
    // page A -> page B) would otherwise resurrect the last FLUSHED blob and drop
    // the entry just written for A — which the next write would then persist,
    // losing it for good. Serve the pending value when one is queued: it is by
    // definition newer than what is on disk.
    const pending = pendingWrites.get(key);
    if (pending) return pending;

    // Corrupt JSON, a wrong shape, or a storage-less environment must never
    // throw: degrade to an empty cache (i.e. today's skeleton behavior).
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initialValue;
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return initialValue;
      }
      // Drop anything that isn't a well-formed entry — a half-written or
      // hand-edited blob must not reach the chrome.
      const cache: PageMetaCache = {};
      for (const [alias, entry] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        const candidate = entry as Partial<PageMetaEntry> | null;
        if (
          candidate &&
          typeof candidate === "object" &&
          typeof candidate.id === "string" &&
          typeof candidate.slugId === "string"
        ) {
          cache[alias] = {
            ...(candidate as PageMetaEntry),
            lastAccess:
              typeof candidate.lastAccess === "number"
                ? candidate.lastAccess
                : 0,
          };
        }
      }
      return cache;
    } catch {
      return initialValue;
    }
  },
  setItem: (key: string, newValue: PageMetaCache): void => {
    if (persistenceDisabled) return;
    pendingWrites.set(key, newValue);
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPendingPageMetaWrites, WRITE_DEBOUNCE_MS);
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

// One persisted blob per (workspace, user). `getOnInit: true` reads localStorage
// SYNCHRONOUSLY at atom init, so the FIRST render of the page component already
// has the cached meta — no async storage hop, and therefore no skeleton frame
// while `/pages/info` is in flight. (The page component itself is still mounted
// only after `/me` resolves — see the `/me` gate note at the top of this file.)
const pageMetaFamily = atomFamily((scopeKey: string) =>
  atomWithStorage<PageMetaCache>(
    `${PAGE_META_KEY_PREFIX}${scopeKey}`,
    {},
    pageMetaStorage,
    { getOnInit: true },
  ),
);

/**
 * Read-only view of the current scope's meta cache. Returns an EMPTY map (and
 * never even touches localStorage) when the feature flag is off or the user is
 * not resolved yet — restore is gated exactly like persist.
 */
export const pageMetaCacheAtom = atom<PageMetaCache>((get) => {
  const scopeKey = get(scopeKeyAtom);
  if (!isCacheUsable(scopeKey)) return EMPTY_CACHE;
  return get(pageMetaFamily(scopeKey));
});

/**
 * Write-through: called whenever a page query resolves. Stores the entry under
 * both aliases, refreshes the LRU stamp, and evicts to fit. No-op when the
 * cache is not usable (flag off / anon scope) or the payload lacks identifiers.
 */
export const writePageMetaAtom = atom(
  null,
  (get, set, page: Partial<IPage> | null | undefined) => {
    if (!page?.id || !page?.slugId) return;
    const scopeKey = get(scopeKeyAtom);
    if (!isCacheUsable(scopeKey)) return;

    const target = pageMetaFamily(scopeKey);
    const prev = get(target);
    const now = Date.now();
    const entry = toEntry(page, now);

    const existing = prev[entry.id];
    if (
      existing &&
      sameMeta(existing, entry) &&
      now - existing.lastAccess < LAST_ACCESS_REFRESH_MS &&
      prev[entry.slugId] === existing
    ) {
      // Nothing changed and the LRU stamp is still fresh: skip the write so a
      // content-only churn (typing, collab echoes — they all re-resolve the same
      // page object) doesn't re-render the chrome or thrash localStorage.
      return;
    }

    const next: PageMetaCache = { ...prev };
    next[entry.id] = entry;
    next[entry.slugId] = entry;
    set(target, evictToFit(next, entry.id));
  },
);

/**
 * Evict a page from the cache by ANY of its identifiers (both aliases go).
 * Used by the access/existence reconciliation below — a page the user can no
 * longer see must not paint stale chrome on the next visit.
 */
export const removePageMetaAtom = atom(
  null,
  (get, set, pageIdOrSlugId: string) => {
    const scopeKey = get(scopeKeyAtom);
    // #640, part 7 — bypass the flag gate: a fail-closed DELETE is safe always,
    // and gating it on the flag let a revoked page's meta survive a flag-OFF
    // deploy and resurface on the next flip. Only an unresolved (anon) scope
    // blocks the delete.
    if (!isScopeResolvedForDelete(scopeKey)) return;
    const target = pageMetaFamily(scopeKey);
    const prev = get(target);
    const entry = prev[pageIdOrSlugId];
    if (!entry) return;
    const next = { ...prev };
    removeEntry(next, entry);
    // The key we were given may be neither alias of a well-formed entry.
    delete next[pageIdOrSlugId];
    set(target, next);
  },
);

/**
 * Subscribe the boot cache to page-query FAILURES, globally — independent of
 * which component is mounted. A 403/404 on `["pages", <id|slugId>]` means the
 * page was deleted or access was revoked, so its cached chrome MUST go: the
 * next visit then shows the skeleton (and the not-found state), never stale
 * title/icon. 401 is not handled here — api-client redirects to login and the
 * logout purge wipes the whole cache.
 *
 * Returns the unsubscribe function (tests use it; the app keeps it for life).
 */
export function installPageMetaEviction(queryClient: QueryClient): () => void {
  const store = getDefaultStore();
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const query = event.query;
    if (query.state.status !== "error") return;

    const queryKey = query.queryKey;
    if (
      !Array.isArray(queryKey) ||
      queryKey[0] !== "pages" ||
      typeof queryKey[1] !== "string"
    ) {
      return;
    }

    // #641, part 1 — status via the shared taxonomy. Eviction stays 403/404-ONLY
    // (revoked / deleted); a transport/5xx must never drop cached chrome.
    const status = httpStatusOf(query.state.error);
    if (status !== 403 && status !== 404) return;

    const key = queryKey[1];
    const cached = store.get(pageMetaCacheAtom)[key];
    store.set(removePageMetaAtom, key);
    if (cached) reportClientMetric("page_meta_evict", 1);
  });
}

/**
 * Synchronously read a page's cached meta for the current scope. `undefined`
 * means a cache miss — the caller falls back to today's network/skeleton path.
 */
export function useCachedPageMeta(
  pageIdOrSlugId: string | null | undefined,
): PageMetaEntry | undefined {
  const entryAtom = useMemo(
    () =>
      selectAtom(pageMetaCacheAtom, (cache: PageMetaCache) =>
        pageIdOrSlugId ? cache[pageIdOrSlugId] : undefined,
      ),
    [pageIdOrSlugId],
  );
  return useAtomValue(entryAtom);
}

/**
 * Edit-rights rule for the page chrome and body. Only ever applied to a LIVE
 * page: the boot cache stores no permissions, so an unresolved query yields
 * `false` (fail-closed) — the chrome paints, the edit affordances wait.
 */
export function derivePageChromeCanEdit(
  page: Pick<IPage, "deletedAt" | "permissions"> | null | undefined,
): boolean {
  if (!page) return false;
  return !page.deletedAt && (page.permissions?.canEdit ?? false);
}
