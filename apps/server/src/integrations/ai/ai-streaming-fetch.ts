import { Agent } from 'undici';

/**
 * Default SILENCE timeout for streaming AI calls (15 min). Generous, but FINITE.
 *
 * Node's global fetch (undici) defaults headersTimeout and bodyTimeout to
 * 300_000ms, which severed legitimate long agent turns mid-stream — surfacing as
 * "Lost connection to the AI provider" (#175): a late step with a huge context
 * pushes the model's time-to-first-token past 5 min, or a reasoning model pauses
 * >5 min between chunks. We do NOT disable the timeout (0) — that would let a
 * genuinely hung provider, with the client still connected, hang forever
 * (abortSignal only fires on client disconnect). Instead we raise it well above
 * any realistic gap while keeping it finite so a true hang is eventually broken.
 *
 * This bounds SILENCE (time-to-first-byte and the gap BETWEEN chunks), NOT total
 * turn duration — so an arbitrarily long turn that keeps streaming bytes is never
 * cut; only a stream that goes quiet for longer than this is treated as a hang.
 */
const DEFAULT_STREAM_TIMEOUT_MS = 900_000;

/**
 * Default keep-alive recycle window (4s). A pooled connection idle longer than
 * this is CLOSED rather than reused.
 *
 * Long agent turns leave gaps of tens of seconds between provider calls (one
 * call per step; a crawl/search tool runs in between). A NAT / reverse proxy /
 * conntrack in front of the deployment silently drops an idle connection after
 * its own timeout; undici, not knowing, then reuses that dead socket and the
 * next request fails PRE-RESPONSE with `read ECONNRESET` (#175 prod telemetry:
 * the resets correlate with idleSincePrevCall ~42s, while a direct path to the
 * provider does NOT reset). Recycling idle sockets well below such a drop window
 * means a long-gap call opens a fresh connection instead of reusing a stale one.
 * Kept comfortably under common ~5s upstream/middlebox idle cutoffs so undici
 * recycles the socket before the network kills it, while still long enough to
 * reuse a connection within a single burst of back-to-back calls (#310).
 * `keepAliveMaxTimeout` also caps a server-advertised keep-alive so the provider
 * cannot push the reuse window back up.
 */
const DEFAULT_STREAM_KEEPALIVE_MS = 4_000;

/**
 * Default number of times to retry a PRE-RESPONSE connection failure (a
 * reset/timeout before ANY response byte) on a fresh connection. Safe because
 * `fetch()` only rejects before the Response resolves — a started stream is
 * never replayed.
 *
 * Raised from 2 to 4 (total 5 attempts) so a short BURST of upstream/middlebox
 * resets is absorbed without exhausting the budget: prod saw 2 of 3 attempts
 * burned on a single turn, leaving no headroom (#310). Override with
 * `AI_STREAM_PRE_RESPONSE_RETRIES`.
 */
const DEFAULT_PRE_RESPONSE_CONNECT_RETRIES = 4;

/**
 * Configured PRE-RESPONSE retry budget. Override with
 * `AI_STREAM_PRE_RESPONSE_RETRIES`; a missing/invalid/negative value falls back
 * to {@link DEFAULT_PRE_RESPONSE_CONNECT_RETRIES}. Total attempts = value + 1.
 * 0 disables the retry (a single attempt).
 */
export function preResponseConnectRetries(): number {
  // Read the raw string first: an empty/whitespace value coerces to 0 via
  // Number(), which is a VALID setting here (0 = single attempt), so it must be
  // treated as "unset" rather than "disable the retry".
  const rawStr = process.env.AI_STREAM_PRE_RESPONSE_RETRIES;
  if (rawStr === undefined || rawStr.trim() === '') {
    return DEFAULT_PRE_RESPONSE_CONNECT_RETRIES;
  }
  const raw = Number(rawStr);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_PRE_RESPONSE_CONNECT_RETRIES;
}

/** Base backoff before the first PRE-RESPONSE retry (ms). */
const PRE_RESPONSE_BACKOFF_BASE_MS = 150;

/** Cap on the exponential backoff window before jitter (ms). */
const PRE_RESPONSE_BACKOFF_CAP_MS = 2_000;

