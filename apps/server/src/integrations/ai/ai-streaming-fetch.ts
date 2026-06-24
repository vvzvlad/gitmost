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
 * The configured silence timeout (ms). Override with `AI_STREAM_TIMEOUT_MS`; a
 * missing/invalid/non-positive value falls back to {@link DEFAULT_STREAM_TIMEOUT_MS}.
 */
export function streamTimeoutMs(): number {
  const raw = Number(process.env.AI_STREAM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_TIMEOUT_MS;
}

/**
 * undici `Agent` timeout options for streaming AI traffic — both stream timeouts
 * set to the (generous, finite) silence timeout. Shared by the chat provider
 * fetch and the external-MCP dispatcher so they behave identically (#175).
 */
export function streamingDispatcherOptions(): {
  headersTimeout: number;
  bodyTimeout: number;
} {
  const t = streamTimeoutMs();
  return { headersTimeout: t, bodyTimeout: t };
}

/**
 * Build a `fetch` for long-lived streaming AI calls (the agent chat turn) backed
 * by a dedicated undici dispatcher whose stream timeouts are the generous-but-
 * finite silence timeout above (#175). A single shared dispatcher is returned
 * (callers hold it for the service lifetime) so its connection pool is reused.
 */
export function createStreamingFetch(): typeof fetch {
  const dispatcher = new Agent(streamingDispatcherOptions());
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, {
      ...(init ?? {}),
      // `dispatcher` is an undici-specific init field (not in the DOM RequestInit
      // type); Node's global fetch reads it. Cast to satisfy the type.
      dispatcher,
    } as RequestInit & { dispatcher: Agent })) as typeof fetch;
}
