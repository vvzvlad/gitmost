import { reportSafetyMetric } from "@/lib/telemetry/safety-metrics";

/**
 * Low-level, AWAITABLE delete of a single ydoc IndexedDB database (#640).
 *
 * Extracted into its own module so both the eviction/purge path
 * (`page-ydoc-eviction.ts`) and the tombstone LRU pruning
 * (`page-ydoc-tombstones.ts`) can delete a database WITHOUT importing each other
 * (which would be a cycle).
 *
 * Resolves on success, block, OR error — it NEVER rejects — so a caller can
 * `Promise.all` a whole purge and still make progress even when one database is
 * wedged. A blocked or errored deletion increments an ALWAYS-ON safety counter:
 * a silently-blocked delete leaves revoked / signed-out content on disk, the
 * worst failure mode for a fail-closed control (AGENTS.md rule #10).
 */

// A delete blocked by another tab's open handle is PENDING, not failed: it fires
// `onsuccess` the moment that tab closes its connection. The purge broadcasts a
// "close your ydocs" message to every tab, so give that close a bounded window
// to land (and unblock the delete) before we stop waiting — a tab that never
// closes must not hang logout forever.
const BLOCKED_GRACE_MS = 2000;

export function deleteYdocDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve();
        return;
      }
      const request = indexedDB.deleteDatabase(name);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      request.onsuccess = settle;
      request.onerror = () => {
        reportSafetyMetric("ydoc_delete_error", {
          name,
          error: String(request.error),
        });
        settle();
      };
      request.onblocked = () => {
        // Metered immediately (the block IS the observable degradation), but do
        // not settle yet: the purge broadcast asks other tabs to close their
        // handles, which unblocks the delete and fires `onsuccess`. Bound the
        // wait so a tab that never closes cannot hang the caller forever.
        reportSafetyMetric("ydoc_delete_blocked", name);
        setTimeout(settle, BLOCKED_GRACE_MS);
      };
    } catch (err) {
      reportSafetyMetric("ydoc_delete_error", err);
      resolve();
    }
  });
}
