import type { HealthIndicatorService } from '@nestjs/terminus';
import type { EnvironmentService } from '../environment/environment.service';

/**
 * Integration guard for the /health Redis-probe handle leak (#486, commit 2).
 *
 * The bug: `pingCheck` built `new Redis(...)` per call and only disconnected on
 * the SUCCESS path, so when Redis is DOWN every probe tick added ANOTHER
 * forever-reconnecting client — an unbounded handle/client leak for the duration
 * of the outage. The fix reuses ONE long-lived probe client.
 *
 * This is an OBSERVABLE-property test, not an assertion on a mocked return value:
 * we point the indicator at a REAL, refused TCP endpoint (a dead port) so ioredis
 * genuinely fails to connect, run many probes, and assert the number of live
 * Redis CLIENTS created stays at exactly ONE. `ioredis` is delegated to its real
 * implementation (requireActual) — only the constructor is wrapped to COUNT the
 * real clients it creates, which is precisely the leaking resource.
 */
import type { Redis } from 'ioredis';

const mockLiveClients: Redis[] = [];

/**
 * Fully tear a REAL ioredis client down so NO timer survives jest's 1s exit
 * window (this suite must exit cleanly WITHOUT forceExit; see #382).
 *
 * `connector.disconnect()` arms a ~12s "force-destroy the stream" `setTimeout`
 * that is cleared ONLY by the stream's 'close' event — but only when the
 * connector still holds a stream. Two problem cases:
 *  - a LIVE/connecting socket: disconnect arms the timer and 'close' may lag
 *    past jest's window, so we destroy the socket to make 'close' fire NOW;
 *  - a client BETWEEN reconnect attempts to a dead port: the held socket is
 *    ALREADY destroyed (its 'close' fired long ago), so disconnect would arm a
 *    timer whose clearing 'close' can never come again. We drop that dead stream
 *    reference BEFORE disconnect so the doomed timer is never armed.
 * `disconnect()` itself also clears ioredis' own reconnect backoff timer.
 */
type DrainableStream = { destroyed?: boolean; destroy?: () => void } | null;
type DrainableClient = {
  removeAllListeners: (event: string) => void;
  disconnect: () => void;
  stream?: DrainableStream;
  connector?: { stream?: DrainableStream };
};

async function drainClient(client: Redis): Promise<void> {
  if (!client || client.status === 'end') return;
  const c = client as unknown as DrainableClient;
  c.removeAllListeners('error');

  // Drop an already-dead held socket so disconnect() can't arm a timer whose
  // clearing 'close' will never fire again.
  if (c.connector?.stream && c.connector.stream.destroyed) {
    c.connector.stream = null;
  }
  if (c.stream && c.stream.destroyed) {
    c.stream = null;
  }

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    client.once('end', finish);
    // reconnect=false (the default): stop the retry loop and close the socket.
    client.disconnect();
    // Force any still-live socket closed NOW so the connector's stream-destroy
    // timer clears inside jest's window instead of lagging behind a real 'close'.
    if (c.stream && !c.stream.destroyed) {
      c.stream.destroy?.();
    }
    // Fallback for a client with no live stream to emit 'end' (unref'd so it
    // can never itself hold the loop open).
    const fallback = setTimeout(finish, 500);
    (fallback as { unref?: () => void }).unref?.();
  });
}

async function drainAll(): Promise<void> {
  await Promise.all(mockLiveClients.map((c) => drainClient(c)));
}

jest.mock('ioredis', () => {
  const actual = jest.requireActual('ioredis');
  const RealRedis = actual.Redis ?? actual.default ?? actual;
  class CountingRedis extends RealRedis {
    constructor(...args: unknown[]) {
      super(...(args as []));
      mockLiveClients.push(this as never);
    }
  }
  return { ...actual, Redis: CountingRedis, default: CountingRedis };
});

// Import AFTER the mock is registered so the class picks up the counting client.
import { RedisHealthIndicator } from './redis.health';

