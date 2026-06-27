import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import {
  CatalogBundleFile,
  CatalogBundleMeta,
  CatalogIndex,
  CatalogRole,
} from './catalog-types';

/** Identifier shape allowed in any path/URL segment (bundleId, language). The
 *  ONLY characters that can appear in a fetched path — the path-traversal and
 *  SSRF guard. Anything else is rejected before a path/URL is built. */
const SEGMENT_RE = /^[a-z0-9-]+$/;

/** Remote fetch timeout and response-size cap. A curated catalog file is tiny;
 *  the cap stops a hostile/misconfigured source from streaming unbounded data. */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;

/**
 * Fetches + validates the agent-roles catalog from its configured source. The
 * source (EnvironmentService.getAiAgentRolesCatalogSource()) is an http(s)://
 * base URL — REMOTE only; local-filesystem sources are no longer supported. The
 * value is baked into the Docker image at build time (set per-branch in CI).
 *
 * The catalog is UNTRUSTED input: every file is JSON-parsed and run through a
 * hand-written type guard before any field is exposed, and every dynamic path
 * segment is validated against SEGMENT_RE up front (path-traversal + SSRF).
 */
@Injectable()
export class AiAgentRolesCatalogProvider {
  private readonly logger = new Logger(AiAgentRolesCatalogProvider.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  /** Read + validate the top-level index (`index.json`). */
  async fetchIndex(): Promise<CatalogIndex> {
    const raw = await this.readRelative('index.json');
    const parsed = this.parseJson(raw, 'index.json');
    if (!isCatalogIndex(parsed)) {
      throw new BadGatewayException(
        'Agent roles catalog index is malformed (index.json)',
      );
    }
    return parsed;
  }

  /** Read + validate one language file (`bundles/<bundleId>/<language>.json`). */
  async fetchBundle(
    bundleId: string,
    language: string,
  ): Promise<CatalogBundleFile> {
    // SECURITY: validate BEFORE building any path/URL (path-traversal + SSRF).
    this.assertSegment(bundleId, 'bundleId');
    this.assertSegment(language, 'language');
    const rel = `bundles/${bundleId}/${language}.json`;
    const raw = await this.readRelative(rel);
    const parsed = this.parseJson(raw, rel);
    if (!isCatalogBundleFile(parsed)) {
      throw new BadGatewayException(
        `Agent roles catalog bundle is malformed (${rel})`,
      );
    }
    return parsed;
  }

  /** Reject a segment that is not a safe `[a-z0-9-]+` identifier. */
  private assertSegment(value: string, field: string): void {
    if (typeof value !== 'string' || !SEGMENT_RE.test(value)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
  }

  /** JSON.parse with a clear BadGateway on malformed content. */
  private parseJson(raw: string, rel: string): unknown {
    try {
      return JSON.parse(raw);
    } catch (err) {
      const reason = shortError(err);
      this.logger.error(`Agent roles catalog JSON parse failed (${rel}): ${reason}`);
      throw new BadGatewayException(
        `Agent roles catalog file is not valid JSON (${rel}): ${reason}`,
      );
    }
  }

  /** Read a relative catalog path as text from the configured remote source. */
  private async readRelative(rel: string): Promise<string> {
    const source = this.environmentService
      .getAiAgentRolesCatalogSource()
      .trim();
    if (!/^https?:\/\//i.test(source)) {
      this.logger.error(
        'Agent roles catalog source is not configured (expected an http(s):// base URL)',
      );
      throw new BadGatewayException(
        'Agent roles catalog is unavailable: source is not configured',
      );
    }
    return this.fetchRemote(source, rel);
  }

  /**
   * Fetch a remote catalog file with a timeout + a STREAMING size cap. The body
   * is never buffered in full before the check: we reject on a too-large
   * Content-Length up front, then read the stream chunk-by-chunk and abort the
   * moment the running total exceeds MAX_BYTES, so a hostile/misconfigured
   * source cannot make us hold an unbounded body in memory.
   */
  private async fetchRemote(base: string, rel: string): Promise<string> {
    const url = `${base.replace(/\/+$/, '')}/${rel}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        // `redirect: 'error'` hardens against redirect-SSRF: a
        // compromised-but-trusted upstream cannot 3xx the fetch into the
        // internal network (e.g. http://169.254.169.254/...). A redirect
        // response rejects here and is mapped to BadGateway below.
        response = await fetch(url, {
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (err) {
        const reason = shortError(err);
        this.logger.error(
          `Agent roles catalog remote fetch failed (${rel}): ${reason}`,
        );
        throw new BadGatewayException(
          `Agent roles catalog is unavailable: ${reason}`,
        );
      }
      if (!response.ok) {
        this.logger.error(
          `Agent roles catalog remote returned ${response.status} (${rel})`,
        );
        throw new BadGatewayException(
          `Agent roles catalog returned ${response.status}`,
        );
      }
      // Reject a too-large declared size before reading any body bytes.
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        throw new BadGatewayException('Agent roles catalog file is too large');
      }
      // Bound the actual read: a missing/lying Content-Length is caught here.
      // The 10s timer aborts the WHOLE request, so a slow/dripping hostile
      // source rejects reader.read() (or response.text()) with an AbortError
      // mid-body. Map that — and any other read failure — to a logged
      // BadGateway so the admin endpoint returns 502 (not a generic 500). The
      // cap's own BadGateway is rethrown as-is (no double-wrap).
      try {
        if (response.body) {
          return await readStreamCapped(response.body, MAX_BYTES);
        }
        // Edge: no readable stream — fall back to a buffered read + length check.
        const text = await response.text();
        if (text.length > MAX_BYTES) {
          throw new BadGatewayException('Agent roles catalog file is too large');
        }
        return text;
      } catch (err) {
        if (err instanceof BadGatewayException) throw err;
        const reason = shortError(err);
        this.logger.error(
          `Agent roles catalog body read failed (${rel}): ${reason}`,
        );
        throw new BadGatewayException(
          `Agent roles catalog is unavailable: ${reason}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read a web ReadableStream into a UTF-8 string, throwing as soon as the
 * accumulated byte count exceeds `maxBytes` (the reader is cancelled so the
 * underlying connection is released). Never buffers more than the cap + the
 * final chunk before bailing out.
 */
async function readStreamCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        throw new BadGatewayException('Agent roles catalog file is too large');
      }
      chunks.push(value);
    }
  } finally {
    // Release the stream on both the normal and the too-large/abort paths.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A short, non-sensitive error string for logging/propagation: only the first
 * line of the message head is kept (upstream bodies / URLs are discarded).
 */
function shortError(err: unknown): string {
  let message = '';
  if (typeof err === 'string') {
    message = err;
  } else if (
    err &&
    typeof err === 'object' &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    // Read `.message` directly (works for Error instances and the realm-shifted
    // Error-likes jest can hand back, where `instanceof Error` is false).
    message = (err as { message: string }).message;
  }
  const head = (message || 'unknown error').split('\n')[0];
  return head.length > 200 ? `${head.slice(0, 200)}…` : head;
}

// ---------------------------------------------------------------------------
// Hand-written type guards (no zod / new deps). Each validates the exact wire
// shape declared in catalog-types.ts; anything else is rejected by the caller.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!isObject(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function isCatalogRole(v: unknown): v is CatalogRole {
  if (!isObject(v)) return false;
  if (typeof v.slug !== 'string') return false;
  if (typeof v.name !== 'string') return false;
  if (typeof v.instructions !== 'string') return false;
  if (v.emoji !== undefined && typeof v.emoji !== 'string') return false;
  if (v.description !== undefined && typeof v.description !== 'string') {
    return false;
  }
  if (v.autoStart !== undefined && typeof v.autoStart !== 'boolean') {
    return false;
  }
  if (
    v.launchMessage !== undefined &&
    v.launchMessage !== null &&
    typeof v.launchMessage !== 'string'
  ) {
    return false;
  }
  if (
    v.modelConfig !== undefined &&
    v.modelConfig !== null &&
    !isObject(v.modelConfig)
  ) {
    return false;
  }
  return true;
}

export function isCatalogBundleFile(v: unknown): v is CatalogBundleFile {
  if (!isObject(v)) return false;
  if (typeof v.schemaVersion !== 'number') return false;
  if (typeof v.language !== 'string') return false;
  if (!Array.isArray(v.roles)) return false;
  return v.roles.every(isCatalogRole);
}

function isCatalogBundleMeta(v: unknown): v is CatalogBundleMeta {
  if (!isObject(v)) return false;
  if (typeof v.id !== 'string') return false;
  if (!isStringMap(v.name)) return false;
  if (v.description !== undefined && !isStringMap(v.description)) return false;
  if (!isStringArray(v.languages)) return false;
  if (!Array.isArray(v.roles)) return false;
  return v.roles.every(
    (r) =>
      isObject(r) &&
      typeof r.slug === 'string' &&
      typeof r.version === 'number',
  );
}

export function isCatalogIndex(v: unknown): v is CatalogIndex {
  if (!isObject(v)) return false;
  if (typeof v.schemaVersion !== 'number') return false;
  if (!Array.isArray(v.bundles)) return false;
  return v.bundles.every(isCatalogBundleMeta);
}
