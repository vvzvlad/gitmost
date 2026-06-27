import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { AiAgentRolesCatalogProvider } from './ai-agent-roles-catalog.provider';

/**
 * Provider tests against a mocked remote source (no network). They cover the
 * happy read path (fetchIndex / fetchBundle), the malformed-shape rejection,
 * rejection of non-http(s) sources (local sources are gone), and — most
 * importantly — the `^[a-z0-9-]+$` path-traversal guard that runs BEFORE any
 * path/URL is built.
 */
describe('AiAgentRolesCatalogProvider', () => {
  function makeProvider(source: string) {
    const env = {
      getAiAgentRolesCatalogSource: () => source,
    };
    return new AiAgentRolesCatalogProvider(env as never);
  }

  it('non-http(s) source => BadGateway (local sources removed)', async () => {
    for (const source of ['', '/var/lib/agent-roles-catalog', './agent-roles-catalog']) {
      const provider = makeProvider(source);
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    }
  });

  describe('remote fetch streaming size cap', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    /** A web ReadableStream that yields `chunks` (each a Uint8Array). */
    function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
      let i = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(chunks[i++]);
          else controller.close();
        },
        // The provider cancels the reader on the too-large path; no-op here.
        cancel() {},
      });
    }

    /** A ReadableStream whose first read rejects (e.g. a mid-body AbortError). */
    function errorStream(err: Error): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        pull() {
          throw err;
        },
        cancel() {},
      });
    }

    function mockResponse(opts: {
      ok?: boolean;
      status?: number;
      headers?: Record<string, string>;
      body: ReadableStream<Uint8Array> | null;
      text?: string;
    }): Response {
      return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        headers: { get: (k: string) => opts.headers?.[k.toLowerCase()] ?? null },
        body: opts.body,
        text: async () => opts.text ?? 'unused',
      } as unknown as Response;
    }

    it('fetchBundle remote happy path => parses + validates', async () => {
      const json = JSON.stringify({
        schemaVersion: 1,
        language: 'en',
        roles: [
          {
            slug: 'researcher',
            name: 'Researcher',
            instructions: 'be a researcher',
          },
        ],
      });
      const body = streamOf([new TextEncoder().encode(json)]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body })) as never;
      const provider = makeProvider('https://catalog.example.com');
      const bundle = await provider.fetchBundle('general', 'en');
      expect(bundle.roles[0].slug).toBe('researcher');
    });

    it('fetchBundle remote malformed (role missing instructions) => BadGateway', async () => {
      const json = JSON.stringify({
        schemaVersion: 1,
        language: 'fr',
        roles: [{ slug: 'researcher', name: 'Chercheur' }],
      });
      const body = streamOf([new TextEncoder().encode(json)]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body })) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchBundle('general', 'fr')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('declared Content-Length over the cap => BadGateway before reading the body', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        mockResponse({
          headers: { 'content-length': String(2_000_000) },
          body: streamOf([new Uint8Array(10)]),
        }),
      ) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('streamed body exceeding the cap (no/under-reported Content-Length) => BadGateway', async () => {
      // 1.5 MB streamed in 256 KB chunks, with no Content-Length header.
      const chunks = Array.from(
        { length: 6 },
        () => new Uint8Array(256 * 1024),
      );
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body: streamOf(chunks) })) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('fetch rejects (network failure) => BadGateway (unavailable)', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('passes redirect:"error" to fetch (redirect-SSRF hardening)', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          mockResponse({ body: streamOf([new Uint8Array(0)]) }),
        );
      global.fetch = fetchMock as never;
      const provider = makeProvider('https://catalog.example.com');
      // Body shape is irrelevant; an empty stream parses to invalid JSON and
      // throws, but the fetch call (with its init) still happened.
      await expect(provider.fetchIndex()).rejects.toBeDefined();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'error' }),
      );
    });

    it('redirect response rejects (redirect:"error") => BadGateway', async () => {
      // With redirect:"error", the platform fetch rejects on a 3xx instead of
      // following it. Simulate that: the mock rejects when asked not to follow.
      global.fetch = jest.fn().mockImplementation((_url, init) => {
        if (init?.redirect === 'error') {
          return Promise.reject(
            new TypeError('fetch failed: unexpected redirect'),
          );
        }
        return Promise.resolve(
          mockResponse({ status: 302, body: null }),
        );
      }) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('non-ok response (503) => BadGateway carrying the status', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 503, body: null }),
      ) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toThrow(/503/);
    });

    it('small streamed body parses normally (cap not hit)', async () => {
      const json = JSON.stringify({
        schemaVersion: 1,
        bundles: [
          {
            id: 'general',
            name: { en: 'General' },
            languages: ['en'],
            roles: [{ slug: 'researcher', version: 2 }],
          },
        ],
      });
      const body = streamOf([new TextEncoder().encode(json)]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body })) as never;
      const provider = makeProvider('https://catalog.example.com');
      const index = await provider.fetchIndex();
      expect(index.bundles[0].id).toBe('general');
    });

    it('body read aborts mid-stream (AbortError) => BadGateway (not a generic 500)', async () => {
      // The 10s timer aborts the whole request; on a slow/dripping source the
      // body read (reader.read()) rejects with an AbortError AFTER fetch()
      // resolved. The provider must map that to BadGateway, not let it escape.
      const abortErr = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body: errorStream(abortErr) })) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('null body (no readable stream) => response.text() fallback parses', async () => {
      const json = JSON.stringify({
        schemaVersion: 1,
        bundles: [
          {
            id: 'general',
            name: { en: 'General' },
            languages: ['en'],
            roles: [{ slug: 'researcher', version: 2 }],
          },
        ],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body: null, text: json })) as never;
      const provider = makeProvider('https://catalog.example.com');
      const index = await provider.fetchIndex();
      expect(index.bundles[0].id).toBe('general');
    });

    it('null body + text() over the cap => BadGateway (too large)', async () => {
      const oversized = 'a'.repeat(1_000_001);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          mockResponse({ body: null, text: oversized }),
        ) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('invalid JSON body => BadGateway (parse failure)', async () => {
      const body = streamOf([new TextEncoder().encode('{not valid json')]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body })) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('malformed index.json (valid JSON, wrong shape) => BadGateway', async () => {
      // Parses as JSON but fails isCatalogIndex (schemaVersion not a number).
      const body = streamOf([
        new TextEncoder().encode(
          JSON.stringify({ schemaVersion: 'x', bundles: [] }),
        ),
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockResponse({ body })) as never;
      const provider = makeProvider('https://catalog.example.com');
      await expect(provider.fetchIndex()).rejects.toThrow(/malformed/i);
    });
  });

  describe('path-traversal / SSRF guard (^[a-z0-9-]+$)', () => {
    const bad = ['../etc', 'a/b', 'A', 'foo.bar', 'foo_bar', '', '..'];

    for (const value of bad) {
      it(`rejects bundleId="${value}" with BadRequest`, async () => {
        const provider = makeProvider('https://catalog.example.com');
        await expect(
          provider.fetchBundle(value, 'en'),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it(`rejects language="${value}" with BadRequest`, async () => {
        const provider = makeProvider('https://catalog.example.com');
        await expect(
          provider.fetchBundle('general', value),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    }
  });
});
