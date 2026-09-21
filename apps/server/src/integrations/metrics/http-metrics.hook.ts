import { FastifyReply, FastifyRequest } from 'fastify';
import { isStreamingResponse } from './metrics.constants';
import { observeHttp } from './metrics.registry';

// URL path prefixes served by @fastify/static (client build output under
// client/dist). `/assets/` holds the content-hashed bundle (index-*.js,
// chunk-*.js) — a NEW set of names every deploy, i.e. an UNBOUNDED label set
// (#362); the others (/vad/, /brand/, /locales/, /icons/ — copied verbatim from
// public/) have stable names, so they are merely repetitive per-file labels
// rather than unbounded. Either way none of these belong in the API-route
// histogram: collapse them all to one bounded `static` label. (Edge latency for
// static is already measured by Traefik's traefik_router_request_duration_*.)
const STATIC_PATH_PREFIXES = [
  '/assets/',
  '/vad/',
  '/brand/',
  '/locales/',
  '/icons/',
];

/**
 * Resolve the BOUNDED route label for an HTTP response.
 *
 * HARD REQUIREMENT (#355): use the ROUTE TEMPLATE (`/pages/:id`), NEVER a raw
 * URL (`/pages/abc-123` or `/assets/index-CAbxDtto.js`), so label cardinality
 * stays finite. Fastify exposes the matched template on `req.routeOptions.url`,
 * BUT @fastify/static serves each file through a route whose matched url is the
 * raw (hashed) file path — so for static assets that value is itself unbounded.
 * Detect static requests by their path prefix FIRST and collapse to `static`;
 * otherwise use the route template; on a 404 (no route matched) → `unknown`.
 */
export function resolveRouteLabel(req: FastifyRequest): string {
  const path = (req.url ?? '').split('?', 1)[0];
  if (STATIC_PATH_PREFIXES.some((p) => path.startsWith(p))) return 'static';
  const url = req.routeOptions?.url;
  return typeof url === 'string' && url.length > 0 ? url : 'unknown';
}

/**
 * Fastify onResponse handler that records http_request_duration_seconds.
 * No-op when metrics are disabled (the hook is only registered when enabled,
 * but the observe helpers are also guarded). Never throws into the response
 * pipeline — telemetry must not break request handling.
 */
export function recordHttpResponse(
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  try {
    const route = resolveRouteLabel(req);

    // Exclude SSE/streaming responses: onResponse fires at connection close for
    // those, so it would record the stream lifetime and poison p95/p99.
    const contentType = reply.getHeader('content-type');
    if (isStreamingResponse(contentType, route)) return;

    observeHttp(
      req.method,
      route,
      reply.statusCode,
      // Fastify measures elapsed time in ms; the metric is in seconds.
      reply.elapsedTime / 1000,
    );
  } catch {
    // Swallow: a telemetry failure must never affect the served response.
  }
}
