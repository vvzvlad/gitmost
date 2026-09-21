import { getDefaultStore } from "jotai";
import type { QueryClient } from "@tanstack/react-query";
import type { IndexeddbPersistence } from "y-indexeddb";
import { PAGE_META_KEY_PREFIX } from "@/features/page/atoms/page-meta-cache-atom";
import { scopeKeyAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom";
import { deleteYdocDatabase } from "@/features/editor/page-ydoc-delete";
import {
  addTombstones,
  removeTombstones,
} from "@/features/editor/page-ydoc-tombstones";
import { reportSafetyMetric } from "@/lib/telemetry/safety-metrics";
import { httpStatusOf } from "@/lib/http-error";
import { canOpenLocalYdoc } from "@/features/editor/page-ydoc-tombstones";
import { isSessionExpired } from "@/features/user/session-verified";

/**
 * Fail-closed hygiene of a page's LOCAL body ydoc (#564 guard 3, #626, #640).
 *
 * With local-first on, the body is painted from the local ydoc BEFORE the
 * network answers. If access was meanwhile lost (or the page deleted), the page
 * query answers 403/404 and the page renders not-found — but the content would
 * still be sitting in IndexedDB and would flash again on the next visit. The
 * collab path cannot help: an unauthorized room never syncs, so it can never
 * "correct" the local copy. So on ANY page query failing with 403/404 we
 * TOMBSTONE the page (so the next visit opens no local persistence at all) and
 * destroy its local ydoc database.
 *
 * The MAIN scenario is a page never mounted in this session: a fresh tab /
 * reload / bookmark straight onto a page whose access was revoked. The editor
 * never mounts there (not-found renders instead), so BOTH halves of this module
 * are mount-independent:
 *  - the subscriber is installed at APP level (main.tsx), not from the editor;
 *  - the `slugId -> pageId` alias is resolved from the PERSISTED #563 page-meta
 *    boot cache (which stores every page under both aliases), not only from the
 *    session-scoped map a successful mount populates.
 */

/**
 * Prefix shared by EVERY page-body ydoc IndexedDB database. The namespacing
 * below, the enumeration-based purge, the Firefox registry fallback, and the
 * legacy migration all key off this single constant so they can never drift
 * apart.
 */
export const PAGE_YDOC_PREFIX = "page.";

/**
 * The y-indexeddb DATABASE name for a page's body — NAMESPACED BY SCOPE (#626).
 *
 * ⚠️ DB name ≠ collab room name (#640, invariant 1). This is used ONLY for
 * `IndexeddbPersistence`, eviction, tombstones and purge. The collab ROOM name
 * is `pageYdocRoomName(pageId)` = `page.<pageId>` and MUST stay un-namespaced:
 * the server resolves the page from the room name via
 * `documentName.split('.')[1]` (collaboration.util.getPageId), so a namespaced
 * room name would resolve to the workspaceId instead of the pageId and break
 * auth + persistence on EVERY collab connection.
 *
 * The DB name embeds the same `<workspace>:<user>` scope key the tree/meta boot
 * caches use (`scopeKeyAtom`, the #563 mechanism), yielding
 * `page.<scopeKey>.<pageId>`, so two scopes get two distinct databases and a
 * shared browser never serves one user's local body to another.
 *
 * Fail-closed for anon: a signed-out / not-yet-resolved state resolves the scope
 * to `anon:anon`. Real ids are uuids and never the literal "anon", so an anon
 * name can never collide with a real user's. The editor only opens local
 * persistence once the scope is resolved (see the anon guard in page-editor and
 * the eviction queue below).
 */
export function pageYdocDbName(scopeKey: string, pageId: string): string {
  return `${PAGE_YDOC_PREFIX}${scopeKey}.${pageId}`;
}

/**
 * The collaboration ROOM name for a page — MUST stay `page.<pageId>` with NO
 * scope namespace, and is DISTINCT from the IndexedDB database name above.
 *
 * The server resolves the page from the room name with
 * `getPageId(documentName) = documentName.split('.')[1]`
 * (apps/server/src/collaboration/collaboration.util.ts). A scope-namespaced room
 * name (`page.<scopeKey>.<pageId>`) makes `split('.')[1]` return the SCOPE, not
 * the pageId → the collab server can't find the page → every authenticated
 * collab connection is rejected (regression introduced by #626 wiring the
 * namespaced db name straight into HocuspocusProvider.name). Local-content
 * isolation lives entirely in the IndexedDB DB name (pageYdocDbName); the room
 * name must never carry the scope. It is the SAME room name the MCP agent opens
 * (`page.<uuid>`), so a scoped name also split the human editor and the agent into
 * different rooms. Locked on both sides: the room-name construction here by
 * page-ydoc-eviction.test.ts, and the server getPageId contract by
 * collaboration.util.spec.ts.
 */
export function pageYdocRoomName(pageId: string): string {
  return `${PAGE_YDOC_PREFIX}${pageId}`;
}

// Query keys are `["pages", <pageId | slugId>]`, while the ydoc DB is named by
// pageId. Aliases seen in THIS session (a mounted page), used ahead of the
// persisted boot cache: the boot cache is scope-gated (empty until `/me`
// resolves) and its writes are debounced, so this map is the immediate,
// always-correct source for pages this session actually opened.
// Bounded (#564 F9): an unbounded map would grow for every page visited.
const MAX_SESSION_ALIASES = 500;
const ydocNameByQueryKey = new Map<string, string>();
// Live persistences, by DB name. Cleared on unmount.
const livePersistences = new Map<string, IndexeddbPersistence>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAnonScope(scopeKey: string): boolean {
  return scopeKey.split(":").includes("anon");
}

function rememberAlias(key: string, dbName: string): void {
  ydocNameByQueryKey.delete(key);
  ydocNameByQueryKey.set(key, dbName);
  while (ydocNameByQueryKey.size > MAX_SESSION_ALIASES) {
    const oldest = ydocNameByQueryKey.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    ydocNameByQueryKey.delete(oldest);
  }
}

export function registerPageYdoc(opts: {
  dbName: string;
  persistence: IndexeddbPersistence;
  keys: (string | undefined | null)[];
}): void {
  livePersistences.set(opts.dbName, opts.persistence);
  for (const key of opts.keys) {
    if (key) rememberAlias(key, opts.dbName);
  }
}

/** Drop the live-persistence reference (the component is unmounting). */
export function unregisterPageYdoc(dbName: string): void {
  livePersistences.delete(dbName);
}

/** Test-only: forget every registration (including the install latch + queue). */
export function resetPageYdocRegistryForTests(): void {
  ydocNameByQueryKey.clear();
  livePersistences.clear();
  pendingEvictions.clear();
  installed = false;
  scopeDrainInstalled = false;
}

/**
 * Map a `["pages", id]` query-key id to the page's ydoc DATABASE name, using the
 * given scope. Three sources, in order of authority:
 *  1. this session's alias map (a page opened here — always exact);
 *  2. the PERSISTED #563 page-meta boot cache (every page under BOTH aliases);
 *  3. a bare uuid, which IS the pageId by construction.
 * A slugId in none of them addresses a page this device never opened.
 */
function resolveYdocName(queryKeyId: string, scopeKey: string): string | null {
  const known = ydocNameByQueryKey.get(queryKeyId);
  if (known) return known;

  // Read the RAW page-meta blob, NOT the flag-gated `pageMetaCacheAtom` (which
  // returns empty when LOCAL_FIRST is off): deleting revoked content must work
  // regardless of the flag (#640, part 7 / acceptance 10).
  const cached = rawMetaEntry(scopeKey, queryKeyId);
  if (cached?.id) return pageYdocDbName(scopeKey, cached.id);

  return UUID_RE.test(queryKeyId) ? pageYdocDbName(scopeKey, queryKeyId) : null;
}

/**
 * Read a single page-meta entry for a scope straight from the RAW localStorage
 * blob (bypassing the flag-gated atom). Used by eviction/tombstoning so a
 * flag-OFF deploy still resolves `slugId -> pageId` and deletes revoked content.
 */
function rawMetaEntry(
  scopeKey: string,
  key: string,
): { id?: string; slugId?: string } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(`${PAGE_META_KEY_PREFIX}${scopeKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const entry = (parsed as Record<string, unknown>)[key];
    return (entry as { id?: string; slugId?: string }) ?? null;
  } catch {
    return null;
  }
}

/**
 * Every DB-name ALIAS a 403/404 on `queryKeyId` should tombstone (#640,
 * invariant 6). A 403/404 arrives on `["pages", <id | slugId>]`; the DB is
 * created under the pageId-derived name, but the construction gate also checks
 * the slugId-derived name, so we tombstone BOTH — otherwise a slugId-403 whose
 * pageId cannot be resolved (meta miss) fails OPEN.
 */
function tombstoneAliasNames(queryKeyId: string, scopeKey: string): string[] {
  const names = new Set<string>();
  // The raw query-key id (could be a uuid or a slugId): tombstone it as-is so the
  // construction gate's slugId-derived check matches even on a meta miss.
  names.add(pageYdocDbName(scopeKey, queryKeyId));
  const cached = rawMetaEntry(scopeKey, queryKeyId);
  if (cached?.id) names.add(pageYdocDbName(scopeKey, cached.id));
  if (cached?.slugId) names.add(pageYdocDbName(scopeKey, cached.slugId));
  return [...names];
}

// #640, invariant 2 — anon-scope eviction QUEUE. A 403/404 that lands while the
// scope is unresolved (`anon`) must NOT compute a `page.anon:anon.<id>` name
// (which matches no real database) and falsely report success. Queue the id and
// re-run once the scope resolves.
const pendingEvictions = new Set<string>();
// Rule #1 size budget. The anon window (before `/me` resolves) is short and
// normally sees 0-1 revocations, so this cap is a backstop, never the normal
// path; a pathological pre-auth burst stops queueing past it rather than growing
// unbounded (the already-queued ids still drain + tombstone on scope-resolve).
const MAX_PENDING_EVICTIONS = 1000;

/**
 * Destroy the local ydoc for the page addressed by a `["pages", id]` query key,
 * and TOMBSTONE it so the next visit opens no local persistence at all.
 * Returns true when something was targeted; false when queued (anon scope) or
 * when the id addresses no local ydoc.
 */
export async function evictPageYdoc(queryKeyId: string): Promise<boolean> {
  const scopeKey = getDefaultStore().get(scopeKeyAtom);
  if (isAnonScope(scopeKey)) {
    // Fail-closed: do not delete anything under an anon scope (it would target a
    // non-existent database and falsely succeed). Queue until the scope resolves.
    if (pendingEvictions.size < MAX_PENDING_EVICTIONS) {
      pendingEvictions.add(queryKeyId);
    }
    return false;
  }

  // Tombstone FIRST (under both aliases) so that even if the delete below is
  // blocked, the next visit still opens no local persistence.
  addTombstones(tombstoneAliasNames(queryKeyId, scopeKey));

  const dbName = resolveYdocName(queryKeyId, scopeKey);
  if (!dbName) return false;

  const persistence = livePersistences.get(dbName);
  livePersistences.delete(dbName);
  ydocNameByQueryKey.delete(queryKeyId);

  if (persistence) {
    try {
      // clearData() destroys the persistence AND deletes the IDB database.
      await persistence.clearData();
      return true;
    } catch {
      // fall through to the raw delete below
    }
  }
  await deleteYdocDatabase(dbName);
  return true;
}

/**
 * A SUCCESSFUL `["pages", x]` proves access returned (page restored from trash /
 * access regranted). Lift the tombstone under both aliases so the local cache
 * works again (#640, invariant 7 / acceptance 5). This is the ONLY tombstone
 * removal path: never by age or LRU. Called at the meta-cache write-through
 * point (page-query.ts), the same place the meta cache reconciles.
 */
export function clearPageTombstoneOnAccess(page: {
  id?: string;
  slugId?: string;
}): void {
  const scopeKey = getDefaultStore().get(scopeKeyAtom);
  if (isAnonScope(scopeKey)) return;
  const names: string[] = [];
  if (page.id) names.push(pageYdocDbName(scopeKey, page.id));
  if (page.slugId) names.push(pageYdocDbName(scopeKey, page.slugId));
  if (names.length) removeTombstones(names);
}

let installed = false;
let scopeDrainInstalled = false;

/**
 * Subscribe ydoc eviction to page-query FAILURES, globally and independently of
 * what is mounted. Installed ONCE at app level (main.tsx): the revoked-page case
 * this exists for never mounts the page editor at all.
 *
 * NOT gated on the local-first flag (#640, part 7): deleting revoked content is
 * not an experiment. "Rollback = flag flip" therefore no longer restores the old
 * behavior — a flag-OFF deploy now deletes revoked ydoc databases it did not
 * touch before. See the PR description.
 *
 * ORDERING (load-bearing): this must be installed BEFORE #563's
 * `installPageMetaEviction`, because that subscriber DELETES the page-meta entry
 * this one resolves the `slugId -> pageId` alias from.
 */
export function installPageYdocEviction(queryClient: QueryClient): () => void {
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

    // #641, part 1 — read the status through the shared taxonomy. Eviction stays
    // 403/404-ONLY (revoked / deleted): a 401 redirects + purges everything, and
    // a transport/5xx must NEVER evict local content (that is the whole point of
    // Ф5). Semantics unchanged; only the status extraction is unified.
    const status = httpStatusOf(query.state.error);
    if (status !== 403 && status !== 404) return;

    void evictPageYdoc(queryKey[1]);
  });
}

/**
 * Drain the anon-scope eviction queue once the scope resolves (#640, invariant
 * 2). Installed once at app level; subscribes to `scopeKeyAtom` and re-runs any
 * queued eviction the moment a real (workspace, user) scope is in hand.
 */
export function installYdocScopeResolveDrain(): () => void {
  if (scopeDrainInstalled) return () => undefined;
  scopeDrainInstalled = true;
  const store = getDefaultStore();
  const unsub = store.sub(scopeKeyAtom, () => {
    const scopeKey = store.get(scopeKeyAtom);
    if (isAnonScope(scopeKey)) return;
    if (pendingEvictions.size === 0) return;
    const queued = [...pendingEvictions];
    pendingEvictions.clear();
    for (const id of queued) void evictPageYdoc(id);
  });
  return () => {
    scopeDrainInstalled = false;
    unsub();
  };
}

/** Test-only: drain the pending-eviction queue for the current scope. */
export async function flushPendingYdocEvictionsForTests(): Promise<void> {
  const queued = [...pendingEvictions];
  pendingEvictions.clear();
  for (const id of queued) await evictPageYdoc(id);
}

/** Install once per app session (idempotent). */
export function installPageYdocEvictionOnce(queryClient: QueryClient): void {
  if (installed) return;
  installed = true;
  installPageYdocEviction(queryClient);
  installYdocScopeResolveDrain();
  installYdocPurgeBroadcastListener();
}

// ---------------------------------------------------------------------------
// #626 / #640 — cross-user hygiene for the page-body ydoc databases.
// ---------------------------------------------------------------------------

// Firefox does NOT implement `indexedDB.databases()`, so enumeration-based purge
// cannot see the ydoc databases there. We keep a best-effort registry of the
// ydoc DB names this browser has opened (in localStorage) so the purge can still
// delete them by name on Firefox. Enumeration remains the primary path where it
// exists; the registry is a superset-covering fallback.
const YDOC_DB_REGISTRY_KEY = "pageYdoc.dbNames.v1";
const MAX_REGISTRY_ENTRIES = 500;

function readYdocDbRegistry(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(YDOC_DB_REGISTRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is string => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Record a ydoc database name so the Firefox purge fallback can find it later.
 * Called by page-editor when it opens the local persistence. No-op for names
 * that aren't ours, and never throws (storage may be disabled/full).
 */
export function rememberYdocDbName(name: string): void {
  if (!name.startsWith(PAGE_YDOC_PREFIX)) return;
  try {
    if (typeof localStorage === "undefined") return;
    const names = readYdocDbRegistry().filter((n) => n !== name);
    names.push(name);
    while (names.length > MAX_REGISTRY_ENTRIES) names.shift();
    localStorage.setItem(YDOC_DB_REGISTRY_KEY, JSON.stringify(names));
  } catch {
    // best-effort registry — the namespacing is the real defense
  }
}

function clearYdocDbRegistry(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(YDOC_DB_REGISTRY_KEY);
  } catch {
    // ignore
  }
}

/**
 * Was a page's ydoc DB name recorded in this browser's registry? A hit proves
 * the local body was opened (and, if non-empty, written) on this device at least
 * once. (#641, part 7.)
 */
function ydocDbNameKnown(name: string): boolean {
  return readYdocDbRegistry().includes(name);
}

/**
 * Best-effort SYNCHRONOUS check: is there a usable LOCAL body ydoc for this page?
 *
 * page.tsx uses it (#641, part 7) to choose, WITHOUT an async IndexedDB open,
 * between rendering the cached body offline and the explicit "not available
 * offline" empty-state. Fail-closed:
 *  - anon / unresolved scope, or a session past OFFLINE_GRACE → no local body;
 *  - tombstoned under either alias (access revoked, Ф4) → no local body;
 *  - the ydoc DB was never opened here (not in the registry) → the page is in the
 *    boot META cache but its BODY was never written on this device (the exact
 *    part-7 case: a link/tree entry cached the chrome, the body never loaded).
 *
 * A registry hit whose IndexedDB the browser later evicted (Safari) is a
 * tolerated false-positive: the editor then shows an empty body instead of the
 * empty-state — no worse than today, and not an eternal silent skeleton because
 * the offline banner still explains the state.
 */
export function hasLocalPageBody(
  scopeKey: string,
  pageId: string,
  slugId?: string | null,
): boolean {
  if (isAnonScope(scopeKey)) return false;
  if (isSessionExpired()) return false;
  const dbName = pageYdocDbName(scopeKey, pageId);
  if (!canOpenLocalYdoc(dbName)) return false;
  const aliasName = pageYdocDbName(scopeKey, slugId ?? pageId);
  if (!canOpenLocalYdoc(aliasName)) return false;
  return ydocDbNameKnown(dbName) || ydocDbNameKnown(aliasName);
}

/**
 * A ydoc database name is LEGACY (pre-#626) when it is un-namespaced:
 * `page.<pageId>` (no `:` after the prefix — a namespaced name always embeds the
 * `<workspace>:<user>` scope key, which always contains a `:`). Scope-
 * independent, so the migration can never mistake the CURRENT user's freshly-
 * namespaced database for a legacy one.
 */
function isLegacyYdocName(name: string): boolean {
  if (!name.startsWith(PAGE_YDOC_PREFIX)) return false;
  return !name.slice(PAGE_YDOC_PREFIX.length).includes(":");
}

// #640, part 4 — cross-tab purge signalling. A `deleteDatabase` is a silent
// no-op while ANOTHER tab holds the database open, so before deleting we ask
// every live tab to close its ydocs. Guarded: BroadcastChannel is absent in some
// environments (older Safari / jsdom without a shim).
const PURGE_CHANNEL = "gitmost-ydoc-purge";
let purgeChannel: BroadcastChannel | null = null;

function getPurgeChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (purgeChannel) return purgeChannel;
  try {
    purgeChannel = new BroadcastChannel(PURGE_CHANNEL);
  } catch {
    purgeChannel = null;
  }
  return purgeChannel;
}

/** Close every live persistence in THIS tab so a delete elsewhere isn't blocked. */
function closeLivePersistencesInThisTab(): void {
  for (const persistence of livePersistences.values()) {
    try {
      persistence.destroy();
    } catch {
      // best-effort — a tab that cannot close its handle will show up as a
      // blocked delete (metered) rather than silently.
    }
  }
  livePersistences.clear();
}

/**
 * Install the cross-tab listener: when ANOTHER tab purges, close this tab's
 * ydocs so its `deleteDatabase` is not blocked. Idempotent.
 */
export function installYdocPurgeBroadcastListener(): void {
  const channel = getPurgeChannel();
  if (!channel) return;
  channel.onmessage = (event: MessageEvent) => {
    if (event?.data?.type === "purge") closeLivePersistencesInThisTab();
  };
}

/**
 * Purge EVERY `page.`-prefixed ydoc IndexedDB database of this scope, AWAITABLE
 * (#640, part 4). Called on logout / 401 / sign-in / session-boundary, so one
 * user's local page bodies never survive into another user's session.
 *
 *  1. broadcast "close your ydocs" to other tabs (so their handles release and
 *     our deletes aren't blocked) and close this tab's live persistences;
 *  2. delete every registry-known name (Firefox-safe, synchronous discovery);
 *  3. additionally sweep `indexedDB.databases()` where it exists;
 *  4. AWAIT all deletions — the call-sites redirect right after, so without the
 *     await the deletion never finishes;
 *  5. blocked / errored deletions are counted to an ALWAYS-ON safety metric (in
 *     `deleteYdocDatabase`), never a bare console.warn.
 * Never throws; a purge that could not even start is metered as a failure.
 */
export async function purgePageYdocDatabases(): Promise<void> {
  if (typeof indexedDB === "undefined") return;

  try {
    // 1. Ask other tabs (and this one) to release their IDB handles first.
    try {
      getPurgeChannel()?.postMessage({ type: "purge" });
    } catch {
      // best-effort broadcast
    }
    closeLivePersistencesInThisTab();

    const deletions: Promise<void>[] = [];

    // 2. Registry-driven, Firefox-safe.
    for (const name of readYdocDbRegistry()) {
      if (name.startsWith(PAGE_YDOC_PREFIX)) deletions.push(deleteYdocDatabase(name));
    }
    clearYdocDbRegistry();

    // 3. Enumeration-driven, best-effort (unsupported in Firefox → skipped).
    if (typeof indexedDB.databases === "function") {
      try {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name && db.name.startsWith(PAGE_YDOC_PREFIX)) {
            deletions.push(deleteYdocDatabase(db.name));
          }
        }
      } catch {
        // enumeration failed at runtime — the registry path already ran
      }
    }

    // 4. Await completion so the caller's redirect does not cut deletion short.
    await Promise.all(deletions);
  } catch (err) {
    reportSafetyMetric("ydoc_purge_failed", err);
  }
}

/**
 * Every pageId/slugId held in the RAW #563 page-meta boot-cache blobs across all
 * scopes. Scans localStorage directly (not the flag-gated atom) so the legacy
 * migration can derive `page.<id>` names even with LOCAL_FIRST off.
 */
function legacyPageIdsFromMetaBlobs(): Set<string> {
  const ids = new Set<string>();
  try {
    if (typeof localStorage === "undefined") return ids;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(PAGE_META_KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      for (const entry of Object.values(parsed as Record<string, unknown>)) {
        const e = entry as { id?: unknown; slugId?: unknown } | null;
        if (e && typeof e.id === "string") ids.add(e.id);
        if (e && typeof e.slugId === "string") ids.add(e.slugId);
      }
    }
  } catch {
    // corrupt / disabled storage — enumeration path still covers Chrome/Safari
  }
  return ids;
}

// One-time legacy migration guard. `v1` so a future re-migration can bump it.
const YDOC_MIGRATION_FLAG = "pageYdoc.legacyPurged.v1";

/**
 * ONE-TIME migration (#626 / #640, part 8): on the first launch of the
 * namespaced build, delete the legacy un-namespaced `page.<pageId>` databases
 * left by earlier versions. The body is authoritative on the server; the local
 * ydoc is only a cache, so dropping it is safe (it re-hydrates from collab).
 *
 * TWO discovery sources, because after the rename NOTHING lists the legacy names
 * on Firefox otherwise:
 *  - `indexedDB.databases()` where it exists (Chrome/Safari);
 *  - the #563 page-meta boot cache, which holds EVERY cached pageId under both
 *    aliases — so we can derive `page.<pageId>` legacy names and delete them by
 *    name even on Firefox. This MUST run BEFORE the meta cache is swept
 *    (main.tsx installs it at boot, before any logout).
 *
 * Guarded by a localStorage flag so it runs exactly once. It only deletes
 * databases whose name does NOT match the new `page.<scope>.<pageId>` shape, so
 * the current user's freshly-namespaced databases are never touched.
 */
export function migratePageYdocDatabasesOnce(): void {
  if (typeof indexedDB === "undefined") return;

  let alreadyRun = false;
  try {
    alreadyRun =
      typeof localStorage !== "undefined" &&
      localStorage.getItem(YDOC_MIGRATION_FLAG) === "1";
  } catch {
    // Storage unreadable → cannot record the run, so skip to avoid re-sweeping
    // on every boot. The prefix purge still covers legacy DBs on logout/sign-in.
    return;
  }
  if (alreadyRun) return;

  const markDone = () => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(YDOC_MIGRATION_FLAG, "1");
      }
    } catch {
      // best-effort — nothing else to do
    }
  };

  // Meta-cache-derived legacy names (Firefox-safe). Every cached pageId/slugId
  // yields a candidate legacy `page.<id>` name; a delete of a non-existent db is
  // a harmless no-op, so we need not know which actually exist. Read the RAW
  // localStorage blobs (not the flag-gated `pageMetaCacheAtom`, which returns
  // empty when LOCAL_FIRST is off — the default): legacy databases must be
  // removed regardless of the flag (#640, part 7/8).
  for (const id of legacyPageIdsFromMetaBlobs()) {
    void deleteYdocDatabase(`${PAGE_YDOC_PREFIX}${id}`);
  }

  if (typeof indexedDB.databases !== "function") {
    // Cannot enumerate; the meta-cache pass above is the only Firefox path. Any
    // legacy db NOT in the meta cache persists as orphan data-at-rest (the
    // namespacing prevents any new build from opening it). Mark done.
    markDone();
    return;
  }

  try {
    indexedDB
      .databases()
      .then((dbs) => {
        for (const db of dbs) {
          if (db.name && isLegacyYdocName(db.name)) {
            void deleteYdocDatabase(db.name);
          }
        }
      })
      .catch(() => {
        // enumeration failed — the meta-cache pass already ran
      })
      .finally(markDone);
  } catch {
    // synchronous throw — record the run so we don't retry every boot
    markDone();
  }
}

/** Test-only: reset the one-time migration flag. */
export function resetPageYdocMigrationForTests(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(YDOC_MIGRATION_FLAG);
    }
  } catch {
    // ignore
  }
}
