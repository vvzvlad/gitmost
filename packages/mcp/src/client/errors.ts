// Central REST error diagnostics (issues #437 + #450). SINGLE place that maps an
// axios error to the model-facing message. Extracted verbatim from client.ts;
// the constructor's response interceptor (see client/context.ts) routes every
// REST call through formatDocmostAxiosError so the whole surface is uniform.
import axios from "axios";

// --- Issue #437: central error diagnostics -------------------------------
// The agent only ever sees the thrown exception's `error.message`, so a failed
// tool must return an ACTIONABLE message (method, path, status, and the
// server's own validation text) instead of the opaque "Request failed with
// status code 400". These helpers + the response interceptor in the
// constructor are the single authoritative place that text is composed.

// Overall cap on the composed diagnostic message so the model context stays
// compact and a (whitelisted) server string can never blow up the text.
const ERROR_MESSAGE_CAP = 300;
// Only attempt to JSON.parse an arraybuffer body under this size: a larger
// binary body is never a JSON error envelope, so parsing it just wastes memory
// (fetchInternalFile uses responseType:"arraybuffer", so a failed file fetch
// carries the JSON error envelope as raw bytes here).
const ERROR_BUFFER_PARSE_CAP = 4096;

// Canonical 36-char UUID (8-4-4-4-12 hex). Deliberately version/variant-
// AGNOSTIC: the ids are UUIDv7 (e.g. 019f499a-9f8c-7d68-...), so only the
// canonical shape/length is enforced, not the version/variant nibble.
const FULL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throw an actionable error BEFORE any network call when `value` is not a full
 * canonical UUID. Absorbs #436: a truncated/short comment id used to reach the
 * server and bounce back as an opaque 400/404 the agent could not self-correct;
 * failing fast here names the exact fix.
 */
export function assertFullUuid(
  tool: string,
  param: string,
  value: string,
): void {
  if (typeof value !== "string" || !FULL_UUID_RE.test(value)) {
    throw new Error(
      `${tool}: '${param}' must be the FULL comment UUID (36 chars, e.g. ` +
        `019f499a-9f8c-7d68-b7be-ce100d7c6c56), got '${value}'. Copy the id ` +
        `verbatim from listComments / createComment output.`,
    );
  }
}

// Max number of accessible spaces to enumerate inline in the "space not
// accessible" message (issue #534) before collapsing the rest into a "(+N ещё)"
// tail, so a workspace with many spaces cannot blow up the model context.
const SPACE_LIST_CAP = 10;

/**
 * Compose the model-facing "spaceId is not accessible" message (issue #534).
 * This is FACT text about the supplied spaceId that REPLACES the opaque server
 * string ("Space permissions not found") on the enrich-on-404 path — it names
 * the exact bad id, lists the spaces the token can actually see (id + name, so
 * the agent can copy the right id verbatim), and points at `listSpaces`.
 *
 * Deliberately Russian: like the other agent-facing tool guidance in this repo,
 * this is the message the acting agent reads to self-correct.
 */
export function formatSpaceNotAccessible(
  mcpName: string,
  spaceId: string,
  spaces: { id: string; name: string }[],
): string {
  // No accessible spaces at all — a distinct diagnosis (token has no space
  // access), not "you picked the wrong one from this list".
  if (!Array.isArray(spaces) || spaces.length === 0) {
    return `${mcpName}: spaceId "${spaceId}" недоступен, и доступных тебе спейсов нет — проверь доступ токена / вызови listSpaces.`;
  }

  const shown = spaces.slice(0, SPACE_LIST_CAP);
  const remaining = spaces.length - shown.length;
  const tail =
    remaining > 0 ? ` (+${remaining} ещё, см. listSpaces)` : "";

  // Cap the whole message at ERROR_MESSAGE_CAP (same budget as
  // formatDocmostAxiosError) so ~10 long space names cannot blow up the model
  // context. Truncate ONLY the interpolated space LIST — the fixed prefix (which
  // carries the bad spaceId) and the fixed suffix (the "…из listSpaces"
  // instruction) are always kept intact, so the actionable parts survive even
  // when the list is trimmed.
  const prefix = `${mcpName}: spaceId "${spaceId}" не найден среди доступных тебе спейсов. Доступные: `;
  const suffix = ` — скопируй нужный id дословно из listSpaces.`;
  let listed = shown.map((s) => `${s.id} (${s.name})`).join(", ") + tail;
  const budget = ERROR_MESSAGE_CAP - prefix.length - suffix.length;
  if (listed.length > budget) {
    listed = listed.slice(0, Math.max(0, budget - 1)) + "…";
  }
  const message = `${prefix}${listed}${suffix}`;
  // Unconditional final backstop (mirrors formatDocmostAxiosError): the list
  // cap above assumes a well-formed prefix, but a pathologically long
  // agent-supplied spaceId lives in the prefix and would otherwise blow past the
  // budget. Cap the WHOLE message so nothing bloats the model context.
  return message.length > ERROR_MESSAGE_CAP
    ? message.slice(0, ERROR_MESSAGE_CAP - 1) + "…"
    : message;
}

