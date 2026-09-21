import { reportSafetyMetric } from "@/lib/telemetry/safety-metrics";

/**
 * Unified HTTP-error taxonomy (#641, Ф5 of the offline epic #638).
 *
 * BEFORE this module, every call-site read `error?.["status"]` directly
 * (page.tsx:132) or `error?.status ?? error?.response?.status`
 * (the eviction subscribers). That conflates three DISTINCT situations that the
 * offline-first work must treat differently, so they are classified here ONCE
 * and consumed by page.tsx, user-provider.tsx and both eviction subscribers:
 *
 *  - AUTH (401/403/404) — the server ANSWERED with an access verdict. The page
 *    is gone / revoked; render not-found and let the global evictors drop the
 *    local copy. This is the ONLY category that may touch eviction.
 *
 *  - TRANSPORT / "unreachable" — an axios request that never reached a responding
 *    server (`err.response === undefined`): a network error / timeout
 *    (`code ∈ ERR_NETWORK | ECONNABORTED | ETIMEDOUT`) or an axios-shaped error
 *    with a `request` but no `response`. This is the NORMAL offline mode — it may
 *    be swallowed into a local render. A NON-axios throw (a bug, a TypeError) is
 *    deliberately NOT transport (it hits the error screen instead of being masked
 *    as offline — see isTransportError).
 *
 *  - SERVER (5xx) — the server ANSWERED with an error status. A bad deploy, a
 *    down DB, a 500 from /me or /pages/info. This must NEVER be shown as
 *    "offline, cached copy" (the user would blame the network and the client
 *    would stay silent about a real outage). It is COUNTED + SURFACED + REPORTED,
 *    distinct from unreachable (see reportOfflineCriticalServerError).
 *
 * A FOURTH, non-error situation the predicates deliberately do NOT misclassify:
 * "success-with-undefined". The 401 interceptor `return;`s (resolving the
 * promise with `undefined` data) on the exempt paths `/auth/collab-token` and
 * `/share/*` (api-client.ts:29-30). That is neither an error NOR real data: the
 * query settles with `data === undefined` and NO error, so there is no error
 * object to hand these predicates. Passing `undefined`/`null` here therefore
 * returns `false` from every predicate — it is classified as nothing, and must
 * not drive the local render either way.
 */

/** axios network/timeout `code`s: the request never got an HTTP response. */
export const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ERR_NETWORK",
  "ECONNABORTED",
  "ETIMEDOUT",
]);

interface HttpErrorLike {
  status?: unknown;
  code?: unknown;
  response?: { status?: unknown } | undefined;
  // axios stamps `isAxiosError: true` and attaches a `request` once the call
  // actually left for the network — used to tell a genuine transport failure
  // from an arbitrary non-axios throw (see isTransportError).
  isAxiosError?: unknown;
  request?: unknown;
}

function asHttpErrorLike(e: unknown): HttpErrorLike | null {
  if (!e || typeof e !== "object") return null;
  return e as HttpErrorLike;
}

/**
 * The HTTP status carried by an error, or `undefined` when the request never
 * got a response (transport error) or the value is not an HTTP error. Reads the
 * axios `response.status` first, then a flattened `status` (some synthetic /
 * re-thrown errors and the existing eviction subscribers use the flat form).
 */
export function httpStatusOf(e: unknown): number | undefined {
  const err = asHttpErrorLike(e);
  if (!err) return undefined;
  const fromResponse = err.response?.status;
  if (typeof fromResponse === "number") return fromResponse;
  if (typeof err.status === "number") return err.status;
  return undefined;
}

/**
 * AUTH error: the server answered with an access verdict (401/403/404). These
 * are the ONLY statuses that render not-found + evict; a 5xx is NOT auth.
 */
export function isAuthError(e: unknown): boolean {
  const status = httpStatusOf(e);
  return status === 401 || status === 403 || status === 404;
}

/**
 * TRANSPORT / unreachable error: an axios request that never reached a responding
 * server. True when there is NO HTTP response status AND the error is a genuine
 * axios network/timeout failure — recognised by an explicit network `code`
 * (ERR_NETWORK/ECONNABORTED/ETIMEDOUT) OR an axios-shaped error (`isAxiosError`,
 * or a `request` that left but got no `response`).
 *
 * A response WITH a status (auth or 5xx) is never transport, so this can never
 * swallow a 5xx into the local render (part 4). An arbitrary NON-axios throw (a
 * TypeError, a bug in a response transform) is ALSO not transport: it has no
 * `code` and is not axios-shaped, so it falls through to the error screen rather
 * than being masked as "offline" with zero operator signal (which would be the
 * part-4 failure mode arriving through a non-5xx door).
 */
export function isTransportError(e: unknown): boolean {
  const err = asHttpErrorLike(e);
  if (!err) return false;
  // A response with a status is an ANSWER, not an unreachable network.
  if (httpStatusOf(err) !== undefined) return false;
  // Explicit axios network/timeout codes make the intent unambiguous...
  if (typeof err.code === "string" && TRANSPORT_ERROR_CODES.has(err.code)) {
    return true;
  }
  // ...otherwise it must be an axios-shaped error that reached the network but
  // got no response. A bare non-axios throw is NOT transport (see above).
  const axiosShaped = err.isAxiosError === true || "request" in err;
  return axiosShaped && err.response === undefined;
}

/**
 * SERVER error: the server answered with a 5xx. Distinct from unreachable — it
 * must be surfaced to the user and reported, never labelled "offline".
 */
export function isServerError(e: unknown): boolean {
  const status = httpStatusOf(e);
  return typeof status === "number" && status >= 500 && status <= 599;
}

/**
 * Count + report a 5xx on an OFFLINE-CRITICAL request (/me, /pages/info,
 * /spaces/*). No-op for a transport error or any non-5xx — those are handled by
 * their own branches (transport → local render; auth → not-found). Uses the
 * ALWAYS-ON safety-metric channel (#640): counted, greppable, and best-effort
 * delivered even though perf telemetry is default-off — because a partial outage
 * (one endpoint, one workspace) may never raise the server-side 5xx rate enough
 * to notice, and "never show an error" must not mean "never notice one".
 *
 * @returns true when a 5xx was reported (the caller must NOT show it as offline).
 */
export function reportOfflineCriticalServerError(
  e: unknown,
  endpoint: string,
): boolean {
  if (!isServerError(e)) return false;
  reportSafetyMetric("http_server_error", {
    endpoint,
    status: httpStatusOf(e),
  });
  return true;
}
