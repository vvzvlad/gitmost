import { Module } from '@nestjs/common';
import { MetricsBullService } from './metrics-bull.service';
import { MetricsServerLifecycle } from './metrics-server.lifecycle';

/**
 * Wires the BullMQ collectors (#355). The queues are provided by the @Global
 * QueueModule (which exports BullModule), so no re-registration is needed here.
 * The HTTP histogram, DB-query and collab-store collectors live in module-level
 * singletons (metrics.registry) and are wired directly at their call sites.
 * MetricsServerLifecycle closes the scrape server on shutdown.
 */
@Module({
  providers: [MetricsBullService, MetricsServerLifecycle],
})
export class MetricsModule {}
