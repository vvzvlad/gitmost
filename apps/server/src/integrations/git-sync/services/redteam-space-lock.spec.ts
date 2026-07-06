// Red-team finding #10: single-writer guarantee across replicas must survive a
// TTL lapse with a swallowed heartbeat refresh. Two SpaceLockService instances
// (A, B) share ONE redis store. A holds 'X' and stays in-flight; the lock key
// then disappears (TTL expiry while refreshLock silently failed). B must NOT be
// able to acquire 'X' and run its fn concurrently with A — that would be two
// writers racing the same working tree. This test asserts the DESIRED
// single-writer behavior, so it FAILS today if the lapse lets B in.
import { Logger } from '@nestjs/common';
import { SpaceLockService } from './space-lock.service';
import { GIT_SYNC_LOCK_PREFIX } from '../git-sync.constants';

/**
 * Minimal shared fake redis honoring exactly the two primitives the lock uses:
 *   - `SET key val PX ttl NX` → 'OK' only when the key is absent (NX semantics).
 *   - `eval(<get/del CAS>|<get/pexpire CAS>, 1, key, instanceId[, ttl])` →
 *     compares the stored value to ARGV[1] before del/pexpire (CAS).
 * TTL expiry is not time-driven here; tests simulate it by mutating `store`.
 */
function makeSharedRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, val: string, _px: 'PX', _ttl: number, nx: 'NX') {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, val);
      return 'OK';
    },
    async eval(lua: string, _numKeys: number, key: string, argInstanceId: string) {
      // Only act when WE still own the key (CAS), mirroring the Lua scripts.
      if (store.get(key) !== argInstanceId) return 0;
      if (lua.includes('del')) {
        store.delete(key);
        return 1;
      }
      // pexpire CAS refresh: value matches, "extend" is a no-op in the fake.
      return 1;
    },
  };
}

function buildInstance(redis: ReturnType<typeof makeSharedRedis>) {
  const redisService = { getOrThrow: jest.fn(() => redis) };
  return new SpaceLockService(redisService as any);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('SpaceLockService — finding #10 single-writer across TTL lapse', () => {
  it('B must not run its fn concurrently with an in-flight A after the lock key vanishes', async () => {
    const redis = makeSharedRedis();
    const A = buildInstance(redis);
    const B = buildInstance(redis);

    let aRunning = false;
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A acquires 'X' and stays in-flight awaiting the gate.
    const aResult = A.withSpaceLock('X', async () => {
      aRunning = true;
      await gateA;
      aRunning = false;
      return 'A-done';
    });
    await flushMicrotasks();

    // Sanity: A is in-flight and owns the redis key.
    expect(aRunning).toBe(true);
    expect(redis.store.has(GIT_SYNC_LOCK_PREFIX + 'X')).toBe(true);

    // Simulate TTL lapse with a swallowed heartbeat refresh: the lock key
    // disappears from the shared store while A is still running.
    redis.store.delete(GIT_SYNC_LOCK_PREFIX + 'X');

    // Now B tries to take 'X'. Desired: rejected as 'lock-held' (single writer);
    // and under no circumstance may fn2 run while A is still in flight.
    let bRanWhileARunning = false;
    const bResult = await B.withSpaceLock('X', async () => {
      bRanWhileARunning = aRunning; // captures whether A was still in-flight
      return 'B-done';
    });

    // Single-writer assertions: B did NOT execute concurrently with A.
    expect(bRanWhileARunning).toBe(false);
    expect(bResult).toEqual({ skipped: 'lock-held' });

    // Cleanup: let A finish.
    releaseA();
    await expect(aResult).resolves.toBe('A-done');
  });
});
