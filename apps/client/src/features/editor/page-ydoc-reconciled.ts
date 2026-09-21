/**
 * `reconciledAt` — a durable per-(scope, pageId) reservation for offline
 * EDITING, introduced now but with NO consumers yet (#640 R1 / #638).
 *
 * Meaning: "this ydoc synced with the server at least once". It is the durable
 * form of the session-scoped `isRemoteConfirmed` useState behind the #564
 * read-only guard: a ydoc that has never shared history with the server yields
 * garbage on merge, while a reconciled one is CRDT-safe for offline edits. It is
 * written in the collab provider's onSynced handler (page-editor.tsx).
 *
 * Ф7 MUST read THIS mark rather than spawn new consumers of the session
 * `isRemoteConfirmed`. Until then it is write-only.
 *
 * ─── FORWARD-COMPAT RULE (recorded now, enforced later) ───────────────────────
 * Purge-on-401/logout (page-ydoc-eviction.purgePageYdocDatabases, called from
 * use-auth.handleLogout / handleSignIn and api-client.redirectToLogin) is safe
 * ONLY while the write-guard (createBodyWriteGuard, #564) forbids local edits —
 * a purged ydoc can then hold no unsent work. The moment offline-editing lands,
 * purge MUST become "QUARANTINE, not delete, if the ydoc has unsent updates",
 * otherwise a returning network → 401 → redirectToLogin() would delete the
 * user's unsynchronised edits with the very handler meant to protect a shared
 * machine. `reconciledAt` is the durable signal a future purge/quarantine reads
 * to tell a merge-safe ydoc from a never-reconciled one.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Keyed by the scope-namespaced database name (`page.<scope>.<pageId>`), so it
 * self-scopes exactly like the tombstone store. Best-effort: unlike the
 * tombstone denylist this is a RESERVATION, not a safety control, so a failed
 * write is swallowed (Ф7 simply re-reconciles) — it must never fail-close the
 * editor.
 */

const RECONCILED_KEY = "pageYdoc.reconciled.v1";
// Bound the store; a long-lived browser must not grow it without limit.
const MAX_RECONCILED = 1000;

function readStore(): Record<string, number> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(RECONCILED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store: Record<string, number> = {};
    for (const [name, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ts === "number") store[name] = ts;
    }
    return store;
  } catch {
    return {};
  }
}

/** Record that this ydoc reconciled with the server (called from onSynced). */
export function markReconciled(dbName: string, now: number = Date.now()): void {
  try {
    const store = readStore();
    store[dbName] = now;
    const names = Object.keys(store);
    const overflow = names.length - MAX_RECONCILED;
    if (overflow > 0) {
      const oldestFirst = names.sort((a, b) => store[a] - store[b]);
      for (let i = 0; i < overflow; i++) delete store[oldestFirst[i]];
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(RECONCILED_KEY, JSON.stringify(store));
    }
  } catch {
    // best-effort reservation — never throw into the editor's onSynced path
  }
}

/**
 * When (epoch ms) this ydoc last reconciled, or `undefined` if never. NO current
 * consumers — reserved for Ф7 (offline editing) and used by tests.
 */
export function getReconciledAt(dbName: string): number | undefined {
  return readStore()[dbName];
}

/** Test-only: clear the reconciled store. */
export function resetReconciledForTests(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(RECONCILED_KEY);
    }
  } catch {
    // ignore
  }
}