/**
 * Backoff (ms) to wait before PRE-RESPONSE retry number `attempt` (0-based).
 *
 * Capped exponential with FULL jitter: `delay = random in [0, min(base*2^attempt,
 * cap)]`. Full jitter spreads concurrent retries across the whole window so a
 * burst of turns that all reset at once do not reconnect in lock-step and
 * hammer the upstream in a thundering herd (#310); the exponential growth backs
 * off harder as resets persist, and the cap keeps the wait bounded.
 */
export function preResponseBackoffMs(
  attempt: number,
  rand: () => number = Math.random,
): number {
  const exp = PRE_RESPONSE_BACKOFF_BASE_MS * 2 ** attempt;
  const capped = Math.min(exp, PRE_RESPONSE_BACKOFF_CAP_MS);
  return rand() * capped;
}

/** undici cause codes for a connection-level failure that occurred PRE-RESPONSE. */
const RETRYABLE_CONNECT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The configured silence timeout (ms). Override with `AI_STREAM_TIMEOUT_MS`; a
 * missing/invalid/non-positive value falls back to {@link DEFAULT_STREAM_TIMEOUT_MS}.
 */
export function streamTimeoutMs(): number {
  return positiveEnv('AI_STREAM_TIMEOUT_MS', DEFAULT_STREAM_TIMEOUT_MS);
}

/** Keep-alive recycle window (ms). Override with `AI_STREAM_KEEPALIVE_MS`. */
export function streamKeepAliveMs(): number {
  return positiveEnv('AI_STREAM_KEEPALIVE_MS', DEFAULT_STREAM_KEEPALIVE_MS);
}

/** Default SILENCE timeout for EXTERNAL-MCP transport (1 min). */
const DEFAULT_MCP_STREAM_TIMEOUT_MS = 60_000;

/** Default total wall-clock cap for ONE external MCP tool call (2 min). */
const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000;

/**
 * Default `bodyTimeout` for the EXTERNAL-MCP SSE transport (10 min) — #489.
 * Deliberately much LARGER than {@link DEFAULT_MCP_STREAM_TIMEOUT_MS}.
 */
const DEFAULT_MCP_SSE_BODY_TIMEOUT_MS = 600_000;

/**
 * SILENCE timeout (ms) for EXTERNAL-MCP transport ONLY. Override with
 * `AI_MCP_STREAM_TIMEOUT_MS`; a missing/invalid/non-positive value falls back to
 * {@link DEFAULT_MCP_STREAM_TIMEOUT_MS} (1 min).
 *
 * Deliberately tighter than the chat provider's {@link streamTimeoutMs} (15 min)
 * so a byte-silent/hung MCP upstream is broken in ~1 min instead of 15. This is
 * the undici `headersTimeout`/`bodyTimeout` for the external-MCP dispatcher only
 * — it must NOT change the chat provider, which legitimately needs 15 min between
 * reasoning chunks (#175).
 *
 * Trade-off: a legitimately long but byte-silent single tool call (a slow crawl
 * that emits nothing until done) and an SSE transport that idles >5 min BETWEEN
 * tool calls are also cut here. The per-call total cap ({@link mcpCallTimeoutMs},
 * applied in mcp-clients.service) is the complementary guard for chatty-but-stuck
 * calls that keep the socket warm yet never return.
 */
export function mcpStreamTimeoutMs(): number {
  return positiveEnv('AI_MCP_STREAM_TIMEOUT_MS', DEFAULT_MCP_STREAM_TIMEOUT_MS);
}

/**
 * Total wall-clock cap (ms) for ONE external MCP tool call — APP-LEVEL, not
 * transport. Override with `AI_MCP_CALL_TIMEOUT_MS`; a missing/invalid/
 * non-positive value falls back to {@link DEFAULT_MCP_CALL_TIMEOUT_MS} (2 min).
 *
 * Catches a tool that keeps the connection warm (SSE heartbeats / trickle) but
 * never returns a result — which the transport silence timeout
 * ({@link mcpStreamTimeoutMs}) would never break because the socket never goes
 * byte-silent.
 */
export function mcpCallTimeoutMs(): number {
  return positiveEnv('AI_MCP_CALL_TIMEOUT_MS', DEFAULT_MCP_CALL_TIMEOUT_MS);
}

