import { httpStatusOf } from "@/lib/http-error";

/**
 * What UserProvider should render for the `/me` query state (#641, Ф5, part 3).
 *
 * Pre-Ф5 the rule was: loading → nothing; 404 → Error404; ANY other error →
 * empty fragment (`<></>`), which unmounts the WHOLE app. react-query v5 sets
 * `status:'error'` even when `data` is present (verified query-core 5.90.17), so
 * after Ф6 (a persisted current-user) a transient `/me` failure — a blip, an
 * offline reload, a 5xx — would collapse a fully-usable app to nothing. So an
 * error is tolerated when we already have a user: children stay mounted with a
 * degraded indicator, and ONLY these still gate render:
 *  - 401 — the interceptor is redirecting to login anyway;
 *  - an error with NO data — there is nothing to render.
 *
 * The gate is a pure function of (isLoading, error, hasData) — NOT of the bare
 * `status` — precisely because `status:'error'` with data present is the case
 * this exists to handle.
 */
export type UserGateDecision =
  | "loading"
  | "error-404"
  | "blocked"
  | "degraded"
  | "children";

export function resolveUserGate(opts: {
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
  //  - No data → nothing to show → block.
  //  - 401 → the interceptor redirects to login → block.
  if (!opts.hasData) return "blocked";
  if (httpStatusOf(opts.error) === 401) return "blocked";

  // Data present + a non-401, non-404 error (transport OR 5xx OR other): keep
  // the app mounted and show the degraded indicator.
  return "degraded";
}
