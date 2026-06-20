import { Injectable } from '@nestjs/common';
import { Page } from '@docmost/db/types/entity.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { WsService } from './ws.service';
import {
  PageMovedEvent,
  TreeNodeSnapshot,
} from '../database/listeners/page.listener';

@Injectable()
export class WsTreeService {
  constructor(
    private readonly wsService: WsService,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

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

    const movePayload = {
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
    };

    // Decide the node's restricted state ONCE, fresh (uncached), and drive BOTH
    // the move broadcast and the compensating delete from this single decision.
    //
    // Why not just emitTreeEvent for the move? emitTreeEvent gates the move on
    // the CACHED spaceHasRestrictions (30s TTL, never invalidated). In the window
    // right after a space gets its FIRST restriction, that cache still says
    // "no restrictions" → emitTreeEvent would fan the move out to the WHOLE room
    // (including unauthorized users) while the delete below (computed from the
    // UNCACHED hasRestrictedAncestor) also fires. An unauthorized user then gets
    // BOTH, and if the delete lands first it is a no-op and the later move
    // renders the restricted node → leak. So when the node is known-restricted we
    // must NOT route the move through the cache-gated path.
    const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
      node.id,
    );

    if (!isRestricted) {
      // Normal case: not under a restricted ancestor. One moveTreeNode to the
      // whole space room (emitTreeEvent's open-space fast path), no delete.
      await this.wsService.emitTreeEvent(node.spaceId, node.id, movePayload);
      return;
    }

    // Restricted case: a move can push a previously-visible page UNDER a
    // restricted ancestor. Route the move to authorized users ONLY (same fresh
    // getUserIdsWithPageAccess set the delete uses) and send the compensating
    // delete to everyone else. Both sets come from one fresh decision, so they
    // are guaranteed disjoint: authorized users get exactly the moveTreeNode,
    // unauthorized users get exactly the deleteTreeNode, nobody gets both.
    //
    // Users who LOSE visibility need the delete because otherwise the node would
    // linger in their tree at its old parent with its real title/slugId/icon
    // (existence + metadata leak).
    await this.wsService.emitToAuthorizedUsers(
      node.spaceId,
      node.id,
      movePayload,
    );

    await this.wsService.emitDeleteToUnauthorized(node.spaceId, node.id, {
      operation: 'deleteTreeNode',
      spaceId: node.spaceId,
      payload: {
        node: {
          id: node.id,
          slugId: node.slugId,
          parentPageId: event.oldParentId ?? null,
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
