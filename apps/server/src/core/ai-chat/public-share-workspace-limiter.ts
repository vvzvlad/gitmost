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
export const SHARE_AI_WORKSPACE_MAX_PER_WINDOW = 100;
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
   * On a Redis failure we FAIL CLOSED (return false): this cap is the COST
   * backstop for an OPTIONAL anonymous assistant, so when Redis is unavailable we
   * cannot prove the workspace is under its cap and therefore DENY rather than
   * admit an unmetered, billable anonymous call. A transient Redis blip briefly
   * disabling the assistant is preferable to an unbounded provider bill.
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
      // FAIL CLOSED: when Redis is unavailable we cannot prove the workspace is
      // under its cap, so we DENY (the controller 429s) rather than admit an
      // unmetered, billable anonymous call. The assistant is optional, so a
      // transient Redis blip briefly disabling it is the safer failure mode than
      // an unbounded provider bill.
      this.logger.error(
        `share-ai workspace limiter Redis failure for key "${key}"; failing closed`,
        err as Error,
      );
      return false;
    }
  }
}

/**
 * SECOND cost contour: a per-workspace TOKEN budget over a rolling DAY.
 *
 * The request-count cap above bounds how MANY anonymous calls a workspace
 * admits, but NOT how expensive each one is: one accepted call runs the agent
 * loop up to `stepCountIs(5)`, and every step re-sends the WHOLE client-held
 * transcript (~hundreds of KB) as input, so the provider input alone can be tens
 * of thousands of tokens PER step while `maxOutputTokens` only caps the output.
 * The request cap is also hourly with no daily ceiling, so a steady stream at
 * the hourly cap sustains ~24x its count per day. Counting requests therefore
 * does not bound the owner's actual LLM bill (issue #159, finding #5).
 *
 * This contour caps the SPEND directly: the actual tokens consumed (input +
 * output, summed across all steps of every accepted turn) over the trailing
 * `windowMs` (one rolling day) must stay under `budget`. It is checked BEFORE a
 * turn streams (read-only) and the turn's real usage is recorded AFTER it
 * finishes (`streamText` onFinish). Like the request cap it is cluster-wide
 * (shared Redis) and uses a sliding-window LOG so the day boundary cannot be
 * gamed for a 2x burst.
 *
 * Pre-check is read-only, so a turn already over budget is rejected, but the
 * tokens of an in-flight turn are not yet known and are accounted only once it
 * finishes. The worst-case overshoot past the budget is therefore one turn
 * (bounded by steps x (maxOutputTokens + transcript size)) — acceptable for a
 * cost backstop on an optional anonymous assistant.
 */

/** Default per-workspace token budget over the rolling day. */
export const SHARE_AI_WORKSPACE_TOKEN_BUDGET_DEFAULT = 1_000_000;
/** Default token-budget window length: one rolling day. */
export const SHARE_AI_WORKSPACE_TOKEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Redis key namespace for the per-workspace token-spend sliding-window log. */
const TOKEN_KEY_PREFIX = 'share-ai:ws-tokens:';

/**
 * Read-only sliding-window token-budget check.
 *
 * KEYS[1] = the per-workspace token sorted-set key
 * ARGV[1] = now (epoch ms)
 * ARGV[2] = windowMs
 * ARGV[3] = budget (max tokens in the trailing window)
 *
 * Drops entries older than the window, then sums the token counts encoded as the
 * leading integer of each surviving member. Returns 1 if the running total is
 * still UNDER budget (admit), 0 once it has reached/exceeded the budget. Does NOT
 * add anything — the turn's real usage is recorded separately once it finishes.
 */
const TOKEN_BUDGET_CHECK_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local budget = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local members = redis.call('ZRANGE', key, 0, -1)
local total = 0
for i = 1, #members do
  local t = tonumber(string.match(members[i], '^(%d+)'))
  if t then total = total + t end
end
if total >= budget then
  return 0
