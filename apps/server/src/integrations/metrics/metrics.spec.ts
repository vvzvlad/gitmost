import { FastifyRequest } from 'fastify';
import { resolveRouteLabel } from './http-metrics.hook';
import {
  firstSqlToken,
  isStreamingResponse,
  sizeBucket,
} from './metrics.constants';
import {
  addMcpDownloadBytes,
  getMetricsRegistry,
  incConnectTimeout,
  incDocLoad,
  incDocUnload,
  incGetPageCacheHit,
  incGetPageCacheMiss,
  incMcpRyowDbrow,
  incMcpRyowExpired,
  incMcpRyowLive,
  isMetricsEnabled,
  observeCollabAuth,
  observeCollabConnect,
  observeCollabLoad,
  observeCollabStore,
  observeMcpTool,
  registerDocsOpenSource,
} from './metrics.registry';

describe('resolveRouteLabel (histogram route label)', () => {
  it('uses the ROUTE TEMPLATE, never the raw URL', () => {
    // routeOptions.url is the matched template; url is the raw path with the id.
    const req = {
      url: '/api/pages/abc-123-def',
      routeOptions: { url: '/api/pages/:id' },
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('/api/pages/:id');
    expect(resolveRouteLabel(req)).not.toContain('abc-123-def');
  });

  it('falls back to "unknown" on a 404 (no matched route template)', () => {
    const req = {
      url: '/totally/unmatched/path',
      routeOptions: {},
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('unknown');
  });

  it('falls back to "unknown" when routeOptions is missing', () => {
    const req = { url: '/x' } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('unknown');
  });

  it.each([
    '/assets/index-CAbxDtto.js',
    '/assets/chunk-3OPIFGDE-CJOt9nr5.js',
    '/assets/excalidraw-menu-DpsI0kFW.js',
    '/vad/silero_vad_v5.onnx',
    '/brand/logo.svg',
    '/locales/en.json',
    '/icons/app-icon-192x192.png',
  ])('collapses hashed/static asset %p to "static" (#362 cardinality)', (url) => {
    // @fastify/static serves each file through a route whose matched url is the
    // raw (hashed) file path, so routeOptions.url is itself unbounded here.
    const req = {
      url,
      routeOptions: { url },
    } as unknown as FastifyRequest;
    const label = resolveRouteLabel(req);
    expect(label).toBe('static');
    expect(label).not.toContain('.js');
    expect(label).not.toContain('index-');
  });

  it('strips the query string before the static-prefix check', () => {
    const req = {
      url: '/assets/index-CAbxDtto.js?v=2',
      routeOptions: { url: '/assets/index-CAbxDtto.js' },
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('static');
  });

  it('does NOT collapse a real API route that merely mentions assets', () => {
    // A templated API route is kept as-is; only the static path PREFIXES collapse.
    const req = {
      url: '/api/pages/assets-guide',
      routeOptions: { url: '/api/pages/:id' },
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('/api/pages/:id');
  });

  it.each([
    // The TRAILING SLASH on the prefix is the anti-false-collapse guard: a path
    // that is the prefix WITHOUT its slash, or merely shares the prefix as a
    // substring of a longer segment, must NOT collapse. These would collapse
    // under a buggy `includes('/assets/')` / slashless-prefix impl.
    '/assets',
    '/assetsx/foo.js',
    '/iconset/x.png',
  ])('does NOT collapse the prefix-boundary case %p', (url) => {
    const req = {
      url,
      routeOptions: { url: '/some/:route' },
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).not.toBe('static');
    expect(resolveRouteLabel(req)).toBe('/some/:route');
  });
});

describe('isStreamingResponse (SSE exclusion)', () => {
  it('excludes text/event-stream responses by content-type', () => {
    expect(isStreamingResponse('text/event-stream', '/api/ai-chat/stream')).toBe(
      true,
    );
    expect(isStreamingResponse('text/event-stream; charset=utf-8', '/x')).toBe(
      true,
    );
  });

  it('excludes known /stream routes by suffix as a fallback', () => {
    expect(isStreamingResponse('application/json', '/api/ai-chat/stream')).toBe(
      true,
    );
    expect(isStreamingResponse(undefined, '/api/shares/ai/stream')).toBe(true);
  });

  it('does not exclude ordinary JSON responses', () => {
    expect(isStreamingResponse('application/json', '/api/pages/:id')).toBe(
      false,
    );
    expect(isStreamingResponse(undefined, '/api/pages/:id')).toBe(false);
  });
});

describe('firstSqlToken (bounded db label)', () => {
  it('returns the lower-cased leading keyword', () => {
    expect(firstSqlToken('SELECT * FROM pages')).toBe('select');
    expect(firstSqlToken('  insert into x values (1)')).toBe('insert');
    expect(firstSqlToken('UPDATE pages SET a=1')).toBe('update');
    expect(firstSqlToken('delete from pages')).toBe('delete');
    expect(firstSqlToken('(SELECT 1)')).toBe('select');
  });

  it('collapses unknown/empty queries to "other"', () => {
    expect(firstSqlToken('')).toBe('other');
    expect(firstSqlToken(undefined)).toBe('other');
    expect(firstSqlToken('123 not sql')).toBe('other');
    expect(firstSqlToken('vacuum analyze')).toBe('other');
  });
});

describe('sizeBucket (#402 bounded size label)', () => {
  it('maps sizes to the four fixed buckets at their boundaries', () => {
    // Boundaries are exclusive-upper: <65536 → lt64k, etc.
    expect(sizeBucket(0)).toBe('lt64k');
    expect(sizeBucket(65535)).toBe('lt64k');
    expect(sizeBucket(65536)).toBe('lt256k');
    expect(sizeBucket(262143)).toBe('lt256k');
    expect(sizeBucket(262144)).toBe('lt1m');
    expect(sizeBucket(1048575)).toBe('lt1m');
    expect(sizeBucket(1048576)).toBe('ge1m');
    expect(sizeBucket(5_000_000)).toBe('ge1m');
  });

  it('falls back to the smallest bucket for invalid sizes', () => {
    // Non-finite / negative / nullish collapse to the smallest, safe default.
    expect(sizeBucket(-1)).toBe('lt64k');
    expect(sizeBucket(NaN)).toBe('lt64k');
    expect(sizeBucket(Infinity)).toBe('lt64k');
    expect(sizeBucket(undefined)).toBe('lt64k');
    expect(sizeBucket(null)).toBe('lt64k');
  });

  it('only ever returns one of the four fixed labels (bounded cardinality)', () => {
    const labels = new Set(
      [0, 65536, 262144, 1048576, -5, NaN].map((b) => sizeBucket(b)),
    );
    for (const l of labels) {
      expect(['lt64k', 'lt256k', 'lt1m', 'ge1m']).toContain(l);
    }
  });
});

describe('metrics helpers are safe no-ops when METRICS_PORT is unset', () => {
  // These specs run without METRICS_PORT, so the registry is never created and
  // every observe/inc/set helper must be a cheap `?.` no-op that never throws.
  beforeAll(() => {
    // Guard the contract this suite depends on: if a CI env set METRICS_PORT,
    // the assertions below would be meaningless, so fail loudly instead.
    expect(process.env.METRICS_PORT).toBeUndefined();
  });

  it('reports metrics disabled and a null registry', () => {
    expect(isMetricsEnabled()).toBe(false);
    expect(getMetricsRegistry()).toBeNull();
  });

  it('does not throw from any #402 collab/MCP helper', () => {
    expect(() => {
      observeCollabLoad(123456, 0.01);
      observeCollabStore(123456, 0.02);
      observeCollabConnect(0.03);
      observeCollabAuth(0.04);
      observeMcpTool('some-tool', 0.05);
      incDocLoad();
      incDocUnload();
      incConnectTimeout();
      incGetPageCacheHit();
      incGetPageCacheMiss();
      addMcpDownloadBytes('downloadFile', 4096);
      // A garbage value must not throw either (prom-client throws on inc(<0)).
      addMcpDownloadBytes('downloadFile', -1);
      addMcpDownloadBytes('downloadFile', Number.NaN);
      // #654 — the RYOW freshness helpers must be no-ops too when disabled.
      incMcpRyowLive();
      incMcpRyowDbrow('owner_unreachable');
      incMcpRyowExpired();
      // Registering a source must not create the gauge or invoke the fn.
      registerDocsOpenSource(() => {
        throw new Error('docsOpenSource must NOT be called when disabled');
      });
    }).not.toThrow();
  });
});
