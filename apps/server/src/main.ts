import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { TransformHttpResponseInterceptor } from './common/interceptors/http-response.interceptor';
import { WsRedisIoAdapter } from './ws/adapter/ws-redis.adapter';
import fastifyMultipart from '@fastify/multipart';
import fastifyCookie from '@fastify/cookie';
import fastifyCompress from '@fastify/compress';
import fastifyIp from 'fastify-ip';
import { InternalLogFilter } from './common/logger/internal-log-filter';
import { EnvironmentService } from './integrations/environment/environment.service';
import { SANDBOX_API_PATH } from './integrations/sandbox/sandbox.constants';
import { resolveFrameHeader } from './common/helpers';
import { resolveTrustProxy } from './integrations/environment/trust-proxy.util';
import { isMetricsEnabled } from './integrations/metrics/metrics.registry';
import { recordHttpResponse } from './integrations/metrics/http-metrics.hook';
import { startMetricsServer } from './integrations/metrics/metrics.server';
import { GitHttpService } from './integrations/git-sync/http/git-http.service';

async function bootstrap() {
  // Fastify JSON body cap. Fastify defaults to 1 MiB, which a long AI-chat
  // research turn exceeds: the client resends the FULL message history (every
  // tool call + search result) on each turn, so a deep conversation's POST to
  // /api/ai-chat/stream can be several MB and would otherwise be rejected with
  // FST_ERR_CTP_BODY_TOO_LARGE (413). Raise the cap; override with
  // HTTP_JSON_BODY_LIMIT (bytes). A missing/invalid/non-positive value keeps the
  // 25 MiB default. Multipart uploads are unaffected (their own @fastify/multipart
  // limits apply); this only bounds JSON/urlencoded request bodies.
  const bodyLimitEnv = Number(process.env.HTTP_JSON_BODY_LIMIT);
  const bodyLimit =
    Number.isFinite(bodyLimitEnv) && bodyLimitEnv > 0
      ? bodyLimitEnv
      : 25 * 1024 * 1024;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: resolveTrustProxy(process.env.TRUST_PROXY),
      bodyLimit,
      routerOptions: {
        maxParamLength: 1000,
        ignoreTrailingSlash: true,
        ignoreDuplicateSlashes: true,
      },
    }),
    {
      rawBody: true,
      // captures NestJS internal errors
      logger: new InternalLogFilter(),
      // bufferLogs must be false else pino will fail
      // to log OnApplicationBootstrap logs
      bufferLogs: false,
    },
  );

  app.useLogger(app.get(PinoLogger));

  app.setGlobalPrefix('api', {
    exclude: [
      'robots.txt',
      'share/:shareId/p/:pageSlug',
      // Vanity link resolver lives outside /api so /l/<alias> is a clean
      // public URL that 302s to the canonical share page.
      'l/:alias',
      'mcp',
    ],
  });

  const reflector = app.get(Reflector);
  const redisIoAdapter = new WsRedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();

  app.useWebSocketAdapter(redisIoAdapter);

  await app.register(fastifyIp);
  await app.register(fastifyMultipart);
  await app.register(fastifyCookie);
  // Compress dynamic responses (API JSON, the rewritten share-SEO HTML) when the
  // client accepts br/gzip. @fastify/compress only compresses content-types that
  // mime-db flags `compressible` (application/json, text/html, …); `text/event-stream`
  // is not in mime-db, so SSE is never compressed by the allowlist. The AI-chat
  // stream additionally hijacks the raw socket (pipeUIMessageStreamToResponse ->
  // res.raw in ai-chat.service.ts), bypassing Fastify's reply/onSend lifecycle
  // entirely, so this hook can never buffer that stream.
  await app.register(fastifyCompress, {
    // Skip tiny payloads where compression overhead outweighs the savings.
    threshold: 1024,
  });

  const environmentService = app.get(EnvironmentService);
  const frameHeader = resolveFrameHeader(
    environmentService.isIframeEmbedAllowed(),
    environmentService.getIframeAllowedOrigins(),
  );
  if (frameHeader) {
    // Skipped routes:
    //   /api/files/ - attachment controller sets its own CSP we'd overwrite
    //   /share/     0 public share pages are safe to embed
    const frameHeaderSkippedPrefixes = ['/api/files/', '/share/'];
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onSend', (req, reply, payload, done) => {
        if (frameHeaderSkippedPrefixes.some((p) => req.url.startsWith(p))) {
          return done(null, payload);
        }
        reply.header(frameHeader.name, frameHeader.value);
        done(null, payload);
      });
  }

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, _reply, done) => {
      (request.raw as any).ip = request.ip;
      done();
    });

  // #355 — HTTP request-duration histogram. Registered ONLY when METRICS_PORT is
  // set (otherwise no collector runs at all). Uses the bounded route template
  // label and excludes SSE/streaming responses (see recordHttpResponse).
  if (isMetricsEnabled()) {
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onResponse', (req, reply, done) => {
        recordHttpResponse(req, reply);
        done();
      });
  }

  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      'application/scim+json',
      { parseAs: 'string' },
      (_, body, done) => {
        try {
          const json = JSON.parse(body.toString());
          done(null, json);
        } catch (err: any) {
          done(err);
        }
      },
    );

  // git smart-HTTP POST bodies use these media types. Register PASSTHROUGH
  // content-type parsers so Fastify does NOT buffer/parse them (it would
  // otherwise reject the unknown type with 415); the /git handler streams the
  // raw Node request (request.raw) to `git http-backend` stdin instead. A
  // passthrough parser also bypasses the bodyLimit, so large pushes are not
  // truncated (the bytes are never buffered by Fastify).
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      [
        'application/x-git-upload-pack-request',
        'application/x-git-receive-pack-request',
      ],
      (_req, payload, done) => done(null, payload),
    );

  app
    .getHttpAdapter()
    .getInstance()
    .decorateReply('setHeader', function (name: string, value: unknown) {
      this.header(name, value);
    })
    .decorateReply('end', function () {
      this.send('');
    })
    .addHook('preHandler', function (req, reply, done) {
      // don't require workspaceId for the following paths
      const excludedPaths = [
        '/api/auth/setup',
        '/api/health',
        '/api/billing/stripe/webhook',
        '/api/workspace/check-hostname',
        '/api/sso/google',
        '/api/workspace/create',
        '/api/workspace/joined',
        '/api/workspace/find-by-email',
        // Public client perf-telemetry sink: browsers post it without a
        // resolved workspace host, so the workspace-resolution gate must not 404 it.
        '/api/telemetry/vitals',
        // Anonymous in-RAM blob sandbox: a remote consumer fetches blobs by an
        // unguessable UUID without any workspace host context, so the
        // workspace-resolution gate must not apply.
        SANDBOX_API_PATH,
      ];

      if (
        req.originalUrl.startsWith('/api') &&
        !excludedPaths.some((path) => req.originalUrl.startsWith(path))
      ) {
        if (!req.raw?.['workspaceId'] && req.originalUrl !== '/api') {
          throw new NotFoundException('Workspace not found');
        }
        done();
      } else {
        done();
      }
    });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      stopAtFirstError: true,
      transform: true,
    }),
  );

  // #636 — `WWW-Authenticate` is NOT on the CORS-safelisted response headers, so
  // without exposing it a browser-based MCP client (e.g. MCP Inspector) cannot read
  // the 401's challenge at all: fetch() hides the header and the client is back to
  // guessing OAuth — the exact failure the challenge exists to prevent.
  app.enableCors({ exposedHeaders: ['WWW-Authenticate'] });
  app.useGlobalInterceptors(new TransformHttpResponseInterceptor(reflector));
  app.enableShutdownHooks();

  // git smart-HTTP host (the /git/<spaceId>.git/... subtree). Registered as a
  // RAW Fastify route — NOT a Nest controller under the global '/api' prefix —
  // so it lives at the ROOT and a single wildcard reliably captures the whole
  // multi-segment subtree (avoiding the path-to-regexp v8 wildcard / global-
  // prefix-exclude ambiguity in NestJS v11). The handler is resolved from the
  // Nest container so all auth/authz/gating still runs. NOTE: Nest middleware
  // (DomainMiddleware) does NOT run for this raw root route — it is bound to the
  // Nest router under the global '/api' prefix — so request.raw.workspaceId is
  // NOT populated here; GitHttpService resolves the workspace itself (mirroring
  // DomainMiddleware). The Fastify wildcard '/git/*' captures the multi-segment
  // subpath; the handler re-parses req.url itself.
  const gitHttpService = app.get(GitHttpService);
  app
    .getHttpAdapter()
    .getInstance()
    .all('/git/*', async (request, reply) => {
      await gitHttpService.handle(request as any, reply as any);
    });

  const logger = new Logger('NestApplication');

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`UnhandledRejection, reason: ${reason}`, promise);
  });

  process.on('uncaughtException', (error) => {
    logger.error('UncaughtException:', error);
  });

  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host, () => {
    logger.log(
      `Listening on http://127.0.0.1:${port} / ${process.env.APP_URL}`,
    );
  });

  // #355 — Prometheus scrape endpoint on a SEPARATE port (METRICS_PORT),
  // started after the app is up. No default port: a no-op when METRICS_PORT is
  // unset. Closed on shutdown by MetricsServerLifecycle (MetricsModule).
  startMetricsServer();
}

bootstrap();
