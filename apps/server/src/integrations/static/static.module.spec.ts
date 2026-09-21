import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  resolveStaticAssetHeaders,
  shouldServeSpaShell,
  StaticModule,
} from './static.module';

// The REAL StaticModule resolves the client bundle from its own compiled location
// (apps/client/dist) and REWRITES index.html in place (window.CONFIG injection), so
// point it at a throwaway dir: that lets the integration test below drive the actual
// module (onModuleInit → the actual route registration + the actual catch-all
// handler) instead of a hand-built lookalike that could not catch a regression in
// the module itself.
const mockClientDistPath = fs.mkdtempSync(
  join(os.tmpdir(), 'static-module-dist-'),
);
jest.mock('../../common/helpers/client-version', () => ({
  resolveClientDistPath: () => mockClientDistPath,
}));

// Unit tests for the static-asset cache classifier extracted from the
// @fastify/static setHeaders callback (precedent: sandbox.controller.spec.ts).
describe('resolveStaticAssetHeaders', () => {
  it('marks a content-hashed /assets/ file immutable and sets Vary', () => {
    const headers = resolveStaticAssetHeaders(
      '/app/apps/client/dist/assets/index-a1b2c3.js',
    );
    expect(headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(headers['vary']).toBe('Accept-Encoding');
  });

  it('makes index.html always revalidate (never immutable)', () => {
    const headers = resolveStaticAssetHeaders(
      '/app/apps/client/dist/index.html',
    );
    expect(headers['cache-control']).toBe(
      'no-cache, no-store, must-revalidate',
    );
    expect(headers['vary']).toBe('Accept-Encoding');
  });

  it('does NOT mark a non-hashed asset immutable but still sets Vary', () => {
    const headers = resolveStaticAssetHeaders(
      '/app/apps/client/dist/locales/en.json',
    );
    // No immutable cache-control — this path keeps @fastify/static's default
    // etag/last-modified revalidation.
    expect(headers['cache-control']).toBeUndefined();
    expect(headers['vary']).toBe('Accept-Encoding');
  });
});

// Integration test proving the ACTUAL response header emitted by @fastify/static
// with the exact registration options StaticModule uses. This is the regression
// guard for #452: without `cacheControl: false`, @fastify/static writes its own
// `Cache-Control: public, max-age=0` AFTER the setHeaders callback, overwriting
// the immutable header — the /assets/ assertion below would then fail.
describe('static.module @fastify/static registration (integration)', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'static-module-spec-'));
    fs.mkdirSync(join(tmpDir, 'assets'), { recursive: true });
    fs.mkdirSync(join(tmpDir, 'locales'), { recursive: true });
    fs.writeFileSync(
      join(tmpDir, 'assets', 'index-a1b2c3.js'),
      'console.log(1);',
    );
    fs.writeFileSync(join(tmpDir, 'locales', 'en.json'), '{"hello":"world"}');

    app = Fastify();
    // Mirror StaticModule.onModuleInit's registration options exactly.
    await app.register(fastifyStatic, {
      root: tmpDir,
      wildcard: false,
      preCompressed: true,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        for (const [name, value] of Object.entries(
          resolveStaticAssetHeaders(filePath),
        )) {
          res.setHeader(name, value);
        }
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves a hashed /assets/ file with an immutable, 1-year cache-control', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/assets/index-a1b2c3.js',
    });
    expect(res.statusCode).toBe(200);
    const cacheControl = res.headers['cache-control'];
    expect(cacheControl).toContain('immutable');
    expect(cacheControl).toContain('max-age=31536000');
  });

  it('serves a non-hashed /locales/ file WITHOUT an immutable cache-control', async () => {
    const res = await app.inject({ method: 'GET', url: '/locales/en.json' });
    expect(res.statusCode).toBe(200);
    // resolveStaticAssetHeaders sets no cache-control here and cacheControl:false
    // stops @fastify/static from adding one, so the browser revalidates by
    // etag/last-modified — either an absent header or one without `immutable`.
    const cacheControl = res.headers['cache-control'];
    if (cacheControl !== undefined) {
      expect(cacheControl).not.toContain('immutable');
    }
  });
});

