import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import { QueueName } from '../queue/constants';
import { EnvironmentService } from '../environment/environment.service';
import { parseRedisUrl } from '../../common/helpers';
import {
  isMetricsEnabled,
  observeJobDuration,
  setQueueDepth,
} from './metrics.registry';

const POLL_INTERVAL_MS = 15_000;
// Cap the in-flight start-time map so a job that never emits completed/failed
// (worker crash) cannot leak memory unbounded. Well above realistic concurrency.
const MAX_INFLIGHT = 10_000;

/**
 * BullMQ instrumentation for #355:
 *  - `bullmq_queue_depth{queue}`: polled from getJobCounts() every 15s.
 *  - `bullmq_job_duration_seconds{queue}`: wall-clock time between a job going
 *    `active` and `completed`/`failed`, observed via per-queue QueueEvents.
 *
 * Queue names are a FINITE list (the QueueName enum), so labels are bounded — no
 * job ids ever enter a label. Everything is gated on METRICS_PORT: when metrics
 * are off, onModuleInit does nothing (no interval, no QueueEvents connections).
 */
@Injectable()
export class MetricsBullService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsBullService.name);
  private readonly queues: { label: string; queue: Queue }[];
  private timer: NodeJS.Timeout | null = null;
  private queueEvents: QueueEvents[] = [];
  // jobId -> start timestamp (ms). Bounded by MAX_INFLIGHT.
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly environmentService: EnvironmentService,
    @InjectQueue(QueueName.EMAIL_QUEUE) emailQueue: Queue,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) attachmentQueue: Queue,
    @InjectQueue(QueueName.GENERAL_QUEUE) generalQueue: Queue,
    @InjectQueue(QueueName.BILLING_QUEUE) billingQueue: Queue,
    @InjectQueue(QueueName.FILE_TASK_QUEUE) fileTaskQueue: Queue,
    @InjectQueue(QueueName.AI_QUEUE) aiQueue: Queue,
    @InjectQueue(QueueName.HISTORY_QUEUE) historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) notificationQueue: Queue,
    @InjectQueue(QueueName.AUDIT_QUEUE) auditQueue: Queue,
  ) {
    this.queues = [
      { label: 'email', queue: emailQueue },
      { label: 'attachment', queue: attachmentQueue },
      { label: 'general', queue: generalQueue },
      { label: 'billing', queue: billingQueue },
      { label: 'file-task', queue: fileTaskQueue },
      { label: 'ai', queue: aiQueue },
      { label: 'history', queue: historyQueue },
      { label: 'notification', queue: notificationQueue },
      { label: 'audit', queue: auditQueue },
    ];
  }

  onModuleInit(): void {
    if (!isMetricsEnabled()) return;

    // Poll queue depth.
    this.timer = setInterval(() => {
      void this.pollDepths();
    }, POLL_INTERVAL_MS);
    // Do not keep the event loop alive solely for polling.
    this.timer.unref?.();
    void this.pollDepths();

    // Wire per-queue job-duration events.
    const redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());
    const connection = {
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.password,
      db: redisConfig.db,
      family: redisConfig.family,
    };

    for (const { label, queue } of this.queues) {
      const events = new QueueEvents(queue.name, { connection });
      events.on('active', ({ jobId }) => {
        if (this.inflight.size >= MAX_INFLIGHT) {
          // Drop the oldest tracked start to keep the map bounded.
          const oldest = this.inflight.keys().next().value;
          if (oldest !== undefined) this.inflight.delete(oldest);
        }
        this.inflight.set(jobId, Date.now());
      });
      const finalize = ({ jobId }: { jobId: string }) => {
        const start = this.inflight.get(jobId);
        if (start === undefined) return;
        this.inflight.delete(jobId);
        observeJobDuration(label, (Date.now() - start) / 1000);
      };
      events.on('completed', finalize);
      events.on('failed', finalize);
      events.on('error', (err) => {
        this.logger.debug(`QueueEvents error (${label}): ${err?.message}`);
      });
      this.queueEvents.push(events);
    }
  }

  private async pollDepths(): Promise<void> {
    for (const { label, queue } of this.queues) {
      try {
        const counts = await queue.getJobCounts();
        // "Depth" = jobs not yet finished (backlog + in-flight).
        const depth =
          (counts.waiting ?? 0) +
          (counts.active ?? 0) +
          (counts.delayed ?? 0) +
          (counts.prioritized ?? 0) +
          (counts.paused ?? 0);
        setQueueDepth(label, depth);
      } catch (err) {
        this.logger.debug(
          `Failed to read job counts for ${label}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all(
      this.queueEvents.map((e) => e.close().catch(() => undefined)),
    );
    this.queueEvents = [];
    this.inflight.clear();
  }
}
