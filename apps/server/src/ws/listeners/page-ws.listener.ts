import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import {
  PageEvent,
  PageMovedEvent,
} from '../../database/listeners/page.listener';
import { WsTreeService } from '../ws-tree.service';

/**
 * Server-authoritative realtime tree updates.
 *
 * Listens to page lifecycle domain events and broadcasts the corresponding
 * tree mutation to everyone in the space room. Because the events carry thin
 * node snapshots (variant A), this listener performs NO DB reads — that is what
 * keeps it safe against the in-transaction visibility race (a synchronous
 * SELECT here could run before the emitting `trx` committed).
 *
 * Scope of this PR: create, move, soft-delete/delete, restore.
 *
 * Deferred follow-ups (intentionally NOT handled here):
 *  - rename / icon change: would broadcast `updateOne` on PAGE_UPDATED, but
 *    PAGE_UPDATED also fires on every content save, so it needs a title/icon
 *    diff filter to avoid noise.
 *  - cross-space move (`movePageToSpace` / PAGE_MOVED_TO_SPACE): needs a
 *    deleteTreeNode in the old space + addTreeNode/refetch in the new space.
 */
@Injectable()
export class PageWsListener {
  private readonly logger = new Logger(PageWsListener.name);

  constructor(private readonly wsTree: WsTreeService) {}

  @OnEvent(EventName.PAGE_CREATED)
  async onPageCreated(event: PageEvent): Promise<void> {
    // Two creation shapes:
    //  - Single-page create carries precise node snapshots (`pages`), so we
    //    broadcast a pointwise addTreeNode per node.
    //  - Bulk create (copy/duplicate, import) produces whole subtrees and omits
    //    `pages`; per-node placement would be fragile, so we fall back to a root
    //    refetch (carries no page data, clients re-fetch via the permission-
    //    checked API). Same mechanism PAGE_RESTORED uses.
    if (event.pages?.length) {
      for (const page of event.pages) {
        await this.wsTree.broadcastPageCreated(page);
      }
      return;
    }

    if (event.spaceId) {
      await this.wsTree.broadcastRefetchRoot(event.spaceId);
    }
  }

  // Both soft-delete and hard-delete remove the node from the tree. The event
  // carries only the ROOT snapshot of the deleted subtree — the client
  // `treeModel.remove` drops all descendants, so one deleteTreeNode is enough.
  @OnEvent(EventName.PAGE_SOFT_DELETED)
  @OnEvent(EventName.PAGE_DELETED)
  async onPageDeleted(event: PageEvent): Promise<void> {
    for (const page of event.pages ?? []) {
      await this.wsTree.broadcastPageDeleted(page);
    }
  }

  @OnEvent(EventName.PAGE_MOVED)
  async onPageMoved(event: PageMovedEvent): Promise<void> {
    await this.wsTree.broadcastPageMoved(event);
  }

  @OnEvent(EventName.PAGE_RESTORED)
  async onPageRestored(event: PageEvent): Promise<void> {
    // Restore can re-attach a whole subtree; a root refetch is simpler and more
    // robust than N pointwise addTreeNode events.
    if (!event.spaceId) {
      this.logger.warn('PAGE_RESTORED event without spaceId; skipping refetch');
      return;
    }
    await this.wsTree.broadcastRefetchRoot(event.spaceId);
  }
}
