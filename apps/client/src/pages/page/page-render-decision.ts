import { isAuthError, isTransportError } from "@/lib/http-error";

/**
 * How page.tsx should render when the page query has NOT produced usable data
 * (#641, Ф5). Splits the pre-Ф5 single "error → EmptyState" return into the
 * offline-first taxonomy:
 *
 *  - "not-found"     — the server gave an access verdict (401/403/404): the page
 *    is gone / revoked. Renders not-found; the global evictors drop the local
 *    copy (unchanged from today — preserves the #564/#640 revocation criterion).
 *  - "offline-local" — unreachable network AND we have the cached chrome AND a
 *    local body: render chrome + read-only body from the ydoc + offline banner.
 *  - "offline-empty" — unreachable network AND cached chrome BUT no local body:
 *    an explicit "not available offline" empty-state, NOT a silent skeleton.
 *  - "error-screen"  — everything else: no cache to fall back on, OR a RESPONSE
 *    with an error status (5xx / non-auth 4xx). Today's error screen.
 */
export type PageErrorDecision =
  | "not-found"
  | "offline-local"
  | "offline-empty"
  | "error-screen";

export function classifyPageError(opts: {
  localFirst: boolean;
  error: unknown;
  hasChromeMeta: boolean;
  hasLocalBody: boolean;
}): PageErrorDecision {
  // Flag OFF — byte-for-behavior identical to pre-Ф5: an auth status (401/403/404)
  // shows not-found, everything else shows today's error screen. No offline
  // branches exist, so no cached render can happen with the flag off.
  if (!opts.localFirst) {
    return isAuthError(opts.error) ? "not-found" : "error-screen";
  }

  // The server ANSWERED with an access verdict → not-found + (global) evict.
  if (isAuthError(opts.error)) return "not-found";

  // TRANSPORT (unreachable): the normal offline mode. Swallow it into a local
  // render ONLY when we actually have something local to show.
  if (isTransportError(opts.error)) {
    if (!opts.hasChromeMeta) return "error-screen";
    return opts.hasLocalBody ? "offline-local" : "offline-empty";
  }

  // Anything left is a RESPONSE carrying an error status — a 5xx (bad deploy,
  // down DB) or a non-auth 4xx (400/429). Part 4 (CRITICAL): a 5xx must NEVER be
  // shown as "offline, cached copy" — the user would blame the network and a real
  // outage would stay silent. Surface it as an honest error screen (page.tsx also
  // reports the 5xx via the safety metric), distinct from the unreachable path.
  return "error-screen";
}
