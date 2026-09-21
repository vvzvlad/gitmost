import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { validate as isValidUUID } from 'uuid';
import { SandboxStore } from './sandbox.store';
import { SANDBOX_ROUTE_SEGMENT } from './sandbox.constants';

// MIME types safe to render inline in a browser. SVG is deliberately EXCLUDED
// (it can carry script), as are text/html and the JSON document blob — anything
// not on this list is served as an attachment so an attacker-controlled mime can
// never execute script on this origin (the route is anonymous + same-origin).
const INLINE_SAFE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/**
 * Anonymous read endpoint for the in-RAM blob sandbox.
 *
 * Mounted under the global `/api` prefix as `GET /api/sb/:id`. It carries NO
 * `@UseGuards(JwtAuthGuard)`, so — exactly like the public attachment route
 * `GET /api/files/public/...` — it is exempt from Docmost session auth. The
 * route is ALSO listed in the workspace-resolution preHandler's excludedPaths
 * in main.ts so a request from a remote consumer (which carries no workspace
 * host) is not rejected with "Workspace not found".
 *
 * It only ever serves blobs looked up from the SandboxStore by a validated
 * UUID; `:id` is never used as a filesystem path, so there is no traversal
 * surface. Never returns tokens, never 401s.
 *
 * Anti-XSS hardening mirrors the public attachment route: every response sets
 * `X-Content-Type-Options: nosniff` and a restrictive CSP, and serves any mime
 * NOT on the inline-safe allowlist (svg/html/the JSON document blob) as an
 * attachment, so an attacker-controlled `entry.mime` can never execute script
 * on this same-origin anonymous route.
 */
@Controller(SANDBOX_ROUTE_SEGMENT)
export class SandboxController {
  constructor(private readonly store: SandboxStore) {}

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    // Validate `:id` as a real UUID via the shared `uuid` validator (same as the
    // attachment routes). This is anti-traversal / input hygiene (so `:id` can
    // never be a path like `../...`), NOT authorization — the capability is the
    // unguessable id itself plus the short TTL plus TLS. A non-UUID id (including
    // any traversal attempt) → 404 before touching the store; no stack trace
    // leaks out.
    if (!isValidUUID(id)) {
      res.status(404).send();
      return;
    }

    const entry = this.store.get(id);
    if (!entry) {
      // Missing or expired — indistinguishable to the caller, by design.
      res.status(404).send();
      return;
    }

    // Strong validator: quoted sha256, no W/ weak prefix. Same value computed
    // at put() time, so an external consumer can detect a truncated/corrupted
    // body — the original bug this whole channel exists to fix.
    const etag = `"${entry.sha256}"`;

    // Compute freshness BEFORE the conditional check: a 304 conditional
    // revalidation must not lose the Cache-Control freshness directives, or a
    // revalidating client would forget how long the blob stays fresh.
    const ttlSeconds = Math.max(
      0,
      Math.floor((entry.expiresAt - Date.now()) / 1000),
    );
    // Capability URL — keep it out of shared caches; immutable for its TTL.
    const cacheControl = `private, max-age=${ttlSeconds}, immutable`;

    // Conditional request: an exact ETag match → 304 with no body. The blob is
    // immutable, so the validator is stable for the blob's whole lifetime.
    if (this.ifNoneMatchMatches(req.headers['if-none-match'], entry.sha256)) {
      res
        .status(304)
        .header('ETag', etag)
        .header('Cache-Control', cacheControl)
        .send();
      return;
    }

    // Non-allowlisted mimes (svg/html/the JSON blob) are forced to download so
    // an attacker-controlled mime can never run script inline on this origin.
    const disposition = INLINE_SAFE_MIME.has(entry.mime)
      ? 'inline'
      : 'attachment';

    // Use @Res() + res.send(Buffer) with an explicit Content-Type so the binary
    // body bypasses the global JSON response transform/serializer.
    res
      .status(200)
      .headers({
        'Content-Type': entry.mime,
        'Content-Length': entry.buf.length,
        ETag: etag,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "base-uri 'none'; object-src 'self'; default-src 'self';",
        'Content-Disposition': disposition,
      })
      .send(entry.buf);
  }

  // Accept the consumer's If-None-Match whether it sends the quoted ETag, a bare
  // sha256, a weak "W/"-prefixed validator, or a comma-separated list.
  private ifNoneMatchMatches(
    header: string | string[] | undefined,
    sha256: string,
  ): boolean {
    if (!header) return false;
    const raw = Array.isArray(header) ? header.join(',') : header;
    if (raw.trim() === '*') return true;
    return raw
      .split(',')
      .map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
      .some((t) => t === sha256);
  }
}
