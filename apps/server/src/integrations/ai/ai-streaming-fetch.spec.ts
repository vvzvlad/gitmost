import * as http from 'node:http';
import {
  createStreamingFetch,
  withPreResponseRetry,
  streamTimeoutMs,
  streamKeepAliveMs,
  streamingDispatcherOptions,
  isRetryableConnectError,
  preResponseConnectRetries,
  preResponseBackoffMs,
} from './ai-streaming-fetch';

/**
 * #175: undici's default 300s headers/body timeouts severed long agent turns.
 * The streaming fetch raises them to a generous-but-FINITE silence timeout (not
 * 0 — a true hang must still break). We pin: the configured value + env override,
 * that both dispatcher timeouts use it, and that a delayed response streams.
 */
describe('streamTimeoutMs', () => {
  const ORIG = process.env.AI_STREAM_TIMEOUT_MS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AI_STREAM_TIMEOUT_MS;
    else process.env.AI_STREAM_TIMEOUT_MS = ORIG;
  });

  it('defaults to a generous-but-finite 15 minutes', () => {
    delete process.env.AI_STREAM_TIMEOUT_MS;
    expect(streamTimeoutMs()).toBe(900_000);
    // Finite — NOT disabled (0 would let a hung provider leak forever).
    expect(streamTimeoutMs()).toBeGreaterThan(0);
    expect(Number.isFinite(streamTimeoutMs())).toBe(true);
  });

  it('honours a positive AI_STREAM_TIMEOUT_MS override', () => {
    process.env.AI_STREAM_TIMEOUT_MS = '120000';
    expect(streamTimeoutMs()).toBe(120000);
  });

  it('ignores an invalid / non-positive override (falls back to default)', () => {
    for (const bad of ['0', '-5', 'abc', '']) {
      process.env.AI_STREAM_TIMEOUT_MS = bad;
      expect(streamTimeoutMs()).toBe(900_000);
    }
  });

  it('applies the silence timeout + keep-alive recycle window to the dispatcher', () => {
    delete process.env.AI_STREAM_TIMEOUT_MS;
    delete process.env.AI_STREAM_KEEPALIVE_MS;
    expect(streamingDispatcherOptions()).toEqual({
      headersTimeout: 900_000,
      bodyTimeout: 900_000,
      keepAliveTimeout: 4_000,
      keepAliveMaxTimeout: 4_000,
    });
  });
});

describe('streamKeepAliveMs', () => {
  const ORIG = process.env.AI_STREAM_KEEPALIVE_MS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AI_STREAM_KEEPALIVE_MS;
    else process.env.AI_STREAM_KEEPALIVE_MS = ORIG;
  });

  it('defaults to 4s (recycle idle sockets under common ~5s upstream idle cutoffs)', () => {
    delete process.env.AI_STREAM_KEEPALIVE_MS;
    expect(streamKeepAliveMs()).toBe(4_000);
  });

  it('honours a positive override and ignores invalid/non-positive', () => {
    process.env.AI_STREAM_KEEPALIVE_MS = '7000';
    expect(streamKeepAliveMs()).toBe(7000);
    for (const bad of ['0', '-1', 'x', '']) {
      process.env.AI_STREAM_KEEPALIVE_MS = bad;
      expect(streamKeepAliveMs()).toBe(4_000);
    }
  });
});

/**
 * #310: the PRE-RESPONSE retry budget was raised 2 -> 4 (5 total attempts) and
 * made env-configurable so a BURST of upstream resets doesn't exhaust it.
 */
describe('preResponseConnectRetries', () => {
  const ORIG = process.env.AI_STREAM_PRE_RESPONSE_RETRIES;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AI_STREAM_PRE_RESPONSE_RETRIES;
    else process.env.AI_STREAM_PRE_RESPONSE_RETRIES = ORIG;
  });

  it('defaults to 4 retries (5 total attempts)', () => {
    delete process.env.AI_STREAM_PRE_RESPONSE_RETRIES;
    expect(preResponseConnectRetries()).toBe(4);
  });

  it('honours a non-negative override (incl. 0 = single attempt)', () => {
    process.env.AI_STREAM_PRE_RESPONSE_RETRIES = '6';
    expect(preResponseConnectRetries()).toBe(6);
    process.env.AI_STREAM_PRE_RESPONSE_RETRIES = '0';
    expect(preResponseConnectRetries()).toBe(0);
  });

  it('ignores an invalid / negative override (falls back to default 4)', () => {
    for (const bad of ['-1', 'abc', '']) {
      process.env.AI_STREAM_PRE_RESPONSE_RETRIES = bad;
      expect(preResponseConnectRetries()).toBe(4);
    }
  });
});

