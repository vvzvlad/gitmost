import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import { Redis } from 'ioredis';

@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  /**
   * ONE long-lived probe connection, reused across every /health tick. The old
   * code built `new Redis(...)` per call and only `disconnect()`d on the SUCCESS
   * path, so while Redis was DOWN every probe added a fresh, forever-reconnecting
   * client — a handle leak that grew without bound for as long as the outage (and
   * the health checker keeps polling) lasted. A single shared client keeps at most
   * ONE background reconnect loop regardless of how many probes run.
   */
  private probeClient: Redis | null = null;

  /**
   * How long the first-ping `connect()` may take before a probe gives up and
   * reports DOWN. A `connect()` against a truly-down Redis never settles on its
   * own (ioredis retries the socket indefinitely per its retryStrategy), so the
   * probe MUST bound it or the /health handler would hang. Kept short so a real
   * outage is reported fast; localhost/live Redis connects well within it.
   */
  private static readonly CONNECT_TIMEOUT_MS = 2000;

  /**
   * The single in-flight first-`connect()`, memoized so CONCURRENT probes share
   * it. k8s liveness+readiness hit /health in parallel on startup: without this,
   * probe A drives `connect()` (the client leaves the `wait` state) and probe B,
   * seeing a not-`wait`/not-`ready` client, would skip connect and fire `ping()`
   * at a still-opening socket → an instant FALSE DOWN. With the memo, B awaits
   * the SAME connect. Cleared once it settles so a later disconnect / re-create
   * starts a fresh connect.
   */
  private connectingPromise: Promise<void> | null = null;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private environmentService: EnvironmentService,
  ) {}

  private getProbeClient(): Redis {
    if (!this.probeClient) {
      this.probeClient = new Redis(this.environmentService.getRedisUrl(), {
        // Constructing must never throw or eagerly connect; the first ping opens
        // the socket. This lets us build the client once and reuse it.
        lazyConnect: true,
        // A health probe must fail FAST, not queue behind a stuck reconnect: one
        // retry per request, and no offline queue so a ping while disconnected
        // rejects immediately instead of buffering commands that pile up in RAM.
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      // ioredis emits 'error' on every failed (re)connect; with no listener that
      // surfaces as an unhandled 'error' event and can crash the process. Swallow
      // it here — pingCheck already reports health — and log at debug so a Redis
      // outage does not flood the logs.
      this.probeClient.on('error', (err) => {
        this.logger.debug(
          `Redis probe connection error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    return this.probeClient;
  }

  /**
   * Open the probe socket BEFORE the first ping. `lazyConnect: true` leaves a
   * freshly-built (or post-destroy re-built) client in the `wait` state: the
   * socket is NOT open yet, so with `enableOfflineQueue: false` the very first
   * `ping()` rejects instantly with "Stream isn't writeable and
   * enableOfflineQueue options is false" even when Redis is perfectly alive — a
   * false DOWN on the happy path. We drive `connect()` ONLY from `wait`; once
   * the client is connected, ioredis owns its own (re)connect loop and a ping
   * issued while it reconnects still fast-fails to a correct DOWN (offline queue
   * stays off). A failed/timed-out connect rejects → reported DOWN, which is the
   * right signal for a truly-down Redis.
   */
  private ensureConnected(client: Redis): Promise<void> {
    // Already open — steady state, nothing to do.
    if (client.status === 'ready') return Promise.resolve();
    // A first-connect is already in flight (possibly started by a CONCURRENT
    // probe): await the SAME one instead of racing a second connect() (ioredis
    // throws "already connecting") or firing ping() at a not-yet-open socket.
    if (this.connectingPromise) return this.connectingPromise;
    // Only DRIVE connect() from the initial `wait` state (fresh / post-destroy
    // re-created client). In any other non-ready state ioredis already owns its
    // (re)connect loop; a ping there fast-fails to a correct DOWN, so we must not
    // start a competing connect.
    if (client.status !== 'wait') return Promise.resolve();

    const promise = this.connectWithTimeout(client).finally(() => {
      // Clear only if still ours, so a later disconnect / re-create can connect
      // again. Whether it resolved or rejected, the memo has served its window.
      if (this.connectingPromise === promise) {
        this.connectingPromise = null;
      }
    });
    this.connectingPromise = promise;
    return promise;
  }

  private connectWithTimeout(client: Redis): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Redis probe connect timed out'));
      }, RedisHealthIndicator.CONNECT_TIMEOUT_MS);
      // Never let THIS timer alone keep the event loop (or a jest worker) alive;
      // it is cleared on settle anyway, this is belt-and-braces.
      timer.unref?.();
      // `.catch` is always attached, so a connect() that rejects AFTER we have
      // already timed out is handled here (guarded by `settled`) and never
      // surfaces as an unhandled rejection.
      client
        .connect()
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const redis = this.getProbeClient();
      // Open the socket before the first ping (see ensureConnected); without
      // this the first probe after (re)creation falsely reports DOWN on a live
      // Redis because lazyConnect defers the connect past the first ping.
      await this.ensureConnected(redis);
      await redis.ping();
      return indicator.up();
    } catch (e) {
      this.logger.error(e);
      return indicator.down(`${key} is not available`);
    }
  }

  onModuleDestroy(): void {
    if (this.probeClient) {
      // disconnect() (not quit()) tears the socket + reconnect loop down
      // immediately without waiting on a round-trip to a possibly-down server.
      // Do NOT removeAllListeners() with no event name — that would also strip
      // ioredis' OWN internal listeners and break its teardown; our 'error'
      // listener is harmless and dies with the dropped client reference.
      this.probeClient.disconnect();
      this.probeClient = null;
    }
    // Drop any in-flight first-connect memo so the NEXT client (lazily rebuilt on
    // the next probe) starts a fresh connect rather than awaiting a promise tied
    // to the client we just tore down.
    this.connectingPromise = null;
  }
}
