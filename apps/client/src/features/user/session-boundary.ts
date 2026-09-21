import { isSessionExpired } from "@/features/user/session-verified";
import { clearPersistedTreeCaches } from "@/features/page/tree/atoms/tree-data-atom";
import { purgePageYdocDatabases } from "@/features/editor/page-ydoc-eviction";

/**
 * Network-independent session boundary (#640, part 6) — the ENFORCEMENT half.
 *
 * The pure predicate lives in `session-verified.ts`; this module carries the
 * purge/clear machinery and is imported only by main.tsx (so the boot-cache
 * gates can consult the predicate without a cycle through the purge code).
 */

/**
 * Enforce the boundary at boot: if the session is expired, purge ALL local
 * content (ydoc databases + the persisted tree/meta boot caches) and return
 * true. Runs BEFORE the app renders, so nothing stale is ever painted.
 *
 * `freezeWrites: false` — this is not a logout: the stamp is left in place and
 * the boot-cache gates (`isCacheUsable`, the ydoc-open gate) consult
 * `isSessionExpired()` live, so nothing repaints until a fresh `/me` restamps
 * the session, at which point persistence must keep working normally.
 */
export function enforceOfflineSessionBoundary(
  now: number = Date.now(),
): boolean {
  if (!isSessionExpired(now)) return false;
  clearPersistedTreeCaches({ freezeWrites: false });
  void purgePageYdocDatabases();
  return true;
}
