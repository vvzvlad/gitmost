import * as http from 'node:http';
import { RetryAgent } from 'undici';

// A short header timeout makes the #140 "header stall" deterministic and fast.
// Must be set BEFORE importing ai-http (the undici agents read it at module load).
process.env.AI_HTTP_HEADERS_TIMEOUT_MS = '800';

import { aiFetch } from './ai-http';

/**
 * Light, dependency-free unit checks for the shared AI HTTP layer. The module
 * constructs its undici dispatcher eagerly at import time, so importing it here
 * already exercises that construction; we make NO real network calls.
 */
describe('ai-http', () => {
  it('exports aiFetch as a function', () => {
    expect(typeof aiFetch).toBe('function');
  });

  it('constructs the dispatcher eagerly without throwing at import time', () => {
    // Reaching this assertion means the top-level Agent/RetryAgent construction
    // in ai-http.ts did not throw when the module was imported above.
    expect(aiFetch).toBeDefined();
  });

  it('forwards the resilient RetryAgent dispatcher into the underlying fetch', async () => {
    // CRITICAL regression guard: aiFetch must inject the shared undici dispatcher
    // into the real fetch call, otherwise AI traffic silently falls back to the
    // default global agent and the ECONNRESET production bug returns. aiFetch
    // resolves `fetch` at call time, so spying on globalThis.fetch intercepts it
    // and prevents any real network call.
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null));
    try {
      await aiFetch('https://example.invalid/', { method: 'POST' });

      expect(spy).toHaveBeenCalledTimes(1);
      const init = spy.mock.calls[0][1] as {
        dispatcher?: unknown;
        method?: string;
      };
      // The dispatcher must be the resilient RetryAgent, not the default agent.
      expect(init.dispatcher).toBeInstanceOf(RetryAgent);
      // `{ ...init }` spreading must preserve the caller's original options.
      expect(init.method).toBe('POST');
    } finally {
      // Never let the global fetch stub leak into other tests.
      spy.mockRestore();
    }
  });
});

/**
 * #140 regression: a provider that accepts the request but stalls without ever
 * sending response headers must FAIL FAST (at headersTimeout — set to 800ms
 * above, not undici's 300s default) and be RETRIED on a fresh connection.
 * headersTimeout only bounds time-to-headers, so a healthy fast response is
 * unaffected. Uses a real loopback server; makes no external network calls.
 */
describe('aiFetch header-stall resilience (#140)', () => {
  function makeServer(
    handler: http.RequestListener,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        resolve({
          url: `http://127.0.0.1:${port}/health`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
  }

  it('retries a header stall on a fresh connection and recovers', async () => {
    let attempts = 0;
    const { url, close } = await makeServer((_req, res) => {
      attempts++;
      // First attempt: never send headers -> UND_ERR_HEADERS_TIMEOUT -> retry.
      if (attempts === 1) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, servedOnAttempt: attempts }));
    });
    try {
      const res = await aiFetch(url, { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { servedOnAttempt: number };
      expect(attempts).toBeGreaterThanOrEqual(2); // the stalled attempt was retried
      expect(body.servedOnAttempt).toBeGreaterThanOrEqual(2);
    } finally {
      await close();
    }
  }, 15000);

  it('passes a healthy fast response straight through (one attempt)', async () => {
    let attempts = 0;
    const { url, close } = await makeServer((_req, res) => {
      attempts++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const res = await aiFetch(url, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(attempts).toBe(1);
    } finally {
      await close();
    }
  }, 15000);
});
