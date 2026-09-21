import { reportSafetyMetric } from "@/lib/telemetry/safety-metrics";

/**
 * Tombstones — the denylist of REVOKED page ydoc databases (#640, part 5).
 *
 * A tombstone gates the CONSTRUCTION of `IndexeddbPersistence`, never the paint.
 * y-indexeddb creates the database on construction, so checking at the
 * paint/swap point would RESURRECT an (empty) database on every visit to a
 * revoked page and the "cleaned" state would never stabilise. For a tombstoned
 * page the editor opens a REMOTE-ONLY ydoc (no local persistence): the body
 * shows the server-seeded static copy / skeleton, and no database is created.
 *
 * FAIL-CLOSED, and deliberately NOT the fail-open pattern of the neighbouring
 * boot caches (`page-meta-cache-atom.ts` degrades a corrupt/over-quota store to
 * EMPTY). For a denylist, "corrupt -> empty" inverts the meaning: it would draw
 * EVERYTHING, including revoked content. So if the store cannot be read or
 * written we DISABLE the local-paint path for the WHOLE session (fall back to
 * the network gate) and meter it. `canOpenLocalYdoc` then returns false for
 * every database until the tab is reloaded.
 *
 * The key is the scope-namespaced database name (`page.<scope>.<pageId>`, from
 * page-ydoc-eviction). It already embeds the (workspace, user) scope, so it
 * self-scopes and needs no separate scope resolution.
 */

const TOMBSTONE_KEY = "pageYdoc.tombstones.v1";

// Bound the denylist like MAX_CACHED_PAGES. Tombstones are only ADDED on a
// 403/404 and REMOVED on proof (see below), so in practice the set stays tiny;
// this is a storage backstop, not the normal cap. On overflow the denylist is
// NOT LRU-evicted (that would drop a guard without a CONFIRMED delete — see
// pruneToCap); instead the session fail-closes to the network gate.
const MAX_TOMBSTONES = 1000;

// Session-wide fail-closed latch. Once armed (an unreadable/unwritable store),
// the local-paint path is off for the rest of the session — a reload re-reads
// the store fresh.
let sessionDisabled = false;

/**
 * Is the local-paint path disabled for this whole session? True once the
 * tombstone store proved unreadable/unwritable (fail-closed). Exported so the
 * editor and tests can observe the degraded mode.
 */
export function isLocalPaintDisabledForSession(): boolean {
  return sessionDisabled;
}

function disableSessionLocalPaint(reason: unknown): void {
  if (sessionDisabled) return;
  sessionDisabled = true;
  reportSafetyMetric("ydoc_local_paint_disabled", reason);
}

/**
 * Read the denylist. Returns `null` on ANY failure (missing storage, corrupt
 * JSON, wrong shape) AND arms the session latch — the fail-closed signal every
 * caller treats as "no local paint". A well-formed store returns a
 * `{ [dbName]: tombstonedAt }` map.
 */
function readStore(): Record<string, number> | null {
  if (sessionDisabled) return null;
  try {
    if (typeof localStorage === "undefined") {
      // No storage at all: we cannot consult the denylist, so we cannot prove a
      // page is NOT revoked. Fail-closed.
      disableSessionLocalPaint("no-localStorage");
      return null;
    }
    const raw = localStorage.getItem(TOMBSTONE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      disableSessionLocalPaint("corrupt-shape");
      return null;
    }
    const store: Record<string, number> = {};
    for (const [name, ts] of Object.entries(parsed as Record<string, unknown>)) {
      store[name] = typeof ts === "number" ? ts : Date.now();
    }
    return store;
  } catch (err) {
    disableSessionLocalPaint(err);
    return null;
  }
}

function writeStore(store: Record<string, number>): boolean {
  try {
    if (typeof localStorage === "undefined") {
      disableSessionLocalPaint("no-localStorage");
      return false;
    }
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(store));
    return true;
  } catch (err) {
    // A denylist we cannot persist is worthless — a revoked page would be
    // forgotten on reload. Meter the failed write AND fail-closed the session.
    reportSafetyMetric("ydoc_tombstone_write_failed", err);
    disableSessionLocalPaint(err);
    return false;
  }
}

/**
 * Enforce MAX_TOMBSTONES — FAIL-CLOSED on overflow.
 *
 * A tombstone may be dropped ONLY when its database's deletion is CONFIRMED
 * (`removeTombstones`, onsuccess) or access is proven back (200). It must NEVER
 * be dropped by age/LRU pressure: an LRU "delete oldest and forget" would fire a
 * best-effort `deleteDatabase` that a second open tab can BLOCK (deleteDatabase
 * is a silent no-op while another tab holds the db), so the db survives while its
 * guard vanishes → revoked content is repainted after the next login. So on
 * overflow we do NOT evict; we FAIL-CLOSE the whole session (like an unreadable
 * store) + meter it. 1000 live tombstones is already pathological (mass
 * revocation); dropping to the network gate for the session is the safe
 * degradation. Returns true when it fail-closed so the caller stops.
 */
function pruneToCap(store: Record<string, number>): boolean {
  if (Object.keys(store).length <= MAX_TOMBSTONES) return false;
  disableSessionLocalPaint("tombstone-cap-overflow");
  return true;
}

/**
 * Gate for CONSTRUCTING a page's local `IndexeddbPersistence`. Fail-closed:
 * returns false when the page is tombstoned OR the store is unreadable (session
 * disabled). The editor opens a remote-only ydoc when this is false.
 */
export function canOpenLocalYdoc(dbName: string): boolean {
  const store = readStore();
  if (store === null) return false;
  return !(dbName in store);
}

/** Is this database on the denylist? Fail-closed: unreadable store => true. */
export function isTombstoned(dbName: string): boolean {
  const store = readStore();
  if (store === null) return true;
  return dbName in store;
}

/**
 * Tombstone the given database names — written under BOTH aliases (pageId and
 * slugId derived names) by the caller, because a 403/404 arrives on
 * `["pages", <id | slugId>]` and missing either alias fails OPEN. A tombstone is
 * NEVER terminal: it is lifted by `removeTombstones` on proof of access-return.
 */
export function addTombstones(dbNames: (string | null | undefined)[]): void {
  const store = readStore();
  if (store === null) return; // session already fail-closed; network gate covers us
  const now = Date.now();
  let changed = false;
  for (const name of dbNames) {
    if (name && !(name in store)) {
      store[name] = now;
      changed = true;
    }
  }
  if (!changed) return;
  // On cap overflow pruneToCap fail-closes the session (returns true); the store
  // is then moot (canOpenLocalYdoc/isTombstoned already treat everything as
  // denied), so do NOT persist a store we would only keep growing.
  if (pruneToCap(store)) return;
  writeStore(store);
}

/**
 * Lift the tombstone(s) — ONLY on PROOF: a confirmed database deletion
 * (`onsuccess`) or a 200 that proved access returned. NEVER by age or LRU
 * pressure: a sweep that dropped a tombstone while its `deleteDatabase` was
 * blocked by another tab would let revoked content return after the next login.
 */
export function removeTombstones(dbNames: (string | null | undefined)[]): void {
  const store = readStore();
  if (store === null) return;
  let changed = false;
  for (const name of dbNames) {
    if (name && name in store) {
      delete store[name];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

/** Test-only: reset the store and the session latch. */
export function resetTombstonesForTests(): void {
  sessionDisabled = false;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(TOMBSTONE_KEY);
    }
  } catch {
    // ignore
  }
}
