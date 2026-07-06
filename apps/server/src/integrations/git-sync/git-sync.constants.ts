/**
 * Git-sync control-plane constants.
 *
 * Event/job names are REUSED from the shared event contract (event.contants.ts)
 * so the listener subscribes to the exact names the rest of the server emits —
 * never a string literal that could drift. The Redis lock-key prefix + TTLs back
 * the single-writer leader lock (§9); the debounce default backs the per-space
 * event coalescing (§10).
 */
import { EventName } from '../../common/events/event.contants';

/**
 * The page lifecycle events the git-sync listener reacts to. A change
 * to any of these in an enabled space schedules a debounced sync cycle.
 *   - PAGE_CREATED / PAGE_UPDATED / PAGE_MOVED — structural + content edits;
 *   - PAGE_SOFT_DELETED / PAGE_RESTORED — Trash transitions (deletes are soft);
 *   - PAGE_MOVED_TO_SPACE — cross-space move (cross-repo).
 *
 * NOTE: body edits arrive via PAGE_UPDATED (emitted from persistence.extension),
 * NOT via EventName.PAGE_CONTENT_UPDATED — that name is a BullMQ queue-job name,
 * not an EventEmitter2 event, so @OnEvent would never fire for it.
 */
export const GIT_SYNC_PAGE_EVENTS = [
  EventName.PAGE_CREATED,
  EventName.PAGE_UPDATED,
  EventName.PAGE_MOVED,
  EventName.PAGE_MOVED_TO_SPACE,
  EventName.PAGE_SOFT_DELETED,
  EventName.PAGE_RESTORED,
] as const;

/** Redis key prefix for the per-space leader lock. */
export const GIT_SYNC_LOCK_PREFIX = 'git-sync:lock:';

/**
 * Leader-lock TTL (ms). Must exceed the maximum expected cycle duration so the
 * lock is not lost mid-cycle; on a crash it expires on its own. The
 * in-process mutex (orchestrator) prevents overlapping cycles on one instance,
 * and the Redis lock prevents two instances racing the same space.
 */
export const GIT_SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Bounded retry budget for ACQUIRING the per-space lock on the PUSH (external
 * receive-pack) path. The poll cycle holds the single-writer lock while it
 * processes a whole space, so a legitimate `git push` that arrives during a
 * cycle would otherwise IMMEDIATELY 503 (GitSyncLockHeldError) even though the
 * cycle is about to release the lock in well under a second for most spaces.
 * Under continuous polling that made a majority of pushes 503 non-
 * deterministically. So the push path retries the acquire with a small capped
 * backoff for up to ~`TOTAL_MS` BEFORE giving up — a transient overlap with a
 * cycle no longer fails the push, while a genuinely stuck/long cycle still
 * surfaces a 503 after the bound (git then retries the whole push, which is
 * safe: the receive-pack only runs ONCE the lock is held, so a 503 never leaves
 * a half-applied ref). The POLL cycle itself does NOT retry (it just skips and
 * the next tick reconciles), so this is push-only — the smaller blast radius.
 */
export const GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS = 5_000;
/** First backoff between push lock-acquire attempts (ms); doubles, capped. */
export const GIT_SYNC_PUSH_LOCK_RETRY_BASE_MS = 100;
/** Cap on the per-attempt push lock-acquire backoff (ms). */
export const GIT_SYNC_PUSH_LOCK_RETRY_MAX_MS = 500;
