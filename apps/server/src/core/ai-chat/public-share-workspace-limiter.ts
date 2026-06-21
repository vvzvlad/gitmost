import { Logger } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';

/**
 * IP-INDEPENDENT, CLUSTER-WIDE per-workspace cap on anonymous public-share AI
 * calls.
 *
 * The route is also IP-throttled (@Throttle, ~5/min), but the app runs with
 * `trustProxy: true`, so an attacker who rotates the `X-Forwarded-For` header
 * can present a fresh "client IP" on every request and evade the per-IP limit.
 * Each evaded call still spends REAL tokens on the workspace owner's paid AI
 * provider (stepCountIs(5), up to ~240KB of transcript), so a spoofing attacker
 * could run up the owner's bill without bound.
 *
 * This is the SECOND limiter contour: it is keyed by WORKSPACE id (server-
 * resolved from the request host, never attacker-controllable) and therefore
 * caps the owner's bill even when the per-IP limit is fully evaded via XFF
 * spoofing. It is defense-in-depth, NOT a replacement for the per-IP throttle.
 *
 * NOTE: in production this endpoint should ALSO sit behind a trusted reverse
 * proxy that overwrites (not appends) `X-Forwarded-For` with the real client
 * IP, so the per-IP throttle remains meaningful; this per-workspace cap is the
 * backstop for deployments where that is not guaranteed.
 *
 * SLIDING window, CLUSTER-WIDE via Redis.
 * - SLIDING (not fixed) so the true rate over ANY 1h window is bounded. A fixed
 *   window lets ~2x the cap through across a boundary (cap in the last second of
 *   window N + cap in the first second of N+1 = ~2x in ~2s); a sliding-window
 *   log has no such boundary burst.
 * - CLUSTER-WIDE because the state lives in the shared Redis (the same client
 *   that backs the other anti-abuse limits in the repo, e.g. the page-update
 *   email rate limiter), so K app instances share ONE budget instead of each
 *   enforcing its own K x cap.
 *
 * Implementation: a per-key Redis sorted set used as a sliding-window LOG. Each
 * accepted call ZADDs a unique member scored by its epoch-ms timestamp; on every
 * attempt we first ZREMRANGEBYSCORE away entries older than `windowMs`, then
 * count the survivors. The whole check-and-add is one atomic Lua EVAL so two
 * concurrent instances cannot both slip past the cap. The key carries a PEXPIRE
 * of `windowMs` so idle workspaces cost no memory.
 */

/** Default cap: anonymous share-AI calls allowed per workspace per window. */
export const SHARE_AI_WORKSPACE_MAX_PER_WINDOW = 300;
/** Default window length: one rolling hour. */
export const SHARE_AI_WORKSPACE_WINDOW_MS = 60 * 60 * 1000;

/** Redis key namespace for the per-workspace sliding-window log. */
const KEY_PREFIX = 'share-ai:ws:';

/**
 * Atomic sliding-window check-and-consume.
 *
 * KEYS[1] = the per-workspace sorted-set key
 * ARGV[1] = now (epoch ms)
 * ARGV[2] = windowMs
 * ARGV[3] = max
 * ARGV[4] = a unique member id for this attempt (now + random suffix)
 *
 * Returns 1 if the call is admitted (and recorded), 0 if the cap is reached.
 * Drops entries older than the window BEFORE counting, so the budget always
 * reflects exactly the trailing `windowMs`. Only ZADDs on admission, so a
 * rejected call does not extend the window or inflate the count.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count >= max then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return 1
`;

/**
 * Cluster-wide, sliding-window per-key limiter backed by Redis. `tryConsume(key)`
 * atomically admits a call only if fewer than `max` calls were admitted for that
 * key in the trailing `windowMs`. Not coupled to NestJS so it is trivially
 * testable against a mocked/real ioredis client.
 */
export class PublicShareWorkspaceLimiter {
  private readonly logger = new Logger(PublicShareWorkspaceLimiter.name);
  private counter = 0;

  constructor(
    private readonly redis: Redis,
    private readonly max: number = SHARE_AI_WORKSPACE_MAX_PER_WINDOW,
    private readonly windowMs: number = SHARE_AI_WORKSPACE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Account one call for `key`. Returns true if it is within the cap (allowed),
   * false if the cap over the trailing window is exceeded (caller must 429).
   * On a Redis failure we FAIL CLOSED (return false): if Redis is down we cannot
   * prove the workspace is under its cap, so we DENY rather than admit an
   * unmetered, billable anonymous call. The feature is optional, so the
   * temporary denial is harmless. (Operators wanting a tighter steady-state cap
   * can lower the default via SHARE_AI_WORKSPACE_MAX_PER_HOUR, e.g. =100.)
   */
  async tryConsume(key: string): Promise<boolean> {
    const t = this.now();
    // Unique member per attempt so distinct calls in the same millisecond do not
    // collide on the sorted-set score-key and under-count.
    const member = `${t}-${this.counter++}-${Math.random().toString(36).slice(2)}`;
    try {
      const admitted = await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        KEY_PREFIX + key,
        String(t),
        String(this.windowMs),
        String(this.max),
        member,
      );
      return admitted === 1;
    } catch (err) {
      // FAIL CLOSED: if Redis is down we cannot prove the workspace is under its
      // cap, so DENY (controller 429s) rather than admit an unmetered, billable
      // anonymous call. The feature is optional, so denial is harmless.
      this.logger.error(
        `share-ai workspace limiter Redis failure for key "${key}"; failing closed`,
        err as Error,
      );
      return false;
    }
  }
}

/**
 * Read the per-workspace cap from the environment (overridable seam), falling
 * back to the sane default. A non-positive / unparseable value uses the default.
 */
export function resolveShareAiWorkspaceMax(): number {
  const raw = Number(process.env.SHARE_AI_WORKSPACE_MAX_PER_HOUR);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : SHARE_AI_WORKSPACE_MAX_PER_WINDOW;
}

/**
 * Build the limiter from the injected RedisService (the same global ioredis
 * client used by the other anti-abuse limiters). Kept as a tiny factory so the
 * service constructor stays declarative and the limiter remains unit-testable
 * with a hand-rolled fake redis.
 */
export function createPublicShareWorkspaceLimiter(
  redisService: RedisService,
): PublicShareWorkspaceLimiter {
  return new PublicShareWorkspaceLimiter(
    redisService.getOrThrow(),
    resolveShareAiWorkspaceMax(),
    SHARE_AI_WORKSPACE_WINDOW_MS,
  );
}
