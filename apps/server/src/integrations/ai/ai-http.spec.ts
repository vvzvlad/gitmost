import { RetryAgent } from 'undici';

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