describe('RedisHealthIndicator handle leak (#486)', () => {
  const indicatorService = {
    check: (key: string) => ({
      up: () => ({ [key]: { status: 'up' } }),
      down: (message: string) => ({ [key]: { status: 'down', message } }),
    }),
  } as unknown as HealthIndicatorService;

  // A port with (almost certainly) nothing listening -> connection refused fast.
  const environmentService = {
    getRedisUrl: () => 'redis://127.0.0.1:6399/0',
  } as unknown as EnvironmentService;

  let indicator: RedisHealthIndicator;

  beforeEach(() => {
    mockLiveClients.length = 0;
    indicator = new RedisHealthIndicator(indicatorService, environmentService);
  });

  afterEach(async () => {
    // Drain (destroy socket + AWAIT 'end') every client the test created FIRST,
    // so each is fully 'end' before onModuleDestroy's disconnect runs — that way
    // no ioredis reconnect / stream-destroy timer outlives jest's exit window.
    await drainAll();
    indicator.onModuleDestroy();
  });

  it('creates exactly ONE Redis client across many probes while Redis is DOWN', async () => {
    const N = 8;
    for (let i = 0; i < N; i++) {
      const result = await indicator.pingCheck('redis');
      // Down endpoint -> every probe reports "down" (not an unhandled crash).
      expect(result.redis.status).toBe('down');
    }

    // THE OBSERVABLE LEAK: on the buggy code this is N (a fresh, never-cleaned
    // reconnecting client per probe). The fix reuses one shared client.
    expect(mockLiveClients).toHaveLength(1);
  });

  it('onModuleDestroy releases the probe client (a later probe builds a fresh one)', async () => {
    await indicator.pingCheck('redis');
    expect(mockLiveClients).toHaveLength(1);

    indicator.onModuleDestroy();
    // A second destroy is a safe no-op (probeClient was nulled).
    indicator.onModuleDestroy();

    // After shutdown the indicator lazily builds a NEW client on the next probe,
    // proving the old one was truly released rather than reused.
    await indicator.pingCheck('redis');
    expect(mockLiveClients).toHaveLength(2);
  });
});

/**
 * Happy-path regression guard (#486, B2): the FIRST probe against a LIVE Redis
 * must report UP.
 *
 * With `lazyConnect: true` + `enableOfflineQueue: false`, a freshly-built client
 * is in the `wait` state and the socket opens lazily. If the very first `ping()`
 * is issued before an explicit `connect()`, ioredis rejects it instantly with
 * "Stream isn't writeable and enableOfflineQueue options is false" — a FALSE
 * DOWN even though Redis is alive. The fix opens the socket before the first
 * ping. This exercises a REAL ioredis client against a REAL TCP redis server
 * (not a mock), so a regression genuinely reddens it.
 */
describe('RedisHealthIndicator live Redis first-probe (#486, B2)', () => {
  const indicatorService = {
    check: (key: string) => ({
      up: () => ({ [key]: { status: 'up' } }),
      down: (message: string) => ({ [key]: { status: 'down', message } }),
    }),
  } as unknown as HealthIndicatorService;

  // A REAL running redis (see the neighboring harness / CI env).
  const environmentService = {
    getRedisUrl: () => 'redis://127.0.0.1:6379/0',
  } as unknown as EnvironmentService;

  let indicator: RedisHealthIndicator;

  beforeEach(() => {
    mockLiveClients.length = 0;
    indicator = new RedisHealthIndicator(indicatorService, environmentService);
  });

  afterEach(async () => {
    // Await full socket close of every live client (see drainClient) BEFORE
    // onModuleDestroy: a real, connected ioredis client MUST be drained to 'end'
    // or its stream-destroy timer keeps the jest worker alive past the 1s window.
    await drainAll();
    indicator.onModuleDestroy();
  });

  it('reports UP on the FIRST probe against a live Redis', async () => {
    // The VERY FIRST probe — no warm-up ping — must be UP.
    const result = await indicator.pingCheck('redis');
    expect(result.redis.status).toBe('up');
  });

  it('stays UP on a probe AFTER onModuleDestroy re-creates the client', async () => {
    await indicator.pingCheck('redis');
    indicator.onModuleDestroy();
    // The re-created client is again in `wait`; the first ping on it must still
    // open the socket (the false-DOWN also recurs on the post-destroy path).
    const result = await indicator.pingCheck('redis');
    expect(result.redis.status).toBe('up');
  });
});
