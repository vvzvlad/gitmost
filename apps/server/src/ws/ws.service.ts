import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Server } from 'socket.io';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import {
  WS_SPACE_RESTRICTION_CACHE_PREFIX,
  WS_CACHE_TTL_MS,
  getSpaceRoomName,
} from './ws.utils';

@Injectable()
export class WsService {
  private server: Server;

  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  setServer(server: Server): void {
    this.server = server;
  }

  // Drop the cached spaceHasRestrictions verdict for a space. spaceHasRestrictions
  // caches "does this space have ANY restricted page" for WS_CACHE_TTL_MS, and
  // emitTreeEvent / emitCommentEvent take a room-wide fast path when it is false.
  // The FIRST time a space gains a restriction (or loses its last one) this cached
  // verdict goes stale for up to the TTL, during which a title/icon-bearing tree
  // payload could fan out to the whole room. This MUST be called by whatever code
  // creates or removes a page's restriction (the page-access / page-permission
  // grant/revoke/restrict path), passing the affected page's spaceId, so the next
  // emit re-reads hasRestrictedPagesInSpace immediately instead of serving a
  // stale cached value.
  //
  // NOTE: on this branch there is no permission-mutation site to call this from —
  // the page-access/page-permission repo mutators (insertPageAccess /
  // insertPagePermissions / deletePagePermission* / updatePagePermissionRole)
  // have ZERO callers in apps/server/src; PageAccessService only validates access.
  // Because there is nothing to wire the invalidation to yet, the documented
  // fallback was applied instead: WS_CACHE_TTL_MS was dropped from 30s to 3s (see
  // ws.utils.ts) to bound the worst-case stale-leak window. This primitive is kept
  // (and tested) so the restriction-mutation flow, when it lands, has the correct
  // hook to invalidate the cache.
  //
  // TODO: the future restriction-mutation endpoint (restrict/grant/revoke page
  // access) MUST call this with the affected page's spaceId; once wired, the TTL
  // can be raised back to a higher value if desired.
  async invalidateSpaceRestrictionCache(spaceId: string): Promise<void> {
    await this.cacheManager.del(
      `${WS_SPACE_RESTRICTION_CACHE_PREFIX}${spaceId}`,
    );
  }

  // Comment broadcast. Thin wrapper over the single restriction-aware emit so
  // comment and tree events share ONE restriction gate (see
  // emitRestrictedAwareToSpace).
  async emitCommentEvent(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    await this.emitRestrictedAwareToSpace(spaceId, pageId, data);
  }

  // Server-origin tree broadcast. Thin wrapper over the single restriction-aware
  // emit (see emitRestrictedAwareToSpace), identical routing to emitCommentEvent.
  //
  // The author is NOT excluded. The client receiver is idempotent (addTreeNode
  // early-returns if the node id already exists; deleteTreeNode is a no-op if
  // the node is gone), so the UI author's optimistic node is preserved, and
  // non-UI creators (MCP / AI / REST API) still see their own page appear.
  async emitTreeEvent(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    await this.emitRestrictedAwareToSpace(spaceId, pageId, data);
  }

  // The single restriction-aware space emit. This is the ONLY place that decides
  // authorized-vs-unauthorized routing for server-origin space-room events
  // (comment + tree). Both emitCommentEvent and emitTreeEvent forward to it with
  // their own `data`; the payload/room/event are otherwise identical.
  //
  // Routing: if the space has no restrictions at all (cached fast path), or the
  // page has no restricted ancestor, fan `data` out to the whole space room;
  // otherwise restrict the broadcast to the users authorized to see `pageId`.
  private async emitRestrictedAwareToSpace(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);

    const hasRestrictions = await this.spaceHasRestrictions(spaceId);
    if (!hasRestrictions) {
      this.server.to(room).emit('message', data);
      return;
    }

    const isRestricted =
      await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
    if (!isRestricted) {
      this.server.to(room).emit('message', data);
      return;
    }

