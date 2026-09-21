/**
 * Per-page async mutex.
 *
 * Content writes over the collaboration websocket must never overlap for the
 * same page: two concurrent full-document replaces would race on the live Yjs
 * fragment. We serialize them with a per-pageId promise chain — each new
 * operation waits for the previous one on that page to settle (success or
 * failure) before it runs. Different pages never block each other.
 */

import type { PageId } from "./page-id.js";

const chains = new Map<string, Promise<unknown>>();

// Canonical UUID shape (versions 1–8, matching the `uuid` package's `validate`
// that the server's isValidUUID uses). This is the SINGLE source of truth for
// "is this a canonical page UUID?" in the MCP: client.ts's resolvePageId
// imports isUuid from here to decide whether a pageId already IS a UUID (and so
// needs no /pages/info round-trip). page.repo.ts treats any non-UUID pageId as
// a slugId; a 10-char nanoid slugId never contains dashes, so it can never be
// misread as a UUID here.
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

// The returned promise carries the real result/rejection of `fn` and MUST be
// awaited/handled by the caller; only the internal chaining tail swallows
// errors (purely to gate ordering).
export function withPageLock<T>(
  pageId: PageId,
  fn: () => Promise<T>,
): Promise<T> {
  // STRUCTURAL INVARIANT (issue #449/#435, "resolve-then-lock"): the mutex key
  // MUST be the canonical page UUID, never a raw slugId. The `PageId` brand now
  // enforces this at COMPILE time (a raw string / slugId no longer type-checks
  // as a key); the runtime assert below stays as a backstop for untyped (JS)
  // callers and the http/stdio transports. The whole write path relies
  // on the lock key AND the CollabSession cache key being the resolved UUID
  // (#260) — if a future write method forgot to call resolvePageId and locked
  // under a slugId, two writes to the same page would take DIFFERENT mutex keys
  // and silently lose serialization (clobbering live human edits). This was an
  // invariant enforced only by comments/convention; assert it in CODE so the
  // violation fails fast and loud at the lock instead of corrupting data in
  // prod. The centralizing helper (mutatePageContent/replacePageContent) already
  // guards a raw-input caller, but this backstop catches ANY path.
  if (!isUuid(pageId)) {
    throw new Error(
      `withPageLock: key must be a canonical page UUID, got '${pageId}'. ` +
        `The write path must resolvePageId(pageId) BEFORE locking so the ` +
        `mutex/CollabSession cache key is the UUID (invariant "resolve-then-` +
        `lock", #260/#449). A slugId or other non-UUID key would silently lose ` +
        `per-page serialization.`,
    );
  }
  // Wait for the previous op on this page; swallow its error so a failure does
  // not poison the queue for the next caller.
  const prev = (chains.get(pageId) ?? Promise.resolve()).catch(() => {});
  const run = prev.then(fn);

  // The tail used for chaining must also swallow errors (it only gates order).
  const tail = run.catch(() => {});
  chains.set(pageId, tail);

  // Drop the map entry once this op is the tail and has settled, to avoid an
  // unbounded map of resolved promises.
  tail.then(() => {
    if (chains.get(pageId) === tail) {
      chains.delete(pageId);
    }
  });

  // Callers get the real result/rejection of fn.
  return run;
}
