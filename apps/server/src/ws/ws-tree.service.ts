import { Injectable } from '@nestjs/common';
import { Page } from '@docmost/db/types/entity.types';
import { WsService } from './ws.service';
import {
  PageMovedEvent,
  TreeNodeSnapshot,
} from '../database/listeners/page.listener';

@Injectable()
export class WsTreeService {
  constructor(private readonly wsService: WsService) {}

  // Server-origin tree broadcasts. Built from thin node snapshots carried in the
  // domain events (variant A) so no DB read happens here — this avoids the
  // in-transaction visibility race. Payload shapes mirror what the client
  // receiver (`use-tree-socket.ts`) consumes.

  async broadcastPageCreated(page: TreeNodeSnapshot): Promise<void> {
    await this.wsService.emitTreeEvent(page.spaceId, page.id, {
      operation: 'addTreeNode',
      spaceId: page.spaceId,
      payload: {
        parentId: page.parentPageId ?? null,
        // Receivers place by `position` among already-loaded siblings, not by
        // this absolute index (sender's loaded set differs from receivers').
        index: 0,
        data: {
          id: page.id,
          slugId: page.slugId,
          name: page.title ?? '',
          title: page.title,
          icon: page.icon,
          position: page.position,
          spaceId: page.spaceId,
          parentPageId: page.parentPageId,
          hasChildren: false,
          children: [],
        },
      },
    });
  }

  async broadcastPageDeleted(page: TreeNodeSnapshot): Promise<void> {
    await this.wsService.emitTreeEvent(page.spaceId, page.id, {
      operation: 'deleteTreeNode',
      spaceId: page.spaceId,
      payload: {
        node: {
          id: page.id,
          slugId: page.slugId,
          parentPageId: page.parentPageId ?? null,
        },
      },
    });
  }

  async broadcastPageMoved(event: PageMovedEvent): Promise<void> {
    const { node } = event;
    await this.wsService.emitTreeEvent(node.spaceId, node.id, {
      operation: 'moveTreeNode',
      spaceId: node.spaceId,
      payload: {
        id: node.id,
        parentId: node.parentPageId ?? null,
        oldParentId: event.oldParentId ?? null,
        // See broadcastPageCreated: receivers place by `position`, not index.
        index: 0,
        position: node.position,
        pageData: {
          id: node.id,
          slugId: node.slugId,
          title: node.title,
          icon: node.icon,
          position: node.position,
          spaceId: node.spaceId,
          parentPageId: node.parentPageId ?? null,
          hasChildren: event.hasChildren,
        },
      },
    });
  }

  // Used for restore (and other subtree re-attachments): rather than emitting N
  // pointwise addTreeNode events, ask clients in the space to refetch the root
  // tree. The client already understands `refetchRootTreeNodeEvent`.
  async broadcastRefetchRoot(spaceId: string): Promise<void> {
    this.wsService.emitToSpaceRoom(spaceId, {
      operation: 'refetchRootTreeNodeEvent',
      spaceId,
    });
  }

  async notifyPageRestricted(page: Page, excludeUserId: string): Promise<void> {
    await this.wsService.emitToSpaceExceptUsers(page.spaceId, [excludeUserId], {
      operation: 'deleteTreeNode',
      spaceId: page.spaceId,
      payload: {
        node: {
          id: page.id,
          slugId: page.slugId,
        },
      },
    });
  }

  async notifyPermissionGranted(page: Page, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;

    await this.wsService.emitToUsers(userIds, {
      operation: 'addTreeNode',
      spaceId: page.spaceId,
      payload: {
        parentId: page.parentPageId ?? null,
        index: 0,
        data: {
          id: page.id,
          slugId: page.slugId,
          name: page.title ?? '',
          title: page.title,
          icon: page.icon,
          position: page.position,
          spaceId: page.spaceId,
          parentPageId: page.parentPageId,
          creatorId: page.creatorId,
          hasChildren: false,
          children: [],
        },
      },
    });
  }
}
