import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { EnvironmentService } from '../environment/environment.service';
import { SANDBOX_API_PATH } from './sandbox.constants';

// In-RAM, process-local blob store. No disk, no DB. Ephemeral by design: a
// restart empties it. A blob is addressed by an unguessable randomUUID() which
// IS the read capability — there are NO tokens. Each blob is immutable (its id
// never maps to changing content), so its sha256 is a perfect strong ETag.
export interface SandboxEntry {
  buf: Buffer;
  mime: string;
  sha256: string;
  expiresAt: number;
}

export interface SandboxPutResult {
  id: string;
  sha256: string;
  size: number;
}

@Injectable()
export class SandboxStore implements OnModuleDestroy {
  private readonly logger = new Logger(SandboxStore.name);
  // Map preserves insertion order, so the first key is the oldest entry — used
  // for FIFO eviction when the total-bytes RAM guard is exceeded.
  private readonly map = new Map<string, SandboxEntry>();
  private totalBytes = 0;

  // Background sweep clears expired entries so never-fetched blobs do not linger
  // until the next get(). unref()'d so it never holds the event loop open;
  // cleared on module destroy. Mirrors the sweepTimer pattern in
  // integrations/mcp/mcp.service.ts and packages/mcp/src/http.ts.
  private readonly sweepIntervalMs = 60_000;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly environmentService: EnvironmentService) {
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        this.logger.error('Sandbox sweep failed', err as Error);
      }
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  /**
   * Store a blob and return its read capability id + integrity metadata. The
   * per-blob cap is chosen by mime (images get the larger image cap), and the
   * total-store RAM guard evicts oldest entries to make room. Throws a clear
   * error when a single blob cannot fit even after eviction. Blob bodies are
   * never logged.
   */
  put(buf: Buffer, mime: string): SandboxPutResult {
    const perBlobCap = mime.startsWith('image/')
      ? this.environmentService.getSandboxMaxImageBytes()
      : this.environmentService.getSandboxMaxBytes();
    if (buf.length > perBlobCap) {
      throw new Error(
        `Sandbox blob of ${buf.length} bytes exceeds the ${perBlobCap}-byte per-blob cap`,
      );
    }

    const maxTotal = this.environmentService.getSandboxMaxTotalBytes();
    if (buf.length > maxTotal) {
      throw new Error(
        `Sandbox blob of ${buf.length} bytes exceeds the total store cap of ${maxTotal} bytes`,
      );
    }

    // Drop expired entries first, then evict oldest until the new blob fits.
    this.sweep();
    while (this.totalBytes + buf.length > maxTotal && this.map.size > 0) {
      const oldest = this.map.keys().next().value as string;
      this.evict(oldest);
    }

    const id = randomUUID();
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const expiresAt = Date.now() + this.environmentService.getSandboxTtlMs();
    this.map.set(id, { buf, mime, sha256, expiresAt });
    this.totalBytes += buf.length;
    return { id, sha256, size: buf.length };
  }

  /**
   * Store a blob and return its anonymous read URL plus integrity metadata.
   * Owns the single sandbox-URL composition (`${publicBase}${SANDBOX_API_PATH}/
   * <id>`) so callers never hand-build the route; the raw put() stays public for
   * tests/low-level callers. sha256 is also the blob's strong ETag.
   */
  putAndLink(
    buf: Buffer,
    mime: string,
  ): { uri: string; sha256: string; size: number } {
    const stored = this.put(buf, mime);
    const base = this.environmentService.getSandboxPublicUrl();
    return {
      uri: `${base}${SANDBOX_API_PATH}/${stored.id}`,
      sha256: stored.sha256,
      size: stored.size,
    };
  }

  /** True if the blob is still live (not evicted/expired). */
  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** Drop a blob by id (public wrapper over the private FIFO evict). */
  remove(id: string): void {
    this.evict(id);
  }

  /** Returns the entry, or undefined if missing OR expired (lazy expiry). */
  get(id: string): SandboxEntry | undefined {
    const entry = this.map.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.evict(id);
      return undefined;
    }
    return entry;
  }

  /** Current number of live entries (test/diagnostic helper). */
  get size(): number {
    return this.map.size;
  }

  /** Current total bytes held (test/diagnostic helper). */
  get bytes(): number {
    return this.totalBytes;
  }

  private evict(id: string): void {
    const entry = this.map.get(id);
    if (entry) {
      this.totalBytes -= entry.buf.length;
      this.map.delete(id);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.evict(id);
      }
    }
  }
}