// #636 — the SPA catch-all must NOT answer the machine-readable /.well-known/
// namespace (RFC 8615) with a 200 text/html shell: an MCP client that starts
// OAuth discovery after a 401 from /mcp then dies on "Failed to parse JSON"
// instead of getting an honest 404.
describe('shouldServeSpaShell (#636)', () => {
  it.each([
    '/.well-known',
    '/.well-known/',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/security.txt',
    '/.well-known/anything/deep/nested',
    // A query string must not smuggle the path past the check.
    '/.well-known/oauth-protected-resource?foo=1',
    // The predicate is fed Fastify's DECODED `req.params['*']`, so these all arrive
    // here already decoded — assert the decoded shapes reach the same verdict (the
    // raw forms are exercised end-to-end in the integration test below, which is
    // what proves the handler feeds the decoded value).
    '.well-known/oauth-protected-resource', // a caller passing a relative path
    // Repeated leading slashes: Fastify does NOT collapse them, so `//.well-known/x`
    // arrives verbatim and must not slip past.
    '//.well-known/oauth-protected-resource',
    '///.well-known/x',
    '//.well-known',
    // Dot-segments. Fastify does NOT collapse a `..` that was smuggled in
    // percent-encoded: `GET /a/..%2f.well-known/x` reaches the handler with
    // `params['*'] === '/a/../.well-known/x'`, which does not literally start with
    // `/.well-known/`. The predicate resolves the dot-segments itself, so it sees
    // the reserved namespace this really is.
    '/a/../.well-known/x',
    '/a/../.well-known/oauth-protected-resource',
    '/a/b/../../.well-known/x',
    '/./.well-known/x',
    '/.well-known/./oauth-protected-resource',
    '/foo/../.well-known/../.well-known/x',
  ])('does NOT serve the SPA shell for %s', (path) => {
    expect(shouldServeSpaShell(path)).toBe(false);
  });

  it.each([
    '/',
    '/home',
    '/p/my-page-slug',
    '/settings/account/profile',
    '/settings/x',
    '/s/space-slug/home',
    // The app's own client-side 404 page is still an SPA route.
    '/this-route-does-not-exist',
    '/share/abc123',
    // Not the reserved namespace: a normal path that merely mentions it.
    '/well-known',
    '/docs/.well-known-guide',
    '/p/.well-known',
    // The mirror of the smuggling case above: the dot-segments resolve OUT of the
    // reserved namespace, so this really is the plain SPA route `/home` and must be
    // served the shell. (`GET /.well-known/..%2fhome` arrives as
    // `/.well-known/../home`.) Resolving `..` must route BOTH ways, not just block.
    '/.well-known/../home',
    '/.well-known/../',
    // `..` cannot escape above the root: this is just `/home`.
    '/../../home',
  ])('serves the SPA shell for %s', (path) => {
    expect(shouldServeSpaShell(path)).toBe(true);
  });
});

