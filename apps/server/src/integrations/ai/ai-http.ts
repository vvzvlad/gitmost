import { Agent, RetryAgent, type Dispatcher } from 'undici';
import { Logger } from '@nestjs/common';

/**
 * Dedicated, resilient outbound HTTP layer for ALL AI provider calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production logs showed the AI chat stream (and title generation) failing with
 * `read ECONNRESET` after the AI SDK's own retries were exhausted. The provider
 * clients were built with NO custom `fetch`, so all outbound LLM traffic used
 * Node's default global undici agent: default keep-alive pooling and NO
 * transport-level reconnect on connection resets. `read ECONNRESET` is a TCP RST
 * on a reused/poisoned keep-alive socket against the upstream provider/gateway.
 * The AI SDK retried, but every attempt reused the same poisoned condition and
 * hit the same error.
 *
 * WHAT THIS DOES
 * --------------
 * It builds a single shared undici `RetryAgent` and exposes a `fetch`-compatible
 * `aiFetch`, which is injected into every AI SDK provider factory via the
 * provider `fetch` option. That covers chat stream, public-share chat, title
 * generation, embeddings, STT and the test-connection probe at once.
 *
 * The RetryAgent retries CONNECTION-LEVEL errors (e.g. ECONNRESET) on a FRESH
 * socket — opening a new connection rather than reusing the poisoned one. POST is
 * explicitly opted in, because every LLM/chat/embedding/STT call is a POST and
 * undici's default retry `methods` list excludes POST. HTTP-STATUS retries
 * (429/5xx + Retry-After) are deliberately left to the AI SDK to avoid
 * double-retry; this layer only handles transport-level reconnects.
 *
 * MID-STREAM NOTE
 * --------------
 * This squarely fixes the production case: a reset BEFORE any response byte —
 * undici reconnects on a fresh socket (no Range header). If a reset instead
 * happens AFTER partial SSE bytes were already delivered, undici's RetryHandler
 * attempts a Range-resume retry; LLM/SSE endpoints do not support Range and
 * reject it, so the error surfaces as "server does not support the range header
 * and the payload was partially consumed" instead of the raw ECONNRESET. The
 * stream is NEVER corrupted (undici guards against concatenation) — only the
 * error message for that rarer mid-stream case changes.
 */

const baseAgent = new Agent({
  // Cap TCP/TLS connect so a stuck connect fails fast and gets retried instead
  // of hanging indefinitely.
  connect: { timeout: 10_000 },
  // Keep keep-alive CONSERVATIVE. A longer keep-alive widens the window in which
  // a stale/half-closed socket can be reused, which is exactly the condition
  // that produces `read ECONNRESET`. Do NOT raise this.
  keepAliveTimeout: 4_000,
  // Do NOT override headersTimeout/bodyTimeout — keep undici defaults so
  // long-lived SSE streaming responses are not killed mid-stream.
});

const dispatcher: Dispatcher = new RetryAgent(baseAgent, {
  // A poisoned keep-alive socket is almost always cured by the FIRST reconnect on
  // a fresh socket, so 2 transport retries are plenty. More would only add latency
  // against a genuinely-down upstream — and the AI SDK still retries on top.
  maxRetries: 2,
  minTimeout: 250,
  maxTimeout: 2_000,
  timeoutFactor: 2,
  // CRITICAL: include POST — every LLM/chat/embedding/STT call is a POST, and
  // undici's default `methods` list excludes POST (so without this, none of the
  // AI traffic would ever be retried).
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'OPTIONS', 'DELETE'],
  // Do NOT retry on HTTP status here — leave 429/5xx + Retry-After handling to
  // the AI SDK to avoid double-retry. We only want transport-level reconnects.
  statusCodes: [],
  // An explicit copy of undici 7.x's default connection-error code set, pinned
  // here so a future undici upgrade can't silently change which transport errors
  // we reconnect on. These are the errors we retry on a FRESH connection.
  errorCodes: [
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ENETDOWN',
    'ENETUNREACH',
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'UND_ERR_SOCKET',
    'EPIPE',
  ],
});

const logger = new Logger('AiHttp');
let requestSeq = 0;

/**
 * A `fetch`-compatible function that routes the request through the shared,
 * resilient AI dispatcher. Injected into AI SDK provider factories via their
 * `fetch` option. Follows the repo convention (see mcp-clients.service.ts
 * `guardedFetch`).
 *
 * Wrapped with timing logs so provider latency is visible: for streaming
 * responses `fetch` resolves when RESPONSE HEADERS arrive (the body streams
 * after), so "in <ms>ms (headers received)" is exactly the provider's
 * time-to-first-byte, and a rejection time pinpoints a headers/body timeout.
 * Chat/Responses calls log at info; bulk embedding calls log at debug so RAG
 * indexing never floods the logs. No secrets are logged — only host + pathname.
 */
export const aiFetch: typeof fetch = async (input, init) => {
  const id = ++requestSeq;
  const method = (init?.method ?? 'GET').toUpperCase();
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  let path = rawUrl;
  try {
    const u = new URL(rawUrl);
    path = u.host + u.pathname;
  } catch {
    // Non-absolute / unparseable URL: keep the raw string (still no secrets).
  }
  const isChat = /\/(chat\/completions|responses)\b/.test(path);
  const log = (msg: string): void =>
    isChat ? logger.log(msg) : logger.debug(msg);
  const startedAt = performance.now();
  log(`provider request #${id} -> ${method} ${path}`);
  try {
    const res = await fetch(input, { ...init, dispatcher } as RequestInit);
    const ms = Math.round(performance.now() - startedAt);
    log(`provider request #${id} <- ${res.status} in ${ms}ms (headers received)`);
    return res;
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt);
    logger.warn(
      `provider request #${id} x after ${ms}ms: ${(err as Error)?.message ?? String(err)}`,
    );
    throw err;
  }
};
