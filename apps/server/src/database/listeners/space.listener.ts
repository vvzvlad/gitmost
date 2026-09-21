import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';

export class SpaceEvent {
  spaceId: string;
}

@Injectable()
export class SpaceListener {
  private readonly logger = new Logger(SpaceListener.name);

  constructor(
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
  ) {}

  @OnEvent(EventName.SPACE_DELETED)
  async handleSpaceDeleted(event: SpaceEvent) {
    const { spaceId } = event;
    await this.aiQueue.add(QueueJob.SPACE_DELETED, { spaceId });
  }
}
