import { createServer, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { getMetricsRegistry, isMetricsEnabled } from './metrics.registry';

/**
 * Constant-time compare of the presented Authorization header against the
 * expected `Bearer <token>`. This is the ONLY auth layer for the metrics
 * endpoint, so a naive `!==` would leak the token byte-by-byte via timing.
 * timingSafeEqual requires equal-length buffers, so a length mismatch short-
 * circuits to "not equal" (its own length is not itself a useful oracle: the
 * expected string length is fixed by config, not secret-derived).
 */
function bearerMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Start the Prometheus scrape endpoint on a SEPARATE port, taken from
 * `METRICS_PORT`. There is NO default port: when `METRICS_PORT` is unset the
 * whole metrics subsystem is OFF and this returns null. This is a bare node:http
 * server, NOT part of the Fastify app, so `/metrics` never exists on the public
 * :3000 listener.
 *
 * Returns the http.Server (so callers can close it on shutdown) or null when
 * metrics are disabled. The reference is also kept module-side so the Nest
 * lifecycle (see MetricsModule) can close it on application shutdown without
 * threading the handle back through the non-DI bootstrap.
 */
let metricsServer: Server | null = null;

/**
 * Interface the metrics endpoint binds to. Defaults to LOOPBACK (127.0.0.1) so
 * the unauthenticated `/metrics` surface is NOT exposed on all interfaces by
 * default — the old `0.0.0.0` bind put an auth-less endpoint on every interface.
 * Deployments where the scraper runs in a SEPARATE container (and reaches this as
 * `docmost:9464`) set `METRICS_BIND=0.0.0.0`, ideally together with METRICS_TOKEN
 * and/or a private network so the port is not world-readable.
 */
export function resolveMetricsBind(): string {
  const raw = (process.env.METRICS_BIND ?? '').trim();
  return raw.length > 0 ? raw : '127.0.0.1';
}

/**
 * Optional Bearer token guarding `/metrics`. When `METRICS_TOKEN` is set, every
 * scrape must present `Authorization: Bearer <token>`; unset (default) leaves the
 * endpoint open (safe when bound to loopback / a trusted network). Returns the
 * trimmed token or null when unset/blank.
 */
export function resolveMetricsToken(): string | null {
  const raw = (process.env.METRICS_TOKEN ?? '').trim();
  return raw.length > 0 ? raw : null;
}

export function startMetricsServer(): Server | null {
  if (!isMetricsEnabled()) return null;

  const logger = new Logger('MetricsServer');
  const register = getMetricsRegistry();
  if (!register) return null;

  const port = Number(process.env.METRICS_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    logger.warn(
      `Invalid METRICS_PORT="${process.env.METRICS_PORT}", metrics endpoint not started`,
    );
    return null;
  }

  const bind = resolveMetricsBind();
  const token = resolveMetricsToken();

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      // Optional Bearer auth: reject scrapes without the exact token when one is
      // configured. This is the auth layer the old all-interfaces bind lacked.
      if (token) {
        const auth = req.headers['authorization'];
        if (!bearerMatches(auth, `Bearer ${token}`)) {
          res.statusCode = 401;
          res.setHeader('WWW-Authenticate', 'Bearer');
          res.end();
          return;
        }
      }
      try {
        const body = await register.metrics();
        res.setHeader('Content-Type', register.contentType);
        res.statusCode = 200;
        res.end(body);
      } catch (err) {
        res.statusCode = 500;
        res.end(String((err as Error)?.message ?? 'error'));
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  // Bind to loopback by default so the auth-less endpoint is not exposed on all
  // interfaces. Set METRICS_BIND=0.0.0.0 (ideally with METRICS_TOKEN) when the
  // scraper runs in a separate container and reaches this as docmost:9464.
  server.listen(port, bind, () => {
    logger.log(
      `Metrics endpoint listening on ${bind}:${port}/metrics` +
        (token ? ' (Bearer auth required)' : ''),
    );
  });

  server.on('error', (err) => {
    logger.error(`Metrics server error: ${err?.message}`);
  });

  metricsServer = server;
  return server;
}

/**
 * Close the metrics scrape server if one is running. Idempotent and safe to call
 * when metrics are disabled (no server was ever started). Wired into Nest's
 * shutdown lifecycle so the listener is not left dangling on shutdown.
 */
export function closeMetricsServer(): Promise<void> {
  const server = metricsServer;
  metricsServer = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    // server.close() stops accepting NEW connections but its callback does not
    // fire until existing keep-alive sockets drain. The scraper (VictoriaMetrics/
    // vmagent) holds an idle HTTP keep-alive socket, so without this the callback
    // — and thus shutdown — would hang until the scraper disconnects or the
    // orchestrator escalates to SIGKILL on the kill-grace window. Force-close idle
    // keep-alive sockets so close() completes immediately, and unref so this
    // server never keeps the event loop alive on its own.
    server.closeIdleConnections();
    server.unref();
  });
}
