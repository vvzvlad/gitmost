import { createInstrumentedFetch } from './ai-provider-http';

/**
 * createInstrumentedFetch must be behavior-neutral: it delegates to the supplied
 * baseFetch with the SAME input/init, returns the Response object untouched (so
 * the streamed SSE body is never read/cloned), and rethrows the same error. The
 * baseFetch injection is the seam that carries the streaming fetch (#175) onto
 * the chat provider, so it is tested directly.
 */
describe('createInstrumentedFetch', () => {
  it('delegates to the injected baseFetch with the same input/init', async () => {
    const fakeResponse = new Response('ok', { status: 200 });
    const baseFetch = jest.fn().mockResolvedValue(fakeResponse);
    const instrumented = createInstrumentedFetch('test', baseFetch as never);

    const init = { method: 'POST', body: '{"q":1}' };
    const res = await instrumented('https://example.com/v1/chat', init);

    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledWith('https://example.com/v1/chat', init);
    // The Response is returned UNTOUCHED (same reference — never read/cloned).
    expect(res).toBe(fakeResponse);
  });

  it('rethrows the base fetch error unchanged (pre-response failure)', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    const baseFetch = jest.fn().mockRejectedValue(err);
    const instrumented = createInstrumentedFetch('test', baseFetch as never);

    await expect(instrumented('https://example.com/')).rejects.toBe(err);
  });

  it('defaults to the global fetch when no baseFetch is given', () => {
    // Constructing without a baseFetch must not throw — it simply wraps global
    // fetch (the non-chat default).
    expect(() => createInstrumentedFetch('test')).not.toThrow();
  });
});
