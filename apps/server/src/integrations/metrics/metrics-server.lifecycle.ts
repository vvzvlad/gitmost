import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { closeMetricsServer } from './metrics.server';

/**
 * Ties the bare node:http metrics scrape server (started in main.ts after the
 * Fastify app is up, outside the DI container) into Nest's shutdown lifecycle.
 * With `app.enableShutdownHooks()`, onModuleDestroy fires on SIGTERM/SIGINT and
 * closes the listener so it is not left dangling (jest/e2e never exits, and a
 * prod restart doesn't leak the port). No-op when metrics are disabled.
 */
@Injectable()
export class MetricsServerLifecycle implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await closeMetricsServer();
  }
}