/**
 * `bodyTimeout` (ms) for the EXTERNAL-MCP **SSE** transport ONLY — #489. Override
 * with `AI_MCP_SSE_BODY_TIMEOUT_MS`; a missing/invalid/non-positive value falls
 * back to {@link DEFAULT_MCP_SSE_BODY_TIMEOUT_MS} (10 min).
 *
 * The SSE transport holds ONE long-lived response body open across many tool
 * calls, so undici's `bodyTimeout` (time between body bytes) counts the LEGITIMATE
 * silence BETWEEN calls, not just a hung single call. At the tight HTTP silence
 * timeout ({@link mcpStreamTimeoutMs}, 1 min) a normal >1-min gap between the
 * model's tool calls would break the SSE socket, and the cache would then serve a
 * dead client until TTL. So the SSE transport gets its OWN, RAISED bodyTimeout;
 * the per-call total cap ({@link mcpCallTimeoutMs}) still bounds a single stuck
 * call, and the app-level transport-error retry heals a socket that does break.
 * The HTTP (streamable) transport keeps the tight timeout — it opens a fresh
 * request per call, so idle-between-calls does not apply there.
 */
export function mcpSseBodyTimeoutMs(): number {
  return positiveEnv('AI_MCP_SSE_BODY_TIMEOUT_MS', DEFAULT_MCP_SSE_BODY_TIMEOUT_MS);
}

/**
 * undici `Agent` options for streaming AI traffic — the (generous, finite)
 * silence timeouts plus the keep-alive recycle window. Shared by the chat
 * provider fetch and the external-MCP dispatcher so they behave identically.
 */
export function streamingDispatcherOptions(): {
  headersTimeout: number;
  bodyTimeout: number;
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
} {
  const t = streamTimeoutMs();
  const ka = streamKeepAliveMs();
  return {
    headersTimeout: t,
    bodyTimeout: t,
    keepAliveTimeout: ka,
    keepAliveMaxTimeout: ka,
  };
}

/** True for a connection-level error worth retrying on a fresh connection. */
export function isRetryableConnectError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' && RETRYABLE_CONNECT_CODES.has(code);
}

/**
 * Build a `fetch` for long-lived streaming AI calls (the agent chat turn) backed
 * by a dedicated undici dispatcher (finite silence timeouts + keep-alive
 * recycling, #175). A single shared dispatcher is returned (callers hold it for
 * the service lifetime) so its connection pool is reused.
 *
 * This is the BASE transport — no retry. The chat path wraps it as
 * `withPreResponseRetry(createInstrumentedFetch(ctx, createStreamingFetch()))`
 * so the retry is the OUTERMOST layer and the instrumentation observes EVERY
 * attempt (a recovered reset is still logged — see withPreResponseRetry).
 */
export function createStreamingFetch(): typeof fetch {
  const dispatcher = new Agent(streamingDispatcherOptions());
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, {
      ...(init ?? {}),
      // `dispatcher` is an undici-specific init field (not in the DOM
      // RequestInit type); Node's global fetch reads it. Cast to satisfy it.
      dispatcher,
    } as RequestInit & { dispatcher: Agent })) as typeof fetch;
}

/**
 * Wrap a fetch so a PRE-RESPONSE connection reset (`baseFetch` rejects before the
 * Response resolves — so nothing has streamed) is retried a few times on a fresh
 * connection (#175). A poisoned keep-alive socket is destroyed by undici on the
 * reset, so the retry lands on a new connection. An abort (client disconnect) is
 * never retried.
 *
 * This is the OUTERMOST transport layer by design: composing it as
 * `withPreResponseRetry(instrumentedFetch)` means every attempt — including the
 * resets that the retry recovers from — flows through the instrumentation, so the
 * "PRE-RESPONSE FAILED ... ECONNRESET ... idleSincePrevCall" telemetry stays
 * visible precisely when the fix is working (and AI_STREAM_KEEPALIVE_MS can be
 * tuned from real data). A retry INSIDE the transport would hide it.
 */
export function withPreResponseRetry(baseFetch: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const maxRetries = preResponseConnectRetries();
    for (let attempt = 0; ; attempt++) {
      try {
        return await baseFetch(input, init);
      } catch (err) {
        const aborted = init?.signal?.aborted === true;
        if (aborted || attempt >= maxRetries || !isRetryableConnectError(err)) {
          throw err;
        }
        // Jittered backoff before the fresh-connection retry (anti-thundering-herd).
        await new Promise((resolve) =>
          setTimeout(resolve, preResponseBackoffMs(attempt)),
        );
      }
    }
  }) as typeof fetch;
}
