import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { join } from 'path';
import * as fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import { EnvironmentService } from '../environment/environment.service';
import { resolveClientDistPath } from '../../common/helpers/client-version';

/**
 * Resolve the response headers for a statically served client asset.
 *
 * Extracted from the @fastify/static `setHeaders` callback so the cache
 * classification stays a pure, unit-testable function (see
 * static.module.spec.ts).
 *
 * `Vary: Accept-Encoding` is emitted for every static response because
 * @fastify/static negotiates a precompressed .br/.gz neighbour by the client's
 * Accept-Encoding but does NOT set Vary itself. Without it a shared/proxy cache
 * keyed on the URL alone could store the brotli variant and later serve it to a
 * client that only sent `Accept-Encoding: identity`/gzip → an undecodable body.
 * This matters most for the immutable /assets/ files, which proxies may keep
 * for a year.
 */
export function resolveStaticAssetHeaders(
  filePath: string,
): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Accept-Encoding' };

  // Content-hashed files under /assets/ never change for a given URL, so they
  // can be cached forever and skip revalidation entirely.
  if (filePath.includes('/assets/')) {
    headers['cache-control'] = 'public, max-age=31536000, immutable';
    return headers;
  }

  // index.html is rewritten at boot (window.CONFIG injection) and on every
  // deploy — it must be revalidated on every load.
  if (filePath.endsWith('index.html')) {
    headers['cache-control'] = 'no-cache, no-store, must-revalidate';
    return headers;
  }

  // Everything else (locales, vad, icons, manifest) is NOT content-hashed and
  // changes between deploys, so it keeps @fastify/static's default
  // etag/last-modified revalidation — do NOT mark it immutable.
  return headers;
}

/**
 * RFC 8615 reserves `/.well-known/` for MACHINE-readable site metadata
 * (OAuth discovery, security.txt, WebFinger, MTA-STS...). A discovery client
 * fetches such a URL and parses the body as JSON/text — it must get an honest
 * 404 when no such resource exists, never a 200 `text/html` SPA shell.
 *
 * The bug (#636): the SPA catch-all answered `GET /.well-known/oauth-protected-resource`
 * with index.html + 200, so an MCP client that (per the 2025-06-18 spec) starts
 * OAuth discovery after a 401 from /mcp died on "Failed to parse JSON" instead
 * of learning that this server has no OAuth AS at all.
 *
 * Feed this the DECODED path — `req.params['*']` from the catch-all route, not
 * `req.url`. Matching on the raw url is bypassable: `/%2ewell-known/x` and
 * `/.well-%6bnown/x` reach the same handler but do not literally start with
 * `/.well-known/`, so a raw-url check hands them the SPA shell.
 *
 * This predicate is SELF-SUFFICIENT about the rest: it does not rely on the router
 * having tidied the path up first, because Fastify only half does. Verified against
 * a real Fastify + @fastify/static stand, `req.params['*']` is percent-decoded, but
 * it does NOT collapse repeated leading slashes (`//.well-known/x` arrives verbatim)
 * and does NOT collapse dot-segments that were smuggled in percent-encoded:
 * `GET /a/..%2f.well-known/x` arrives as `/a/../.well-known/x`, which does not start
 * with `/.well-known/` and used to be served the SPA shell. So the normalisation the
 * check needs is done HERE, on whatever string it is handed:
 *   - a query string is stripped (`req.params['*']` never carries one, but a
 *     direct/unit caller may pass a raw url — a URL *fragment* needs no such strip:
 *     it is client-side only and never reaches the server);
 *   - `.` and `..` segments are resolved, so `/a/../.well-known/x` is seen for the
 *     `/.well-known/x` it is, and `/.well-known/../home` for the plain `/home` it is;
 *   - empty segments collapse and a leading slash is (re)imposed, so `//.well-known/x`
 *     and a relative `.well-known/x` both normalise to the one shape.
 * Whatever it is fed, the string it decides on is a canonical absolute path.
 */
export function shouldServeSpaShell(pathname: string): boolean {
  const path = pathname.split('?')[0];

  // Resolve the path to its canonical form: drop empty (`//`) and `.` segments, and
  // let `..` pop the segment before it (popping an empty stack is a no-op — `/..`
  // cannot escape above the root, exactly as a browser/proxy resolves it).
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalized = '/' + segments.join('/');

  return (
    normalized !== '/.well-known' && !normalized.startsWith('/.well-known/')
  );
}

