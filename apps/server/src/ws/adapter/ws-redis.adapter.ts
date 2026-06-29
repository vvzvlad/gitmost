import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { RedisOptions } from 'ioredis';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../../common/helpers';

export class WsRedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private redisConfig: RedisConfig;
  private pubClient: Redis;
  private subClient: Redis;

  async connectToRedis(): Promise<void> {
    this.redisConfig = parseRedisUrl(process.env.REDIS_URL);

    const options: RedisOptions = {
      family: this.redisConfig.family,
      retryStrategy: createRetryStrategy(),
    };

    const pubClient = new Redis(process.env.REDIS_URL, options);
    const subClient = new Redis(process.env.REDIS_URL, options);

    pubClient.on('error', (err) => () => {});
    subClient.on('error', (err) => () => {});

    // Hold references so the pub/sub connections can be torn down on shutdown
    // (see dispose()); otherwise these ioredis sockets leak as active handles.
    this.pubClient = pubClient;
    this.subClient = subClient;

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }

  /**
   * Called once by Nest's SocketModule during application shutdown, after every
   * socket.io server has been closed. The @socket.io/redis-adapter never owns
   * the lifecycle of the ioredis pub/sub clients it is handed, so we close them
   * here to avoid leaking their TCP handles on shutdown (see issue #255).
   *
   * Uses disconnect(false) to mirror the sibling pub/sub pair in
   * collaboration/extensions/redis-sync (redis-sync.extension.ts onDestroy):
   * an immediate close with no graceful QUIT round-trip and no auto-reconnect,
   * which is what we want for idle adapter clients during teardown.
   */
  async dispose(): Promise<void> {
    await super.dispose();

    // dispose() is invoked once per shutdown; null the refs so a second call
    // (or any post-shutdown path) cannot act on already-closed clients.
    this.pubClient?.disconnect(false);
    this.subClient?.disconnect(false);
    this.pubClient = undefined;
    this.subClient = undefined;
  }
}
