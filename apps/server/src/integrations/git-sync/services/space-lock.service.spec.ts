// Unit tests for SpaceLockService in ISOLATION. The lock is exercised against a
// fake redis (mock `set`/`eval`) and we assert the exact ARGUMENTS passed to
// redis — the test-coverage gap this refactor (PR #119 #2) closes: acquire uses
// `SET ... PX <ttl> NX`, release uses a DEL-CAS Lua, and the heartbeat refresh
// uses a PEXPIRE-CAS Lua, all keyed by the same private instanceId.
import { Logger } from '@nestjs/common';
import { SpaceLockService } from './space-lock.service';
import {
  GIT_SYNC_LOCK_PREFIX,
  GIT_SYNC_LOCK_TTL_MS,
} from '../git-sync.constants';

type AnyMock = jest.Mock;

interface Built {
  service: SpaceLockService;
  redis: { set: AnyMock; eval: AnyMock };
}

function build(): Built {
  const redis = {
    // Default: lock acquired. Tests override per-case.
    set: jest.fn(async () => 'OK'),
    eval: jest.fn(async () => 1),
  };
  const redisService = { getOrThrow: jest.fn(() => redis) };
  const service = new SpaceLockService(redisService as any);
  return { service, redis };
}

/** Drain queued microtasks so awaited continuations inside the lock run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SpaceLockService', () => {
  describe('acquire (SET NX/PX)', () => {
    it('calls redis.set with (prefix+spaceId, <instanceId>, PX, ttl, NX) and reuses the instanceId on release', async () => {
      const { service, redis } = build();

      const result = await service.withSpaceLock('space-1', async () => 'ok');
      expect(result).toBe('ok');

      // acquire arguments
      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, instanceId, px, ttl, nx] = redis.set.mock.calls[0];
      expect(key).toBe(GIT_SYNC_LOCK_PREFIX + 'space-1');
      expect(typeof instanceId).toBe('string');
      expect(instanceId.length).toBeGreaterThan(0);
      expect(px).toBe('PX');
      expect(ttl).toBe(GIT_SYNC_LOCK_TTL_MS);
      expect(nx).toBe('NX');

      // release (eval) reuses the SAME instanceId as ARGV[1]
      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [, , relKey, relInstanceId] = redis.eval.mock.calls[0];
      expect(relKey).toBe(GIT_SYNC_LOCK_PREFIX + 'space-1');
      expect(relInstanceId).toBe(instanceId);
    });
  });

  describe('release (DEL-CAS Lua)', () => {
    it('returns the fn result and runs a get/del CAS-compared release in finally', async () => {
      const { service, redis } = build();

      const result = await service.withSpaceLock('space-1', async () => 42);
      expect(result).toBe(42);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [lua, numKeys, key, instanceId] = redis.eval.mock.calls[0];
      expect(lua).toContain('get');
      expect(lua).toContain('del');
      expect(lua).toContain('== ARGV[1]');
      expect(numKeys).toBe(1);
      expect(key).toBe(GIT_SYNC_LOCK_PREFIX + 'space-1');
      expect(typeof instanceId).toBe('string');
    });
  });

  describe('lock held by another replica', () => {
    it("returns { skipped: 'lock-held' } without running fn or releasing when set != 'OK'", async () => {
      const { service, redis } = build();
      redis.set.mockResolvedValueOnce(null);
      const fn = jest.fn(async () => 'ran');

      const result = await service.withSpaceLock('space-1', fn);

      expect(result).toEqual({ skipped: 'lock-held' });
      expect(fn).not.toHaveBeenCalled();
      // No release: we never acquired it.
      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('in-process mutex', () => {
    it("a second withSpaceLock on the same space mid-flight returns { skipped: 'in-progress' } without a second set", async () => {
      const { service, redis } = build();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = service.withSpaceLock('space-1', async () => {
        await gate;
        return 'first';
      });
      // Let the first call acquire + enter the running set.
      await flushMicrotasks();

      const second = await service.withSpaceLock('space-1', async () => 'second');
      expect(second).toEqual({ skipped: 'in-progress' });
      // Only the first call hit redis.set — the mutex short-circuits the second.
      expect(redis.set).toHaveBeenCalledTimes(1);

      release();
      await expect(first).resolves.toBe('first');
    });
  });

  // Bug #1 (push 503 starvation): the PUSH path passes a bounded acquireRetry so a
  // transient overlap with a poll cycle is retried (and succeeds) instead of an
  // immediate 503. A genuinely stuck lock still skips after the bound. The poll
  // cycle passes NO retry (immediate skip), so only the push path waits.
  describe('bounded acquire-retry (push path)', () => {
    const retry = { timeoutMs: 5_000, baseMs: 100, maxMs: 500 };

    it('retries the acquire and SUCCEEDS when the lock is briefly held then released', async () => {
      const { service, redis } = build();
      // First acquire attempt fails (lock briefly held by a cycle), the next
      // succeeds — the bounded retry must turn this into a SUCCESS, not a skip.
      redis.set
        .mockResolvedValueOnce(null) // attempt 1: held
        .mockResolvedValueOnce(null) // attempt 2: still held
        .mockResolvedValue('OK'); // attempt 3+: released -> acquired
      const fn = jest.fn(async () => 'pushed');

      const result = await service.withSpaceLock('space-1', fn, {
        acquireRetry: retry,
      });

      expect(result).toBe('pushed');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(redis.set.mock.calls.length).toBeGreaterThanOrEqual(3);
      // The acquired lock is released in finally (DEL-CAS eval).
      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(redis.eval.mock.calls[0][0]).toContain('del');
    });

    it('still skips (lock-held) after the bound when the lock stays stuck — and never runs fn', async () => {
      const { service, redis } = build();
      redis.set.mockResolvedValue(null); // permanently held
      const fn = jest.fn(async () => 'pushed');

      const result = await service.withSpaceLock('space-1', fn, {
        acquireRetry: { timeoutMs: 300, baseMs: 50, maxMs: 100 },
      });

      expect(result).toEqual({ skipped: 'lock-held' });
      expect(fn).not.toHaveBeenCalled();
      // It retried more than once before giving up (bound > one interval).
      expect(redis.set.mock.calls.length).toBeGreaterThan(1);
      // Never acquired -> never released.
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('without acquireRetry (poll path) a held lock skips IMMEDIATELY (single attempt)', async () => {
      const { service, redis } = build();
      redis.set.mockResolvedValue(null);
      const fn = jest.fn(async () => 'cycle');

      const result = await service.withSpaceLock('space-1', fn);

      expect(result).toEqual({ skipped: 'lock-held' });
      expect(redis.set).toHaveBeenCalledTimes(1); // no retry
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('fn throwing', () => {
    it('propagates the throw AND still releases (eval) in finally', async () => {
      const { service, redis } = build();
      const boom = new Error('boom');

      await expect(
        service.withSpaceLock('space-1', async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      // Release still ran despite the throw.
      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [lua] = redis.eval.mock.calls[0];
      expect(lua).toContain('del');
    });
  });

  describe('heartbeat refresh (PEXPIRE-CAS Lua)', () => {
    it('extends the lock via a pexpire CAS-Lua with the same instanceId while fn is in flight', async () => {
      jest.useFakeTimers();
      try {
        const { service, redis } = build();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });

        const run = service.withSpaceLock('space-1', async () => {
          await gate;
          return 'done';
        });
        // Let acquire resolve and the running.add + setInterval registration run.
        await flushMicrotasks();

        // Capture the instanceId used on acquire so we can assert it is reused.
        const instanceId = redis.set.mock.calls[0][1];

        // Advance past one heartbeat interval (≈ TTL/3) to fire refreshLock.
        jest.advanceTimersByTime(Math.floor(GIT_SYNC_LOCK_TTL_MS / 3));
        await flushMicrotasks();

        // The refresh eval ran (release has not, fn still awaiting the gate).
        expect(redis.eval).toHaveBeenCalledTimes(1);
        const [lua, numKeys, key, argInstanceId, ttlArg] =
          redis.eval.mock.calls[0];
        expect(lua).toContain('pexpire');
        expect(lua).toContain('== ARGV[1]');
        expect(numKeys).toBe(1);
        expect(key).toBe(GIT_SYNC_LOCK_PREFIX + 'space-1');
        expect(argInstanceId).toBe(instanceId);
        expect(ttlArg).toBe(String(GIT_SYNC_LOCK_TTL_MS));

        // Let fn finish; release runs in finally (second eval, the DEL-CAS).
        release();
        await flushMicrotasks();
        await expect(run).resolves.toBe('done');
        expect(redis.eval).toHaveBeenCalledTimes(2);
        expect(redis.eval.mock.calls[1][0]).toContain('del');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // The lost-lock guard: a heartbeat refresh that cannot CONFIRM we still own the
  // lock (CAS miss, res !== 1) OR that throws (Redis error) aborts the supplied
  // controller so the in-flight protected fn stops instead of writing blind after
  // a possible lock takeover. `withSpaceLock` threads that signal into `fn`.
  describe('abort-on-lost-lock', () => {
    it('aborts the in-flight fn when the heartbeat refresh CAS-MISSES (eval -> 0)', async () => {
      jest.useFakeTimers();
      try {
        const { service, redis } = build();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let captured: AbortSignal | undefined;

        const run = service.withSpaceLock('space-1', async (signal) => {
          captured = signal;
          await gate;
          return 'done';
        });
        // Let acquire resolve and the setInterval register.
        await flushMicrotasks();
        expect(captured).toBeDefined();
        expect(captured!.aborted).toBe(false);

        // The refresh CAS-misses: the key no longer holds our instanceId.
        redis.eval.mockResolvedValue(0);
        jest.advanceTimersByTime(Math.floor(GIT_SYNC_LOCK_TTL_MS / 3));
        await flushMicrotasks();

        // The lost lock aborted the protected fn's signal.
        expect(captured!.aborted).toBe(true);

        release();
        await flushMicrotasks();
        await expect(run).resolves.toBe('done');
      } finally {
        jest.useRealTimers();
      }
    });

    it('aborts the in-flight fn when the heartbeat refresh THROWS (Redis error)', async () => {
      jest.useFakeTimers();
      try {
        const { service, redis } = build();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let captured: AbortSignal | undefined;

        const run = service.withSpaceLock('space-1', async (signal) => {
          captured = signal;
          await gate;
          return 'done';
        });
        await flushMicrotasks();
        expect(captured!.aborted).toBe(false);

        // The refresh eval rejects (Redis down). release() in finally must still
        // resolve, so only reject the NEXT (heartbeat) call, then go back to OK.
        redis.eval.mockRejectedValueOnce(new Error('redis down'));
        jest.advanceTimersByTime(Math.floor(GIT_SYNC_LOCK_TTL_MS / 3));
        await flushMicrotasks();

        expect(captured!.aborted).toBe(true);

        release();
        await flushMicrotasks();
        await expect(run).resolves.toBe('done');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

// Silence the warn logger if a refresh/release path ever logs (defensive).
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