/**
 * #310: linear `150 * (attempt + 1)` backoff replaced with capped exponential +
 * FULL jitter to avoid a thundering herd of lock-step reconnects. Bound-check the
 * jitter by pinning the randomness source to its extremes.
 */
describe('preResponseBackoffMs', () => {
  it('with rand=0 waits 0 (bottom of the full-jitter window)', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(preResponseBackoffMs(attempt, () => 0)).toBe(0);
    }
  });

  it('with rand=1 returns the capped exponential top of the window', () => {
    // base 150ms, exp = 150 * 2**attempt, capped at 2000ms.
    expect(preResponseBackoffMs(0, () => 1)).toBe(150);
    expect(preResponseBackoffMs(1, () => 1)).toBe(300);
    expect(preResponseBackoffMs(2, () => 1)).toBe(600);
    expect(preResponseBackoffMs(3, () => 1)).toBe(1200);
    // 150 * 2**4 = 2400 -> capped to 2000.
    expect(preResponseBackoffMs(4, () => 1)).toBe(2000);
    expect(preResponseBackoffMs(10, () => 1)).toBe(2000);
  });

  it('stays within [0, cap] and is NOT the old fixed linear value', () => {
    const cap = 2000;
    for (let attempt = 0; attempt < 8; attempt++) {
      for (const r of [0, 0.5, 0.999, 1]) {
        const d = preResponseBackoffMs(attempt, () => r);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
    // The old formula gave a fixed 150*(attempt+1); the jittered one with a
    // mid-range rand does not reproduce it (e.g. attempt 0 -> 75, not 150).
    expect(preResponseBackoffMs(0, () => 0.5)).toBe(75);
    expect(preResponseBackoffMs(0, () => 0.5)).not.toBe(150);
  });
});

describe('isRetryableConnectError', () => {
  it('matches connection-level codes on the error or its cause', () => {
    expect(isRetryableConnectError({ cause: { code: 'ECONNRESET' } })).toBe(true);
    expect(isRetryableConnectError({ cause: { code: 'UND_ERR_SOCKET' } })).toBe(true);
    expect(isRetryableConnectError({ code: 'ECONNREFUSED' })).toBe(true);
  });
  it('does NOT match aborts / unrelated errors', () => {
    expect(isRetryableConnectError({ name: 'AbortError', cause: { code: 'ABORT_ERR' } })).toBe(false);
    expect(isRetryableConnectError({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })).toBe(false);
    expect(isRetryableConnectError(new Error('plain'))).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
  });
});

