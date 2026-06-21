import Redis from 'ioredis';
import { PublicShareWorkspaceLimiter } from 'src/core/ai-chat/public-share-workspace-limiter';

/**
 * D — PublicShareWorkspaceLimiter against REAL Redis (logical DB 15, so nothing
 * touches dev data). This exercises the actual Lua EVAL — including
 * ZREMRANGEBYSCORE eviction and the `ZCARD >= max` boundary — which a FakeRedis
 * cannot faithfully reproduce.
 */
describe('PublicShareWorkspaceLimiter vs real Redis [integration]', () => {
  let redis: Redis;

  beforeAll(async () => {
    // db:15 keeps this off the app's db 0, so dev Redis data is never touched.
    const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
    redis = new Redis(url, { db: 15, lazyConnect: false });
    // Surface an unreachable/wrong Redis here with a clear error, not mid-test.
    await redis.ping();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('admits the first max calls and denies the next, then re-admits after the window slides', async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const limiter = new PublicShareWorkspaceLimiter(redis, 3, 1000, now);
    const key = 'ws-sliding';

    // First 3 admitted.
    expect(await limiter.tryConsume(key)).toBe(true);
    expect(await limiter.tryConsume(key)).toBe(true);
    expect(await limiter.tryConsume(key)).toBe(true);
    // 4th denied (cap reached; ZCARD >= max).
    expect(await limiter.tryConsume(key)).toBe(false);

    // Advance time past the window so all 3 entries fall out of the trailing
    // windowMs and ZREMRANGEBYSCORE evicts them.
    nowMs += 1500;
    expect(await limiter.tryConsume(key)).toBe(true);
  });

  it('counts 3 distinct same-millisecond calls distinctly, then denies the 4th', async () => {
    // Fixed `now` => all attempts share the same timestamp. Unique member ids
    // (counter + random suffix) keep them distinct in the sorted set so the
    // count is not under-reported by score collision.
    const now = () => 2_000_000;
    const limiter = new PublicShareWorkspaceLimiter(redis, 3, 1000, now);
    const key = 'ws-same-ms';

    expect(await limiter.tryConsume(key)).toBe(true);
    expect(await limiter.tryConsume(key)).toBe(true);
    expect(await limiter.tryConsume(key)).toBe(true);
    expect(await limiter.tryConsume(key)).toBe(false);

    // Confirm the sorted set actually holds 3 distinct members at one score.
    const card = await redis.zcard('share-ai:ws:' + key);
    expect(card).toBe(3);
  });

  it('keys are isolated per workspace', async () => {
    const now = () => 3_000_000;
    const limiter = new PublicShareWorkspaceLimiter(redis, 1, 1000, now);

    expect(await limiter.tryConsume('ws-a')).toBe(true);
    expect(await limiter.tryConsume('ws-a')).toBe(false);
    // Different key has its own independent budget.
    expect(await limiter.tryConsume('ws-b')).toBe(true);
  });
});
