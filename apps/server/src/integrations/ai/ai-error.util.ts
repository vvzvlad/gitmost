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
  if (!body) return base;
  // Collapse whitespace so a multi-line HTML body stays on one log line.
  const oneLine = body.replace(/\s+/g, ' ');
  const snippet = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
  return `${base} | response body: ${snippet}`;
}
