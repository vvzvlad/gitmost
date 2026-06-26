/**
 * Format an AI SDK provider error for logging / surfacing to admins.
 *
 * AI SDK APICallError / JSONParseError carry `statusCode` and the raw
 * `responseBody` (for an "Invalid JSON response" this is the offending
 * non-JSON payload — typically an HTML error page from a misconfigured
 * endpoint), which is exactly what is needed to diagnose the failure. A
 * truncated, single-line snippet of the body is appended.
 *
 * None of these fields contain the API key (it is sent as an Authorization
 * header and never echoed in the response body), so this is safe to log/return.
 *
 * A small set of well-known HTTP statuses (auth / billing / rate limit) are
 * classified and a clear, human-readable English label is prepended, so the
 * log/UI states the real cause instead of only the provider's opaque message
 * (e.g. a 401 "User not found." is really a bad/missing API key). The label is
 * a static string and never contains the API key.
 *
 * `fallback` is used when the error carries no usable message (e.g. a bare
 * object); defaults to 'Unknown error'.
 */
export function describeProviderError(
  err: unknown,
  fallback = 'Unknown error',
): string {
  if (typeof err !== 'object' || err === null) {
    return typeof err === 'string' && err ? err : fallback;
  }
  const e = err as {
    statusCode?: number;
    message?: string;
    responseBody?: string;
    text?: string;
  };
  const base =
    typeof e.statusCode === 'number'
      ? `${e.statusCode}: ${e.message ?? ''}`.trim()
      : (e.message ?? fallback);
  const body = (e.responseBody ?? e.text ?? '').trim();
  // Collapse whitespace so a multi-line HTML body stays on one log line.
  const oneLine = body.replace(/\s+/g, ' ');
  const snippet = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
  const detail = body ? `${base} | response body: ${snippet}` : base;
  // Classify well-known HTTP statuses so the log/UI states the real problem
  // (auth / billing / rate limit) instead of only the provider's opaque message.
  const label = classifyStatus(e.statusCode);
  return label ? `${label} — ${detail}` : detail;
}

/**
 * Whether a provider error is FATAL for an ENTIRE batch operation rather than
 * specific to one item. Authentication (401/403 — invalid or missing API key)
 * and billing (402 — insufficient credits/quota) failures recur identically on
 * every subsequent request, so a bulk reindex should abort immediately instead
 * of issuing hundreds of doomed calls. A 429 rate limit is intentionally NOT
 * fatal: it is transient and better handled by per-item isolation / backoff.
 */
export function isFatalProviderError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { statusCode?: number }).statusCode;
  return status === 401 || status === 403 || status === 402;
}

// Map a small set of well-known provider HTTP statuses to a clear,
// human-readable cause. Returns null for anything else so the existing
// "<status>: <message> | response body: …" output is preserved unchanged.
function classifyStatus(statusCode?: number): string | null {
  switch (statusCode) {
    case 401:
    case 403:
      return 'AI provider authentication failed (invalid or missing API key)';
    case 402:
      return 'AI provider rejected the request: insufficient credits or quota';
    case 429:
      return 'AI provider rate limit exceeded';
    default:
      return null;
  }
}