describe('createStreamingFetch — against a delayed server', () => {
  const ORIG = process.env.AI_STREAM_TIMEOUT_MS;
  let server: http.Server;
  let url: string;
  // The server waits before sending ANY byte (a long time-to-first-token). It is
  // > undici's ~1s timeout-timer granularity so a sub-second configured timeout
  // fires deterministically in the load-bearing test below.
  const DELAY = 1500;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }, DELAY);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as import('node:net').AddressInfo;
    url = `http://127.0.0.1:${addr.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    if (ORIG === undefined) delete process.env.AI_STREAM_TIMEOUT_MS;
    else process.env.AI_STREAM_TIMEOUT_MS = ORIG;
  });

  it('streams the delayed response at the default (generous) timeout', async () => {
    delete process.env.AI_STREAM_TIMEOUT_MS; // default 15 min >> DELAY
    const streamingFetch = createStreamingFetch();
    const res = await streamingFetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('LOAD-BEARING: a sub-DELAY AI_STREAM_TIMEOUT_MS actually severs the response', async () => {
    // Proves the configured dispatcher is wired into the fetch: with the timeout
    // set below DELAY the call must reject with undici's headers-timeout. If the
    // dispatcher were lost (fallback to global fetch's 300s default), the 1.5s
    // response would slip through and this would NOT throw.
    process.env.AI_STREAM_TIMEOUT_MS = '500';
    const streamingFetch = createStreamingFetch();
    let caught: unknown;
    const startedAt = Date.now();
    try {
      await streamingFetch(url).then((r) => r.text());
    } catch (e) {
      caught = e;
    }
    // It rejected (a lost dispatcher -> global 300s default would NOT reject on a
    // 1.5s response) and it did so BEFORE the response would have arrived (DELAY).
    // Use `.name` (realm-safe) — undici's TypeError fails cross-realm instanceof.
    expect(caught).toBeDefined();
    expect((caught as Error)?.name).toBe('TypeError');
    expect(Date.now() - startedAt).toBeLessThan(DELAY);
    // When present, the undici cause is the headers timeout.
    const code = (caught as { cause?: { code?: string } })?.cause?.code;
    if (code) expect(code).toBe('UND_ERR_HEADERS_TIMEOUT');
  });
});

describe('withPreResponseRetry', () => {
  // The retry is the OUTERMOST layer (over the dispatcher-bound streaming fetch),
  // matching ai.service's withPreResponseRetry(instrument(createStreamingFetch())).
  // The budget is env-driven (AI_STREAM_PRE_RESPONSE_RETRIES, default 4 -> 5
  // total attempts). We PIN it to 2 here so the exhaustion test is fast and
  // deterministic regardless of the default; total attempts = retries + 1 = 3.
  const RETRIES = 2;
  const MAX_ATTEMPTS = RETRIES + 1;
  const ORIG_RETRIES = process.env.AI_STREAM_PRE_RESPONSE_RETRIES;
  let server: http.Server;
  let url: string;
  let requests = 0;
  // 'first' resets only the first connection; 'all' resets every connection.
  let resetMode: 'first' | 'all' = 'first';

  const retryingFetch = () => withPreResponseRetry(createStreamingFetch());

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests += 1;
      const shouldReset = resetMode === 'all' || requests === 1;
      if (shouldReset) {
        // Reset before any response byte (a poisoned/stale keep-alive socket).
        const sock = req.socket as import('node:net').Socket & {
          resetAndDestroy?: () => void;
        };
        if (typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy();
        else sock.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as import('node:net').AddressInfo;
    url = `http://127.0.0.1:${addr.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = 0;
    resetMode = 'first';
    process.env.AI_STREAM_PRE_RESPONSE_RETRIES = String(RETRIES);
  });

  afterEach(() => {
    if (ORIG_RETRIES === undefined)
      delete process.env.AI_STREAM_PRE_RESPONSE_RETRIES;
    else process.env.AI_STREAM_PRE_RESPONSE_RETRIES = ORIG_RETRIES;
  });

  it('retries a pre-response reset on a fresh connection and succeeds', async () => {
    resetMode = 'first';
    const res = await retryingFetch()(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    // first request reset -> retry -> second request served.
    expect(requests).toBe(2);
  });

  it('gives up after the retry bound and rethrows the original reset', async () => {
    resetMode = 'all'; // every attempt resets -> retries exhaust
    let caught: unknown;
    try {
      await retryingFetch()(url);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // A retryable connection error reached the caller (not swallowed).
    expect(isRetryableConnectError(caught)).toBe(true);
    // Bounded: exactly AI_STREAM_PRE_RESPONSE_RETRIES + 1 attempts hit the server
    // (pins both the limit and that the final error propagates — guards an
    // off-by-one or an infinite loop).
    expect(requests).toBe(MAX_ATTEMPTS);
  });

  it('honours a raised AI_STREAM_PRE_RESPONSE_RETRIES (more attempts before giving up)', async () => {
    // Env-driven budget: 4 retries -> 5 total attempts against a persistently
    // resetting connect.
    process.env.AI_STREAM_PRE_RESPONSE_RETRIES = '4';
    resetMode = 'all';
    let caught: unknown;
    try {
      await retryingFetch()(url);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isRetryableConnectError(caught)).toBe(true);
    expect(requests).toBe(5);
  });

  it('does NOT retry an aborted request (no retry storm)', async () => {
    resetMode = 'all';
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      retryingFetch()(url, { signal: ctrl.signal }),
    ).rejects.toBeDefined();
    // Pre-aborted: the request never reached the server, so nothing was retried.
    expect(requests).toBe(0);
  });
});