    await this.broadcastToAuthorizedUsers(room, null, pageId, data);
  }

  // Unconditional broadcast to everyone in the space room. Used for space-wide
  // signals that carry no page payload (e.g. refetchRootTreeNodeEvent on
  // restore): there is no per-page data to leak, and each client refetches the
  // root tree through its own authorized query (refetchRootTreeNodeEvent carries
  // no per-page data, so no restriction check is needed).
  emitToSpaceRoom(spaceId: string, data: any): void {
    this.server.to(getSpaceRoomName(spaceId)).emit('message', data);
  }

  // Broadcast `data` (a deleteTreeNode) to every socket in the space room whose
  // user is NOT authorized to see `pageId`. Used to compensate a move that pushes
  // a previously-visible page UNDER a restricted ancestor: authorized users get
  // the moveTreeNode (via emitTreeEvent), everyone else gets a deleteTreeNode so
  // the now-restricted node disappears from their tree instead of lingering with
  // its real title/slugId/icon. The two event sets are disjoint by construction
  // (a user is either authorized or not), so no socket receives both.
  async emitDeleteToUnauthorized(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);
    const sockets = await this.server.in(room).fetchSockets();
    if (sockets.length === 0) return;

    const userIds = Array.from(
      new Set(
        sockets
          .map((s) => s.data.userId as string)
          .filter((id): id is string => !!id),
      ),
    );
    if (userIds.length === 0) return;

    const authorizedUserIds =
      await this.pagePermissionRepo.getUserIdsWithPageAccess(pageId, userIds);
    const authorizedSet = new Set(authorizedUserIds);

    for (const socket of sockets) {
      const userId = socket.data.userId as string;
      // Unauthenticated sockets (no userId) cannot see restricted content; send
      // them the delete too so a leaked node can't linger.
      if (!userId || !authorizedSet.has(userId)) {
        socket.emit('message', data);
      }
    }
  }

  // Server-origin broadcast of `data` to exactly the users in the space room who
  // ARE authorized to see `pageId`. This is the counterpart of
  // emitDeleteToUnauthorized: both resolve the authorized set from the SAME
  // fetchSockets + getUserIdsWithPageAccess call shape, so a caller that drives
  // both from one decision gets two disjoint sets (authorized vs. not) with no
  // socket in both. Unlike emitTreeEvent, this does NOT consult the cached
  // spaceHasRestrictions: the caller already knows the page is restricted, so we
  // must not risk a stale cache fanning the move out to the whole room.
  async emitToAuthorizedUsers(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);
    await this.broadcastToAuthorizedUsers(room, null, pageId, data);
  }

  private async broadcastToAuthorizedUsers(
    room: string,
    excludeSocketId: string | null,
    pageId: string,
    data: any,
  ): Promise<void> {
    const sockets = await this.server.in(room).fetchSockets();

    // Exclude only the originating socket, not every socket of the originating
    // user. Excluding by userId silently dropped the originator's other tabs
    // from receiving restricted-space tree events.
    const otherSockets = excludeSocketId
      ? sockets.filter((s) => s.id !== excludeSocketId)
      : sockets;
    if (otherSockets.length === 0) return;

    const userSocketMap = new Map<string, typeof otherSockets>();
    for (const socket of otherSockets) {
      const userId = socket.data.userId as string;
      if (!userId) continue;
      const existing = userSocketMap.get(userId);
      if (existing) {
        existing.push(socket);
      } else {
        userSocketMap.set(userId, [socket]);
      }
    }

    const candidateUserIds = Array.from(userSocketMap.keys());
    if (candidateUserIds.length === 0) return;

    const authorizedUserIds =
      await this.pagePermissionRepo.getUserIdsWithPageAccess(
        pageId,
        candidateUserIds,
      );

    const authorizedSet = new Set(authorizedUserIds);
    for (const [userId, userSockets] of userSocketMap) {
      if (authorizedSet.has(userId)) {
        for (const socket of userSockets) {
          socket.emit('message', data);
        }
      }
    }
  }

  private async spaceHasRestrictions(spaceId: string): Promise<boolean> {
    const cacheKey = `${WS_SPACE_RESTRICTION_CACHE_PREFIX}${spaceId}`;

    const cached = await this.cacheManager.get<boolean>(cacheKey);
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    const hasRestrictions =
      await this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);

    await this.cacheManager.set(cacheKey, hasRestrictions, WS_CACHE_TTL_MS);

    return hasRestrictions;
  }
}
