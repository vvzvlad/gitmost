import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';

/**
 * Live progress of an in-flight workspace embeddings reindex run.
 * `total` is the number of pages the run will process, `done` how many it has
 * already processed (success OR handled failure), `startedAt` the epoch-ms the
 * record was created.
 */
export interface ReindexProgress {
  total: number;
  done: number;
  startedAt: number;
}

/** Redis key namespace for the per-workspace reindex-progress record. */
const KEY_PREFIX = 'ai:reindex:progress:';

/**
 * TTL (seconds) on the progress record so a crashed/aborted worker that never
 * reaches its `clear()` finally can still self-clean instead of leaving a stuck
 * "reindexing" state. Refreshed on every increment so a long run never expires
 * mid-flight; on a crash it disappears within TTL of the last processed page.
 *
 * INTENTIONALLY tied to WRITE progress (start/increment) only — never refreshed
 * on get(). Refreshing on read would keep a dead worker's record alive forever
 * as long as a client keeps polling (a permanently stuck reindexing:true). The
 * clear() in the worker's finally handles normal completion; a dead worker's
 * record expires after TTL, and the client's own poll cap stops polling anyway.
 */
const TTL_SECONDS = 60 * 60; // 1h

/**
 * Cluster-wide store for the live progress of a workspace embeddings reindex.
 *
 * The reindex runs in a BullMQ worker (AI_QUEUE) that may be a DIFFERENT process
 * than the API handling the settings-status GET, so the progress must live in
 * the shared Redis — we reuse the same global ioredis client (RedisService from
 * @nestjs-labs/nestjs-ioredis) that backs BullMQ and the other anti-abuse
 * limiters, adding NO new Redis config.
 *
 * Everything here is best-effort and COSMETIC: progress only drives the "Indexed
 * X of Y" counter while a reindex is running. Any Redis failure degrades to the
 * existing steady-state behaviour (the status falls back to the DB coverage
 * count), so reads fail to `null` and writes are swallowed — a reindex must
 * never break because progress reporting did.
 *
 * Stored as a Redis HASH so `done` can be bumped with an atomic HINCRBY (the
 * worker is the only writer of `done`, but HINCRBY also keeps us off a
 * read-modify-write race and preserves the other fields).
 */
@Injectable()
export class EmbeddingReindexProgressService {
  private readonly logger = new Logger(EmbeddingReindexProgressService.name);
  private readonly redis: Redis;

  constructor(redisService: RedisService) {
    this.redis = redisService.getOrThrow();
  }

  private key(workspaceId: string): string {
    return KEY_PREFIX + workspaceId;
  }

  /**
   * Begin (or reset) the progress record for a workspace: `total` pages, `done`
   * back to 0, `startedAt` now. Called twice for a run, BOTH with the real page
   * count (countEmbeddablePages) so the two totals coincide: once at reindex
   * enqueue time (so the very first status poll already reports done=0) and again
   * at the worker start (which re-asserts the same total and resets `done`).
   * Resets `done` to 0 so a re-trigger never inherits a stale count.
   *
   * `ttlSeconds` lets the caller pick the record's lifetime. The enqueue-time
   * pre-seed passes a SHORT ttl: if `aiQueue.add()` de-duplicates against a job
   * that is just finishing (its worker hasn't yet removed the job but already
   * ran its `clear()`), no new worker starts to clear this phantom seed, so a
   * short ttl lets it expire in seconds instead of sticking for the full TTL.
   * The worker's own `start()` at the begin of a real run overwrites this entry
   * and raises the ttl back to the default full TTL.
   */
  async start(
    workspaceId: string,
    total: number,
    ttlSeconds: number = TTL_SECONDS,
  ): Promise<void> {
    const key = this.key(workspaceId);
    try {
      await this.redis
        .multi()
        .hset(key, {
          total: String(total),
          done: '0',
          startedAt: String(Date.now()),
        })
        .expire(key, ttlSeconds)
        .exec();
    } catch (err) {
      this.logger.warn(
        `reindex-progress start failed for workspace ${workspaceId}; ` +
          `progress reporting disabled for this run: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Bump the processed-page counter by one and refresh the TTL. Atomic and
   * best-effort: a missing key (cleared/expired) would be recreated with only
   * `done`, but `get()` treats a record without a numeric `total` as inactive,
   * so that partial state safely reads as "no active reindex".
   */
  async increment(workspaceId: string): Promise<void> {
    const key = this.key(workspaceId);
    try {
      await this.redis.multi().hincrby(key, 'done', 1).expire(key, TTL_SECONDS).exec();
    } catch (err) {
      this.logger.warn(
        `reindex-progress increment failed for workspace ${workspaceId}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Remove the progress record. Called in the worker's `finally` so a completed,
   * aborted, or unconfigured-early-return run never leaves a stuck record; the
   * status then falls back to the DB coverage count.
   */
  async clear(workspaceId: string): Promise<void> {
    try {
      await this.redis.del(this.key(workspaceId));
    } catch (err) {
      this.logger.warn(
        `reindex-progress clear failed for workspace ${workspaceId} ` +
          `(self-cleans via TTL): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Read the live progress, or `null` when no reindex is active (no record, an
   * expired record, or a partial record without a numeric `total`). On a Redis
   * error returns `null` so the status endpoint degrades to its DB count.
   */
  async get(workspaceId: string): Promise<ReindexProgress | null> {
    try {
      const data = await this.redis.hgetall(this.key(workspaceId));
      if (!data || data.total === undefined) return null;
      const total = Number(data.total);
      const done = Number(data.done);
      const startedAt = Number(data.startedAt);
      if (!Number.isFinite(total) || !Number.isFinite(done)) return null;
      return { total, done, startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
    } catch (err) {
      this.logger.warn(
        `reindex-progress read failed for workspace ${workspaceId}; ` +
          `falling back to DB count: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
