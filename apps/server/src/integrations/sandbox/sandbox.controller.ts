import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SandboxStore } from './sandbox.store';
import { SANDBOX_ROUTE_SEGMENT } from './sandbox.constants';

// Strict UUID v-agnostic shape. This is anti-traversal / input hygiene (so `:id`
// can never be a path like `../...`), NOT authorization — the capability is the
// unguessable id itself plus the short TTL plus TLS.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    // Non-UUID id (including any traversal attempt) → 404 before touching the
    // store. No stack trace leaks out.
    if (!UUID_RE.test(id)) {
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

    // Conditional request: an exact ETag match → 304 with no body. The blob is
    // immutable, so the validator is stable for the blob's whole lifetime.
    if (this.ifNoneMatchMatches(req.headers['if-none-match'], entry.sha256)) {
      res.status(304).header('ETag', etag).send();
      return;
    }

    const ttlSeconds = Math.max(
      0,
      Math.floor((entry.expiresAt - Date.now()) / 1000),
    );

    // Use @Res() + res.send(Buffer) with an explicit Content-Type so the binary
    // body bypasses the global JSON response transform/serializer.
    res
      .status(200)
      .headers({
        'Content-Type': entry.mime,
        'Content-Length': entry.buf.length,
        ETag: etag,
        // Capability URL — keep it out of shared caches; immutable for its TTL.
        'Cache-Control': `private, max-age=${ttlSeconds}, immutable`,
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