// End-to-end proof of the acceptance criteria against the REAL StaticModule: its
// onModuleInit registers @fastify/static + the SPA catch-all on a real Fastify
// instance, and every assertion below goes through the module's OWN handler. This
// is the regression guard for the fix itself — delete the `shouldServeSpaShell`
// gate from static.module.ts and this describe goes red. (A hand-built lookalike
// route in the spec could not do that: it would keep passing with the module
// broken.)
describe('StaticModule.onModuleInit — the real SPA catch-all (#636, integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    fs.mkdirSync(join(mockClientDistPath, 'assets'), { recursive: true });
    fs.writeFileSync(
      join(mockClientDistPath, 'assets', 'index-a1b2c3.js'),
      'console.log(1);',
    );
    // The window-config marker is what onModuleInit replaces — including it proves
    // the module's real boot-time HTML rewrite ran.
    fs.writeFileSync(
      join(mockClientDistPath, 'index.html'),
      '<!doctype html><html><head><!--window-config--></head><body>spa</body></html>',
    );

    app = Fastify();

    // Nest collaborators the module pulls its dist path / client config from. The
    // module only calls these getters; bare stubs suffice.
    const httpAdapterHost = { httpAdapter: { getInstance: () => app } };
    const environmentService = {
      getNodeEnv: () => 'test',
      getAppUrl: () => 'http://localhost:3000',
      isCloud: () => false,
      isCompactPageTreeEnabled: () => false,
      getFileUploadSizeLimit: () => '50mb',
      getFileImportSizeLimit: () => '200mb',
      getDrawioUrl: () => '',
      getSubdomainHost: () => '',
      getCollabUrl: () => '',
      getBillingTrialDays: () => 30,
      getPostHogHost: () => '',
      getPostHogKey: () => '',
      isClientTelemetryEnabled: () => false,
      isLocalFirstEnabled: () => false,
      // #640 — OFFLINE_GRACE mirror; onModuleInit reads it for window.CONFIG.
      getOfflineGrace: () => '30d',
      isDrawioRasterEnabled: () => false,
      isExcalidrawRasterEnabled: () => false,
    };

    const staticModule = new StaticModule(
      httpAdapterHost as any,
      environmentService as any,
    );
    await staticModule.onModuleInit();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(mockClientDistPath, { recursive: true, force: true });
  });

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/security.txt',
    '/.well-known',
    '/.well-known/',
    // #636 F4 — the raw url of each of these does NOT literally start with
    // `/.well-known/`, yet they all reach the SPA catch-all. Fastify hands the
    // handler a percent-DECODED, `..`-normalised `req.params['*']`, which is what
    // the handler matches on; a check against `req.url` would serve the shell here.
    '/%2ewell-known/oauth-protected-resource',
    '/.well-%6bnown/oauth-protected-resource',
    '/%2e%77ell-known/oauth-protected-resource',
    '/.well-known/../.well-known/oauth-protected-resource',
    '/foo/../.well-known/oauth-protected-resource',
    // Repeated leading slashes are NOT collapsed by Fastify.
    '//.well-known/oauth-protected-resource',
    '///.well-known/oauth-protected-resource',
    // A `..` smuggled in percent-encoded: Fastify decodes the `%2f` but does NOT
    // collapse the dot-segment it creates, so `params['*']` is `/a/../.well-known/x`
    // — a path the SPA shell used to be served for. shouldServeSpaShell resolves the
    // dot-segments itself, which is what makes these 404.
    '/a/..%2f.well-known/x',
    '/a/..%2F.well-known/oauth-protected-resource',
    '/a/..%2f..%2f.well-known/security.txt',
  ])('answers %s with a JSON 404, not the HTML shell', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-type']).not.toContain('text/html');
    // The body must PARSE as JSON — this is exactly what the MCP client's
    // discovery does, and what used to blow up on the SPA's HTML.
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(res.body).not.toContain('<!doctype html>');
  });

  it.each([
    '/',
    '/home',
    '/p/my-page-slug',
    '/settings/x',
    '/s/space-slug/home',
    '/no-such-app-route',
    // Merely mentioning the reserved name is not the reserved namespace.
    '/well-known',
    '/p/.well-known',
    // The mirror of the smuggled `..` above: here the dot-segments resolve OUT of
    // the reserved namespace (`params['*']` is `/.well-known/../home`), so this is
    // the ordinary SPA route `/home` and must still get the shell — resolving `..`
    // must route both ways, not just 404 everything containing `.well-known`.
    '/.well-known/..%2fhome',
  ])('still serves the SPA shell with 200 for %s', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!doctype html>');
    // The shell the module actually rewrote at boot, not the raw template.
    expect(res.body).toContain('window.CONFIG=');
  });

  it('still serves a real static asset (the catch-all did not swallow it)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/assets/index-a1b2c3.js',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1);');
    expect(res.headers['cache-control']).toContain('immutable');
  });
});
