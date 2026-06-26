import { Logger } from '@nestjs/common';

/**
 * The provider HTTP fetch used by the chat path: a thin, behavior-neutral
 * instrumentation wrapper around a supplied `fetch`.
 *
 * It defaults to the global `fetch`, but the chat provider passes the streaming
 * fetch (which RAISES undici's 300s stream timeouts to a generous-but-finite
 * silence timeout so a long agent turn is not severed mid-stream — #175). So this
 * wrapper observes the EXACT transport a turn uses. It NEVER retries, times out,
 * swaps the dispatcher, or reads/clones the response body — the Response is
 * returned untouched (streaming unaffected) and any error is rethrown unchanged.
 *
 * Per provider HTTP call it logs: time-to-response-headers + status + request
 * body size on success; and on a pre-response rejection the failure latency +
 * error code/cause + request body size + the idle gap since the previous call.
 * This telemetry is intentional and kept (it diagnoses provider connection
 * resets / mid-stream cuts), and it is load-bearing: the streaming fetch reaches
 * the chat provider THROUGH this wrapper, so the two are one construct.
 *
 * How to read the result (a long agentic turn makes one provider call per step):
 *  - a failed turn whose last provider line is "PRE-RESPONSE FAILED ... ECONNRESET"
 *    => the reset is in the CONNECTION phase of a step's request (the provider
 *    never replied) — usually a poisoned keep-alive socket or the provider/middle
 *    box resetting that request (large body / idle gap are the suspects, hence
 *    reqBytes + idleSincePrevCall below).
 *  - the last line is "OK status=200" and the turn still errors with NO
 *    "PRE-RESPONSE FAILED" => the cut happened MID-STREAM (after headers), a
 *    different failure mode.
 *
 * The seq/last-call timestamps are module-level, so under concurrent turns the
 * idle-gap figure is approximate (fine for single-user diagnosis).
 */
export function createInstrumentedFetch(
  context: string,
  // The underlying fetch to instrument. Defaults to the global fetch; the chat
  // provider passes the streaming fetch (raised, finite undici stream timeouts,
  // #175) so the telemetry observes the SAME transport the long agent turn uses.
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const logger = new Logger(context);
  let callSeq = 0;
  let lastCallStartedAt: number | undefined;

  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const callId = ++callSeq;
    const startedAt = Date.now();
    const idleSincePrev =
      lastCallStartedAt === undefined ? undefined : startedAt - lastCallStartedAt;
    lastCallStartedAt = startedAt;
    // Request body size: the chat payload is a JSON string. Used to test whether
    // failures correlate with the large accumulated context on later agent steps.
    const body = init?.body as unknown;
    const bodyBytes =
      typeof body === 'string'
        ? body.length
        : body instanceof Uint8Array
          ? body.byteLength
          : undefined;
    try {
      // Delegate to the base fetch; return the Response UNTOUCHED (never read/
      // clone the body) so the streamed SSE response is unaffected.
      const res = await baseFetch(input, init);
      logger.log(
        `provider HTTP: call#${callId} OK ` +
          `headersAfter=${Date.now() - startedAt}ms status=${res.status} ` +
          `reqBytes=${bodyBytes ?? 'n/a'} idleSincePrevCall=${idleSincePrev ?? 'n/a'}ms`,
      );
      return res;
    } catch (err) {
      // fetch() rejected => PRE-RESPONSE failure (no headers/body received yet):
      // the connection/request phase. Log it and rethrow the SAME error.
      const e = err as {
        name?: string;
        message?: string;
        cause?: { code?: string; message?: string };
      };
      logger.warn(
        `provider HTTP: call#${callId} PRE-RESPONSE FAILED ` +
          `after=${Date.now() - startedAt}ms code=${e?.cause?.code ?? 'none'} ` +
          `name=${e?.name ?? 'Error'} cause=${e?.cause?.message ?? e?.message ?? 'unknown'} ` +
          `reqBytes=${bodyBytes ?? 'n/a'} idleSincePrevCall=${idleSincePrev ?? 'n/a'}ms`,
      );
      throw err;
    }
  };
}
