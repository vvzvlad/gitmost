import { Logger } from '@nestjs/common';

/**
 * DIAGNOSTIC (provider ECONNRESET investigation) — temporary.
 *
 * A PASSIVE, behavior-neutral wrapper around the global `fetch`, injected into
 * the OpenAI-compatible provider client (`createOpenAI({ fetch })`, the z.ai
 * path). Per provider HTTP call it logs: time-to-response-headers + status +
 * request-body size on success; and on a pre-response rejection the failure
 * latency + error code/cause + request-body size + the idle gap since the
 * previous provider call. It NEVER retries, times out, swaps the dispatcher, or
 * reads/clones the response body — the Response is returned untouched (streaming
 * unaffected) and any error is rethrown unchanged.
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
 * idle-gap figure is approximate (fine for single-user reproduction).
 */
export function createDiagnosticFetch(context: string): typeof fetch {
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
      // Delegate to global fetch; return the Response UNTOUCHED (never read/clone
      // the body) so the streamed SSE response is unaffected.
      const res = await fetch(input, init);
      logger.log(
        `provider HTTP DIAGNOSTIC: call#${callId} OK ` +
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
        `provider HTTP DIAGNOSTIC: call#${callId} PRE-RESPONSE FAILED ` +
          `after=${Date.now() - startedAt}ms code=${e?.cause?.code ?? 'none'} ` +
          `name=${e?.name ?? 'Error'} cause=${e?.cause?.message ?? e?.message ?? 'unknown'} ` +
          `reqBytes=${bodyBytes ?? 'n/a'} idleSincePrevCall=${idleSincePrev ?? 'n/a'}ms`,
      );
      throw err;
    }
  };
}