end
return 1
`;

/**
 * Record one finished turn's token spend in the sliding-window log.
 *
 * KEYS[1] = the per-workspace token sorted-set key
 * ARGV[1] = now (epoch ms) — the entry score
 * ARGV[2] = windowMs
 * ARGV[3] = member (`<tokens>:<unique>`; the leading integer is the token count)
 *
 * Always ZADDs (the turn already ran and spent the tokens) and refreshes the
 * key TTL so idle workspaces cost no memory. Trims expired entries first so the
 * set never grows unbounded for a busy workspace.
 */
const TOKEN_RECORD_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return 1
`;

/**
 * Cluster-wide, sliding-window per-workspace TOKEN budget backed by Redis.
 * `withinBudget(key)` is a read-only pre-stream gate; `record(key, tokens)`
 * accounts a finished turn's real usage. Decoupled from NestJS so it is testable
 * against a mocked/real ioredis client, mirroring the request-count limiter.
 */
export class PublicShareWorkspaceTokenBudget {
  private readonly logger = new Logger(PublicShareWorkspaceTokenBudget.name);
  private counter = 0;

  constructor(
    private readonly redis: Redis,
    private readonly budget: number = SHARE_AI_WORKSPACE_TOKEN_BUDGET_DEFAULT,
    private readonly windowMs: number = SHARE_AI_WORKSPACE_TOKEN_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read-only pre-stream check. Returns true while the workspace is under its
   * rolling-day token budget, false once the trailing-window spend has reached
   * it (caller must then 429 BEFORE streaming any tokens).
   *
   * FAILS CLOSED (false) on a Redis error: identical reasoning to the request
   * limiter — when we cannot prove the workspace is under budget we DENY rather
   * than admit an unmetered billable call. The assistant is optional, so a
   * transient Redis blip briefly disabling it beats an unbounded provider bill.
   */
  async withinBudget(key: string): Promise<boolean> {
    const t = this.now();
    try {
      const admitted = await this.redis.eval(
        TOKEN_BUDGET_CHECK_LUA,
        1,
        TOKEN_KEY_PREFIX + key,
        String(t),
        String(this.windowMs),
        String(this.budget),
      );
      return admitted === 1;
    } catch (err) {
      this.logger.error(
        `share-ai token budget Redis failure for key "${key}"; failing closed`,
        err as Error,
      );
      return false;
    }
  }

  /**
   * Record a finished turn's token spend. Best-effort: the turn already ran, so
   * a Redis failure here is logged but not propagated — it would only cause a
   * slight under-count of the running budget, never a wrong answer to the
   * caller. Non-positive / non-finite usage is ignored.
   */
  async record(key: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const spend = Math.floor(tokens);
    const t = this.now();
    // Member: `<tokens>:<unique>` — the check Lua sums the leading integer, and
    // the unique suffix keeps distinct turns in the same ms from colliding on
    // the sorted-set member (which would drop one entry and under-count).
    const member = `${spend}:${t}-${this.counter++}-${Math.random()
      .toString(36)
      .slice(2)}`;
    try {
      await this.redis.eval(
        TOKEN_RECORD_LUA,
        1,
        TOKEN_KEY_PREFIX + key,
        String(t),
        String(this.windowMs),
        member,
      );
    } catch (err) {
      this.logger.error(
        `share-ai token budget record failure for key "${key}" (${spend} tokens); ignoring`,
        err as Error,
      );
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

/**
 * Read the per-workspace rolling-day token budget from the environment
 * (overridable seam), falling back to the sane default. A non-positive /
 * unparseable value uses the default.
 */
export function resolveShareAiWorkspaceTokenBudget(): number {
  const raw = Number(process.env.SHARE_AI_WORKSPACE_TOKEN_BUDGET_PER_DAY);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : SHARE_AI_WORKSPACE_TOKEN_BUDGET_DEFAULT;
}

/**
 * Build the per-workspace token budget from the injected RedisService (the same
 * global ioredis client used by the request-count limiter). Tiny factory so the
 * service constructor stays declarative and the budget stays unit-testable with
 * a hand-rolled fake redis.
 */
export function createPublicShareWorkspaceTokenBudget(
  redisService: RedisService,
): PublicShareWorkspaceTokenBudget {
  return new PublicShareWorkspaceTokenBudget(
    redisService.getOrThrow(),
    resolveShareAiWorkspaceTokenBudget(),
    SHARE_AI_WORKSPACE_TOKEN_WINDOW_MS,
  );
}
