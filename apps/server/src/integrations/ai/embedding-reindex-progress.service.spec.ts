import { EmbeddingReindexProgressService } from './embedding-reindex-progress.service';
import type { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';

/**
 * Unit tests for the Redis-backed reindex-progress store.
 *
 * The store is a thin, BEST-EFFORT wrapper: writes (start/increment) issue an
 * hset/hincrby + expire pipeline and must SWALLOW Redis errors (progress is
 * cosmetic — it must never break a reindex); reads (get) must map a valid hash
 * to a ReindexProgress and degrade to null on a malformed/missing record or a
 * Redis failure. We drive it with a hand-rolled fake ioredis (the project mocks
 * Redis with plain fakes, see public-share limiter specs).
 */
describe('EmbeddingReindexProgressService', () => {
  const WORKSPACE_ID = 'ws-1';
  const KEY = 'ai:reindex:progress:ws-1';

  /**
   * Build a fake ioredis whose `multi()` returns a chainable recorder and whose
   * `hgetall`/`del` are configurable jest mocks. `execImpl` lets a test make the
   * pipeline reject (to assert error-swallowing).
   */
  function makeRedis(opts: { execImpl?: () => Promise<unknown> } = {}) {
    const exec = jest
      .fn()
      .mockImplementation(opts.execImpl ?? (() => Promise.resolve([])));
    // mockReturnThis() returns the call's `this` (the multi object), so the
    // chain hset().expire().exec() resolves correctly.
    const multiObj = {
      hset: jest.fn().mockReturnThis(),
      hincrby: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec,
    };
    const multi = jest.fn(() => multiObj);
    const hgetall = jest.fn().mockResolvedValue({});
    const del = jest.fn().mockResolvedValue(1);
    const redis = { multi, hgetall, del } as unknown as Redis;
    return { redis, multiObj, multi, hgetall, del, exec };
  }

  function makeService(redis: Redis) {
    const redisService = {
      getOrThrow: () => redis,
    } as unknown as RedisService;
    return new EmbeddingReindexProgressService(redisService);
  }

  describe('get', () => {
    it('maps a valid hash to a ReindexProgress object', async () => {
      const { redis, hgetall } = makeRedis();
      hgetall.mockResolvedValue({ total: '478', done: '120', startedAt: '1000' });
      const service = makeService(redis);

      await expect(service.get(WORKSPACE_ID)).resolves.toEqual({
        total: 478,
        done: 120,
        startedAt: 1000,
      });
      expect(hgetall).toHaveBeenCalledWith(KEY);
    });

    it('returns null for an empty hash (no record)', async () => {
      const { redis, hgetall } = makeRedis();
      hgetall.mockResolvedValue({});
      await expect(makeService(redis).get(WORKSPACE_ID)).resolves.toBeNull();
    });

    it('returns null when `total` is missing (partial record)', async () => {
      const { redis, hgetall } = makeRedis();
      hgetall.mockResolvedValue({ done: '5' });
      await expect(makeService(redis).get(WORKSPACE_ID)).resolves.toBeNull();
    });

    it('returns null for a non-numeric total', async () => {
      const { redis, hgetall } = makeRedis();
      hgetall.mockResolvedValue({ total: 'abc', done: '1', startedAt: '1' });
      await expect(makeService(redis).get(WORKSPACE_ID)).resolves.toBeNull();
    });

    it('returns null for a non-numeric done', async () => {
      const { redis, hgetall } = makeRedis();
      hgetall.mockResolvedValue({ total: '10', done: 'xyz', startedAt: '1' });
      await expect(makeService(redis).get(WORKSPACE_ID)).resolves.toBeNull();
    });

    it('coerces a non-finite startedAt to 0', async () => {
      const { redis, hgetall } = makeRedis();
      hgetall.mockResolvedValue({ total: '10', done: '2', startedAt: 'nope' });
      await expect(makeService(redis).get(WORKSPACE_ID)).resolves.toEqual({
        total: 10,
        done: 2,
        startedAt: 0,
      });
    });

    it('degrades to null when hgetall throws (degradation contract)', async () => {
      const { redis, hgetall } = makeRedis();
      hgetall.mockRejectedValue(new Error('redis down'));
      await expect(makeService(redis).get(WORKSPACE_ID)).resolves.toBeNull();
    });
  });

  describe('start', () => {
    it('issues hset + expire on the workspace key', async () => {
      const { redis, multiObj } = makeRedis();
      await makeService(redis).start(WORKSPACE_ID, 478);

      expect(multiObj.hset).toHaveBeenCalledWith(
        KEY,
        expect.objectContaining({ total: '478', done: '0' }),
      );
      expect(multiObj.expire).toHaveBeenCalledWith(KEY, expect.any(Number));
      expect(multiObj.exec).toHaveBeenCalledTimes(1);
    });

    it('swallows a thrown Redis error (best-effort)', async () => {
      const { redis } = makeRedis({
        execImpl: () => Promise.reject(new Error('redis down')),
      });
      await expect(
        makeService(redis).start(WORKSPACE_ID, 1),
      ).resolves.toBeUndefined();
    });
  });

  describe('increment', () => {
    it('issues hincrby + expire on the workspace key', async () => {
      const { redis, multiObj } = makeRedis();
      await makeService(redis).increment(WORKSPACE_ID);

      expect(multiObj.hincrby).toHaveBeenCalledWith(KEY, 'done', 1);
      expect(multiObj.expire).toHaveBeenCalledWith(KEY, expect.any(Number));
      expect(multiObj.exec).toHaveBeenCalledTimes(1);
    });

    it('swallows a thrown Redis error (best-effort)', async () => {
      const { redis } = makeRedis({
        execImpl: () => Promise.reject(new Error('redis down')),
      });
      await expect(
        makeService(redis).increment(WORKSPACE_ID),
      ).resolves.toBeUndefined();
    });
  });

  describe('clear', () => {
    it('deletes the workspace key', async () => {
      const { redis, del } = makeRedis();
      await makeService(redis).clear(WORKSPACE_ID);
      expect(del).toHaveBeenCalledWith(KEY);
    });

    it('swallows a thrown Redis error (best-effort)', async () => {
      const { redis, del } = makeRedis();
      del.mockRejectedValue(new Error('redis down'));
      await expect(
        makeService(redis).clear(WORKSPACE_ID),
      ).resolves.toBeUndefined();
    });
  });
});
