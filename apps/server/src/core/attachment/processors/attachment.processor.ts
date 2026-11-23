import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AttachmentService } from '../services/attachment.service';
import { QueueJob, QueueName } from 'src/integrations/queue/constants';

@Processor(QueueName.ATTACHMENT_QUEUE)
export class AttachmentProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AttachmentProcessor.name);
  constructor(private readonly attachmentService: AttachmentService) {
    super();
  }

  async process(job: Job<any, void>): Promise<void> {
    try {
      if (job.name === QueueJob.DELETE_SPACE_ATTACHMENTS) {
        await this.attachmentService.handleDeleteSpaceAttachments(job.data.id);
      }
      if (job.name === QueueJob.DELETE_USER_AVATARS) {
        await this.attachmentService.handleDeleteUserAvatars(job.data.id);
      }
      if (job.name === QueueJob.DELETE_PAGE_ATTACHMENTS) {
        await this.attachmentService.handleDeletePageAttachments(
          job.data.pageId,
        );
      }
      if (job.name === QueueJob.DELETE_AI_CHAT_ATTACHMENTS) {
        await this.attachmentService.handleDeleteAiChatAttachments(
          job.data.aiChatId,
        );
      }
      if (job.name === QueueJob.ATTACHMENT_INDEX_CONTENT) {
        await this.attachmentService.indexDocument(job.data.attachmentId);
      } else if (job.name === QueueJob.ATTACHMENT_INDEXING) {
        await this.attachmentService.enqueueUnindexedDocuments(
          job.data.workspaceId,
          job.data.afterId,
        );
      }
    } catch (err) {
      throw err;
    }
  }

  async onApplicationBootstrap() {
    try {
      await this.attachmentService.scheduleDocumentBackfill();
    } catch (error) {
      this.logger.error('Could not queue attachment search backfill', error);
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} job`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    if (job.name === QueueJob.ATTACHMENT_INDEX_CONTENT) {
      this.logger.debug(
        `Error processing ${job.name} job for attachment ${job.data?.attachmentId}. Reason: ${job.failedReason}`,
      );
    } else {
      this.logger.error(
        `Error processing ${job.name} job. Reason: ${job.failedReason}`,
      );
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Completed ${job.name} job`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
