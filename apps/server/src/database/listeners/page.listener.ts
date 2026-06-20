import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/**
 * Thin snapshot of a page node carried inside domain events so the WebSocket
 * tree listener can broadcast a tree update WITHOUT reading the DB. This is
 * "variant A" of the realtime-tree design: enriching the event avoids the
 * in-transaction visibility race where a separate SELECT in the listener could
 * run before the emitting `trx` has committed and therefore not see the row.
 */
export interface TreeNodeSnapshot {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  position: string;
  spaceId: string;
  parentPageId: string | null;
}

export class PageEvent {
  pageIds: string[];
  workspaceId: string;
  // Optional tree snapshots so the WS listener can broadcast without a DB read
  // (avoids the in-transaction visibility race on PAGE_CREATED /
  // PAGE_SOFT_DELETED / PAGE_DELETED). The existing search/AI listeners ignore
  // this field — they only enqueue work keyed by pageIds.
  pages?: TreeNodeSnapshot[];
  // Set on PAGE_RESTORED so the WS listener can scope a refetchRootTreeNodeEvent
  // to the affected space (restore can re-attach a whole subtree).
  spaceId?: string;
}

/**
 * Emitted by `PageService.movePage` after a successful re-parent / reorder.
 * Carries both the old and new parent plus the new position so the WS listener
 * can build a `moveTreeNode` broadcast without a DB read.
 */
export class PageMovedEvent {
  workspaceId: string;
  oldParentId: string | null;
  node: TreeNodeSnapshot;
  hasChildren: boolean;
}

@Injectable()
export class PageListener {
  private readonly logger = new Logger(PageListener.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    @InjectQueue(QueueName.SEARCH_QUEUE) private searchQueue: Queue,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
  ) {}

  @OnEvent(EventName.PAGE_CREATED)
  async handlePageCreated(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_CREATED, {
        pageIds,
      });
    }

    await this.aiQueue.add(QueueJob.PAGE_CREATED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_UPDATED)
  async handlePageUpdated(event: PageEvent) {
    const { pageIds } = event;

    await this.searchQueue.add(QueueJob.PAGE_UPDATED, { pageIds });
  }

  @OnEvent(EventName.PAGE_DELETED)
  async handlePageDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_DELETED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_DELETED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  async handlePageSoftDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_SOFT_DELETED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_SOFT_DELETED, {
      pageIds,
      workspaceId,
    });
  }

  @OnEvent(EventName.PAGE_RESTORED)
  async handlePageRestored(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_RESTORED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_RESTORED, { pageIds, workspaceId });
  }

  isTypesense(): boolean {
    return this.environmentService.getSearchDriver() === 'typesense';
  }
}