@Module({})
export class StaticModule implements OnModuleInit {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly environmentService: EnvironmentService,
  ) {}

  public async onModuleInit() {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const app = httpAdapter.getInstance();

    const clientDistPath = resolveClientDistPath();

    const indexFilePath = join(clientDistPath, 'index.html');

    if (fs.existsSync(clientDistPath) && fs.existsSync(indexFilePath)) {
      const indexTemplateFilePath = join(clientDistPath, 'index-template.html');
      const windowVar = '<!--window-config-->';

      const configString = {
        ENV: this.environmentService.getNodeEnv(),
        APP_URL: this.environmentService.getAppUrl(),
        CLOUD: this.environmentService.isCloud(),
        COMPACT_PAGE_TREE: this.environmentService.isCompactPageTreeEnabled(),
        FILE_UPLOAD_SIZE_LIMIT:
          this.environmentService.getFileUploadSizeLimit(),
        FILE_IMPORT_SIZE_LIMIT:
          this.environmentService.getFileImportSizeLimit(),
        DRAWIO_URL: this.environmentService.getDrawioUrl(),
        SUBDOMAIN_HOST: this.environmentService.isCloud()
          ? this.environmentService.getSubdomainHost()
          : undefined,
        COLLAB_URL: this.environmentService.getCollabUrl(),
        BILLING_TRIAL_DAYS: this.environmentService.isCloud()
          ? this.environmentService.getBillingTrialDays()
          : undefined,
        POSTHOG_HOST: this.environmentService.getPostHogHost(),
        POSTHOG_KEY: this.environmentService.getPostHogKey(),
        // #355 — mirrors the server-side CLIENT_TELEMETRY_ENABLED gate so the
        // client only collects/sends vitals when the operator opts in.
        CLIENT_TELEMETRY_ENABLED:
          this.environmentService.isClientTelemetryEnabled(),
        // #563 — mirrors LOCAL_FIRST_ENABLED so the client's page-meta boot
        // cache (instant chrome) is only active when the operator opts in.
        LOCAL_FIRST_ENABLED: this.environmentService.isLocalFirstEnabled(),
        // #640 — mirrors the network-independent session boundary. After this
        // long without a successful `/me`, the client refuses to draw ANY local
        // content and purges it (defaults to JWT_TOKEN_EXPIRES_IN).
        OFFLINE_GRACE: this.environmentService.getOfflineGrace(),
        // #629 — mirrors DRAWIO_RASTER_ENABLED so the draw.io editor only embeds
        // a PNG raster into the saved .drawio.svg when the operator opts in
        // (off => today's svg-only save; the file-size cost is reversible).
        DRAWIO_RASTER_ENABLED: this.environmentService.isDrawioRasterEnabled(),
        // #632 — mirrors EXCALIDRAW_RASTER_ENABLED so the Excalidraw editor only
        // embeds a PNG raster into the saved .excalidraw.svg when the operator
        // opts in (off => today's svg-only save; the file-size cost is reversible).
        EXCALIDRAW_RASTER_ENABLED:
          this.environmentService.isExcalidrawRasterEnabled(),
      };

      const windowScriptContent = `<script>window.CONFIG=${JSON.stringify(configString)};</script>`;

      if (!fs.existsSync(indexTemplateFilePath)) {
        fs.copyFileSync(indexFilePath, indexTemplateFilePath);
      }

      const html = fs.readFileSync(indexTemplateFilePath, 'utf8');
      const transformedHtml = html.replace(windowVar, windowScriptContent);

      fs.writeFileSync(indexFilePath, transformedHtml);

      const RENDER_PATH = '*';

      await app.register(fastifyStatic, {
        root: clientDistPath,
        wildcard: false,
        // Serve the build-time .br/.gz neighbour when the client accepts it
        // (see vite-plugin-compression2 in apps/client/vite.config.ts).
        preCompressed: true,
        // @fastify/static's default cacheControl:true writes its own
        // Cache-Control (from maxAge, default 0) AFTER the setHeaders callback,
        // silently overwriting the immutable header that resolveStaticAssetHeaders
        // sets — disable it so setHeaders/resolveStaticAssetHeaders own the header.
        cacheControl: false,
        setHeaders: (res, filePath) => {
          for (const [name, value] of Object.entries(
            resolveStaticAssetHeaders(filePath),
          )) {
            res.setHeader(name, value);
          }
        },
      });

      app.get(RENDER_PATH, (req: any, res: any) => {
        // #636 — never answer the machine-readable /.well-known/ namespace with
        // the SPA shell. Nothing is lost by 404-ing it: the client dist ships no
        // /.well-known/ files, and @fastify/static (wildcard:false, no
        // serveDotFiles) would not serve a dot-prefixed directory anyway; ACME
        // challenges terminate at the reverse proxy and never reach Node. If a
        // real /.well-known resource is ever added it needs its own route (plus
        // the dotfile options here) — and this predicate must then be relaxed.
        //
        // Match on the DECODED wildcard (`req.params['*']`), not on the raw
        // `req.url`: `/%2ewell-known/x` hits this handler with a url that does not
        // literally start with `/.well-known/` and would otherwise slip through.
        // shouldServeSpaShell canonicalises whatever it is given (dot-segments,
        // repeated slashes, query string), so the raw-url fallback below — used only
        // if the param is somehow absent — is safe too, and is never a value that
        // trivially passes the check.
        const wildcard = (req.params as Record<string, string> | undefined)?.[
          '*'
        ];
        if (!shouldServeSpaShell(wildcard ?? req.url ?? '')) {
          res
            .status(404)
            .header('Cache-Control', 'no-cache, no-store, must-revalidate')
            .type('application/json')
            .send({ error: 'Not found' });
          return;
        }

        const stream = fs.createReadStream(indexFilePath);
        res
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .type('text/html')
          .send(stream);
      });
    }
  }
}
