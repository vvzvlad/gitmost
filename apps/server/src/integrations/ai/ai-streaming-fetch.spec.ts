import * as http from 'node:http';
import {
  createStreamingFetch,
  streamTimeoutMs,
  streamingDispatcherOptions,
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

  it('applies the timeout to BOTH undici stream timeouts', () => {
    delete process.env.AI_STREAM_TIMEOUT_MS;
    expect(streamingDispatcherOptions()).toEqual({
      headersTimeout: 900_000,
      bodyTimeout: 900_000,
    });
  });
});

describe('createStreamingFetch — against a delayed server', () => {
  let server: http.Server;
  let url: string;
  // The server waits before sending ANY byte (a long time-to-first-token).
  const DELAY = 400;

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

  it('streams the delayed response instead of timing out', async () => {
    const streamingFetch = createStreamingFetch();
    const res = await streamingFetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
