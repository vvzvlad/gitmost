// Shared, window-based auto-reload budget.
//
// Both auto-reload paths — the reactive chunk-load-error-boundary (recovers
// AFTER a stale lazy chunk 404s) and the proactive version-coherence feature
// (reloads BEFORE the tab hits a stale chunk) — go through these functions so
// they share ONE window-scoped reload budget: at most a single automatic
// reload per RELOAD_WINDOW_MS across BOTH paths. A window (rather than a
// permanent one-shot flag) lets a SECOND deploy in the same tab's lifetime
// recover too, while a permanent skew, node oscillation, or a genuinely-missing
// chunk still degrades to a manual banner/UI after the first reload instead of
// looping. When sessionStorage is unavailable every mismatch degrades to the
// manual UI — no unguarded reload.

// sessionStorage key holding the epoch-ms timestamp of the last automatic reload
// (shared by both paths).
const RELOAD_AT_KEY = "chunk-reload-at";

// Allow at most one automatic reload per this window. A stale-deploy 404 is cured
// by a single reload, so anything inside the window is treated as a reload loop
// (permanently-broken chunk / permanent skew) and falls through to the manual UI.
export const RELOAD_WINDOW_MS = 5 * 60 * 1000;

/**
 * Pure window decision, unit-tested in isolation: auto-reload only if we have
 * never auto-reloaded (lastReloadAt null/NaN) or the last one was strictly older
 * than the window. Anything inside the window is suppressed to break an infinite
 * reload loop.
 */
export function shouldAutoReload(
  now: number,
  lastReloadAt: number | null,
  windowMs: number,
): boolean {
  if (lastReloadAt === null || Number.isNaN(lastReloadAt)) return true;
  return now - lastReloadAt > windowMs;
}

/**
 * Has an automatic reload already happened within the current window (so the
 * shared budget is spent right now)? Both paths check this before reloading; a
 * `true` return means fall through to the manual banner/UI instead of reloading.
 *
 * A storage read error (private mode / disabled) is reported as `true` so the
 * caller fails toward NOT reloading — an unguarded loop is worse than a stale
 * tab the user can reload manually. Note a window (not a permanent flag): once
 * the window elapses a later deploy's mismatch is allowed to reload again.
 */
export function hasAutoReloaded(now: number = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_AT_KEY);
    const lastReloadAt = raw === null ? null : Number.parseInt(raw, 10);
    return !shouldAutoReload(now, lastReloadAt, RELOAD_WINDOW_MS);
  } catch {
    return true;
  }
}

/**
 * Stamp the shared window as consumed now — record that an automatic reload is
 * being performed within the current RELOAD_WINDOW_MS window.
 *
 * Returns whether the write succeeded. A `false` return (storage unavailable)
 * means the caller MUST NOT reload — otherwise the stamp would never stick and
 * the reload could loop.
 */
export function markAutoReloaded(now: number = Date.now()): boolean {
  try {
    sessionStorage.setItem(RELOAD_AT_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

// Diagnostic breadcrumb for an automatic reload. Written right before
// window.location.reload() (which clears the console) and read back on the next
// page load, so a "the tab reloaded itself / it's looping" field report is
// diagnosable: which path fired (proactive version-coherence vs the reactive
// chunk-load boundary) and which version pair triggered it. sessionStorage
// survives a same-tab reload, unlike the console.
const RELOAD_BREADCRUMB_KEY = "reload-breadcrumb";

export type ReloadBreadcrumb = {
  path: "proactive" | "chunk-boundary";
  serverVersion?: string;
  clientVersion?: string;
  at: number;
};

/**
 * Persist a best-effort breadcrumb just before an automatic reload. Failures
 * (storage unavailable) are swallowed — this is diagnostics only and must never
 * block or alter the reload decision.
 */
export function recordReloadBreadcrumb(
  entry: Omit<ReloadBreadcrumb, "at">,
): void {
  try {
    sessionStorage.setItem(
      RELOAD_BREADCRUMB_KEY,
      JSON.stringify({ ...entry, at: Date.now() }),
    );
  } catch {
    // best-effort diagnostics only
  }
}

/**
 * Read and clear the breadcrumb left by an auto-reload in the previous page
 * load. Cleared on read so it surfaces exactly once per reload.
 */
export function takeReloadBreadcrumb(): ReloadBreadcrumb | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_BREADCRUMB_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RELOAD_BREADCRUMB_KEY);
    return JSON.parse(raw) as ReloadBreadcrumb;
  } catch {
    return null;
  }
}
