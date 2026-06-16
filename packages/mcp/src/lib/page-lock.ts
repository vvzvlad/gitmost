/**
 * Per-page async mutex.
 *
 * Content writes over the collaboration websocket must never overlap for the
 * same page: two concurrent full-document replaces would race on the live Yjs
 * fragment. We serialize them with a per-pageId promise chain — each new
 * operation waits for the previous one on that page to settle (success or
 * failure) before it runs. Different pages never block each other.
 */

const chains = new Map<string, Promise<unknown>>();

// The returned promise carries the real result/rejection of `fn` and MUST be
// awaited/handled by the caller; only the internal chaining tail swallows
// errors (purely to gate ordering).
export function withPageLock<T>(
  pageId: string,
  fn: () => Promise<T>,
): Promise<T> {
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
