import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';

export class WorkspaceEvent {
  workspaceId: string;
}

@Injectable()
export class WorkspaceListener {
  private readonly logger = new Logger(WorkspaceListener.name);

  constructor(
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
  ) {}

  @OnEvent(EventName.WORKSPACE_DELETED)
  async handlePageDeleted(event: WorkspaceEvent) {
    const { workspaceId } = event;
    await this.aiQueue.add(QueueJob.WORKSPACE_DELETED, { workspaceId });
  }
}
