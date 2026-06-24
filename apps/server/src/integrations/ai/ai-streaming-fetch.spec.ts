import * as http from 'node:http';
import {
  createStreamingFetch,
  streamTimeoutMs,
  streamKeepAliveMs,
  streamingDispatcherOptions,
  isRetryableConnectError,
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
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 10_000,
    });
  });
});

describe('streamKeepAliveMs', () => {
  const ORIG = process.env.AI_STREAM_KEEPALIVE_MS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AI_STREAM_KEEPALIVE_MS;
    else process.env.AI_STREAM_KEEPALIVE_MS = ORIG;
  });

  it('defaults to 10s (recycle idle sockets so a NAT/proxy drop cannot poison reuse)', () => {
    delete process.env.AI_STREAM_KEEPALIVE_MS;
    expect(streamKeepAliveMs()).toBe(10_000);
  });

  it('honours a positive override and ignores invalid/non-positive', () => {
    process.env.AI_STREAM_KEEPALIVE_MS = '4000';
    expect(streamKeepAliveMs()).toBe(4000);
    for (const bad of ['0', '-1', 'x', '']) {
      process.env.AI_STREAM_KEEPALIVE_MS = bad;
      expect(streamKeepAliveMs()).toBe(10_000);
    }
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

describe('createStreamingFetch — pre-response connection retry', () => {
  let server: http.Server;
  let url: string;
  let requests = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests += 1;
      if (requests === 1) {
        // Reset the FIRST connection before any response byte (a poisoned/stale
        // keep-alive socket). The retry must open a fresh connection.
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
  });

  it('retries a pre-response reset on a fresh connection and succeeds', async () => {
    const streamingFetch = createStreamingFetch();
    const res = await streamingFetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    // first request reset -> retry -> second request served.
    expect(requests).toBeGreaterThanOrEqual(2);
  });

  it('does NOT retry an aborted request (no retry storm)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const streamingFetch = createStreamingFetch();
    await expect(streamingFetch(url, { signal: ctrl.signal })).rejects.toBeDefined();
    // Pre-aborted: the request never reached the server, so nothing was retried.
    expect(requests).toBe(0);
  });
});