// Keep ONLY the pathname of a request (no host, no query string, no fragment)
// so the message never leaks a host or query params. Resolves a relative
// config.url against config.baseURL, then discards everything but the path.
function requestPath(config: any): string {
  const rawUrl = typeof config?.url === "string" ? config.url : "";
  const base =
    typeof config?.baseURL === "string" ? config.baseURL : undefined;
  try {
    // A dummy base makes an absolute config.url parse too; its host is dropped.
    return new URL(rawUrl, base ?? "http://localhost").pathname;
  } catch {
    // Malformed url: still strip any query/fragment manually.
    return rawUrl.split(/[?#]/)[0] || rawUrl;
  }
}

/**
 * Compose the server-facing message from `error.response.data`, using ONLY the
 * whitelisted `message`/`error` fields or the HTTP statusText. SECURITY: the
 * raw response body, headers (Authorization!) and config are NEVER read here —
 * a string/HTML body (e.g. a proxy's 502 page) is deliberately dropped in
 * favour of the statusText.
 */
function extractServerMessage(data: any, statusText: string): string {
  // class-validator envelope: { message: string | string[], error?: string }.
  if (
    data &&
    typeof data === "object" &&
    !Buffer.isBuffer(data) &&
    !(data instanceof ArrayBuffer)
  ) {
    const msg = (data as any).message;
    if (Array.isArray(msg)) {
      const joined = msg.filter((m) => typeof m === "string").join("; ");
      if (joined) return joined;
    } else if (typeof msg === "string" && msg) {
      return msg;
    }
    const err = (data as any).error;
    if (typeof err === "string" && err) return err;
    return statusText;
  }

  // Buffer / ArrayBuffer body: attempt a size-capped, guarded JSON.parse so a
  // failed arraybuffer fetch still surfaces the server's validation text.
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > 0 && buf.length <= ERROR_BUFFER_PARSE_CAP) {
      try {
        return extractServerMessage(JSON.parse(buf.toString("utf8")), statusText);
      } catch {
        return statusText;
      }
    }
    return statusText;
  }

  // A raw string / HTML body is never surfaced (may echo server internals).
  return statusText;
}

/**
 * Reformat an AxiosError's `.message` IN PLACE into an actionable diagnostic:
 *   `<METHOD> <path> failed (<status> <statusText>): <serverMessage>`
 * or, when the request never got a response:
 *   `<METHOD> <path> failed: <code> (no response from server)`.
 *
 * Mutates the SAME error object (never a custom subclass) so the live
 * axios.isAxiosError / error.response?.status / config._retry checks around the
 * client keep working, and sets `_docmostFormatted` as a double-processing
 * guard. A no-op on a non-axios or already-formatted error.
 */
export function formatDocmostAxiosError(error: any): void {
  if (!error || error._docmostFormatted) return;
  if (!axios.isAxiosError(error)) return;

  const config: any = error.config ?? {};
  const method =
    typeof config.method === "string" ? config.method.toUpperCase() : "";
  const methodPath = `${method} ${requestPath(config)}`.trim();
  const response = error.response;

  let message: string;
  if (response) {
    const statusText =
      typeof response.statusText === "string" ? response.statusText : "";
    const serverMessage = extractServerMessage(response.data, statusText);
    message = `${methodPath} failed (${response.status} ${statusText}): ${serverMessage}`;
    // Full body only to stderr under DEBUG (parity with downloadImage).
    if (process.env.DEBUG) {
      console.error(
        "Docmost request failed; response body:",
        JSON.stringify(response.data),
      );
    }
  } else {
    // No response at all (ECONNREFUSED / ETIMEDOUT / ECONNRESET / DNS / timeout).
    // Use ONLY error.code, never the raw error.message: axios network messages
    // embed host:port ("connect ECONNREFUSED 127.0.0.1:3000", "getaddrinfo
    // ENOTFOUND host") and #437's invariant is that the host never reaches the
    // model-visible message. code is set for essentially every real no-response
    // error (ECONNREFUSED/ETIMEDOUT/ECONNRESET/ENOTFOUND/ECONNABORTED); the full
    // native message still goes to stderr under DEBUG.
    const reason = error.code ?? "network error";
    message = `${methodPath} failed: ${reason} (no response from server)`;
    if (process.env.DEBUG) {
      console.error("Docmost request failed; no response:", error.message);
    }
  }

  if (message.length > ERROR_MESSAGE_CAP) {
    message = message.slice(0, ERROR_MESSAGE_CAP - 1) + "…";
  }

  error.message = message;
  (error as any)._docmostFormatted = true;
}
