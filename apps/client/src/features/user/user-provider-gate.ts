import { httpStatusOf } from "@/lib/http-error";

/**
 * What UserProvider should render for the `/me` query state (#641, Ф5, part 3).
 *
 * Pre-Ф5 the rule was: loading → nothing; 404 → Error404; ANY other error →
 * empty fragment (`<></>`), which unmounts the WHOLE app. react-query v5 sets
 * `status:'error'` even when `data` is present (verified query-core 5.90.17), so
 * after Ф6 (a persisted current-user) a transient `/me` failure — a blip, an
 * offline reload, a 5xx — would collapse a fully-usable app to nothing. That is
 * strictly worse than today. So with local-first ON, an error is tolerated when
 * we already have a user: children stay mounted with a degraded indicator, and
 * ONLY these still gate render:
 *  - 401 — the interceptor is redirecting to login anyway;
 *  - an error with NO data — there is nothing to render.
 *
 * The gate is a pure function of (flag, isLoading, error, hasData) — NOT of the
 * bare `status` — precisely because `status:'error'` with data present is the
 * case this exists to handle.
 */
export type UserGateDecision =
  | "loading"
  | "error-404"
  | "blocked"
  | "degraded"
  | "children";

export function resolveUserGate(opts: {
  localFirst: boolean;
  isLoading: boolean;
  error: unknown;
  hasData: boolean;
}): UserGateDecision {
  if (opts.isLoading) return "loading";

  // 404 keeps its dedicated screen, exactly as before (checked before the generic
  // error handling, matching the original order).
  if (opts.error && httpStatusOf(opts.error) === 404) return "error-404";

  if (!opts.error) return "children";

  // There IS an error (and data may or may not exist).
  //  - No data → nothing to show → block (unchanged from today).
  //  - 401 → the interceptor redirects to login → block.
  // Both hold regardless of the flag, so flag-OFF is byte-for-behavior identical
  // (every error path below collapses to "blocked").
  if (!opts.hasData) return "blocked";
  if (httpStatusOf(opts.error) === 401) return "blocked";

  // Data present + a non-401, non-404 error (transport OR 5xx OR other). With the
  // flag on, keep the app mounted and show the degraded indicator; with the flag
  // off, preserve today's behavior and block.
  return opts.localFirst ? "degraded" : "blocked";
}
