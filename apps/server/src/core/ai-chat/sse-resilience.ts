import type { ServerResponse } from 'node:http';

/**
 * SSE streaming resilience helpers for the hijacked AI-chat responses.
 *
 * Both AI-chat stream paths (authenticated + public share) hand the AI SDK's
 * UI-message stream straight to the raw Node socket via
 * pipeUIMessageStreamToResponse. Two Safari/WebKit-specific failure modes break
 * that stream where Chrome/Firefox are unaffected; these helpers close both.
 */

/**
 * Keep a hijacked SSE response "making progress" by periodically writing an SSE
 * comment line (": ping\n\n") to the raw socket.
 *
 * Why: while the model is thinking or running tools the UI-message stream emits
 * no bytes. WebKit/Safari aborts a streaming fetch that stops making progress
 * far more aggressively than Chrome (surfaces in the browser as "Load failed"),
 * and reverse proxies time out idle streams as well. A periodic heartbeat keeps
 * bytes flowing so neither drops the connection.
 *
 * A line whose first character is ":" is an SSE comment: the client's
 * EventSourceParserStream ignores it, so it never becomes a UI chunk. Each ping
 * is a COMPLETE SSE record, so interleaving it with the SDK's own writes cannot
 * corrupt an event frame.
 *
 * Returns a stop() that clears the timer; it is also cleared automatically when
 * the response finishes or the socket closes. The interval is unref()'d so it
 * never keeps the process alive, and writes are guarded so we never write to an
 * already-ended/destroyed socket.
 */
export function startSseHeartbeat(
  res: ServerResponse,
  intervalMs = 15_000,
): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      // Socket vanished between the guard and the write; nothing to do.
    }
  }, intervalMs);
  timer.unref?.();

  const stop = (): void => clearInterval(timer);
  res.once('close', stop);
  res.once('finish', stop);
  return stop;
}

/**
 * Strip the hop-by-hop `Connection` / `Keep-Alive` headers the AI SDK adds to
 * its UI-message-stream response (its UI_MESSAGE_STREAM_HEADERS default sets
 * `connection: keep-alive`).
 *
 * Those headers are valid only on an HTTP/1.1 connection. If a reverse proxy
 * forwards them verbatim into an HTTP/2 response, Safari/WebKit REJECTS the
 * whole response while Chrome and Firefox silently ignore it — the exact
 * "works in Chrome, breaks in Safari" symptom. They are hop-by-hop headers the
 * application has no business emitting, so we scrub them at the moment the SDK
 * writes the response head (after which they can no longer be removed).
 *
 * Implemented by wrapping writeHead once for this single hijacked response: the
 * SDK calls res.writeHead(statusCode, headersObject); we delete any
 * connection/keep-alive keys from that object before delegating to the original.
 */
export function stripStreamingHopByHopHeaders(res: ServerResponse): void {
  const originalWriteHead = res.writeHead.bind(res) as (
    ...args: unknown[]
  ) => ServerResponse;

  (
    res as unknown as { writeHead: (...args: unknown[]) => ServerResponse }
  ).writeHead = (...args: unknown[]): ServerResponse => {
    for (const arg of args) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        const headers = arg as Record<string, unknown>;
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase();
          if (lower === 'connection' || lower === 'keep-alive') {
            delete headers[key];
          }
        }
      }
    }
    return originalWriteHead(...args);
  };
}
