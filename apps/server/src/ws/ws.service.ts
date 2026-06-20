import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Server, Socket } from 'socket.io';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import {
  TREE_EVENTS,
  WS_SPACE_RESTRICTION_CACHE_PREFIX,
  WS_CACHE_TTL_MS,
  getSpaceRoomName,
  getUserRoomName,
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

  async handleTreeEvent(client: Socket, data: any): Promise<void> {
    const room = getSpaceRoomName(data.spaceId);

    if (!client.rooms.has(room)) {
      return;
    }

    if (data.operation === 'refetchRootTreeNodeEvent') {
      client.broadcast.to(room).emit('message', data);
      return;
    }

    const hasRestrictions = await this.spaceHasRestrictions(data.spaceId);
    if (!hasRestrictions) {
      client.broadcast.to(room).emit('message', data);
      return;
    }

    const pageId = this.extractPageId(data);
    if (!pageId) {
      return;
    }

    const isRestricted =
      await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
    if (!isRestricted) {
      client.broadcast.to(room).emit('message', data);
      return;
    }

    await this.broadcastToAuthorizedUsers(room, client.id, pageId, data);
  }

  async invalidateSpaceRestrictionCache(spaceId: string): Promise<void> {
    await this.cacheManager.del(
      `${WS_SPACE_RESTRICTION_CACHE_PREFIX}${spaceId}`,
    );
  }

  async emitCommentEvent(
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

  // Server-origin tree broadcast. Mirrors emitCommentEvent exactly: respects
  // per-space page restrictions (spaceHasRestrictions -> hasRestrictedAncestor
  // -> broadcastToAuthorizedUsers), otherwise fans the event out to everyone in
  // the space room.
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
  // root tree through its own authorized query. Mirrors handleTreeEvent's
  // special-casing of refetchRootTreeNodeEvent (no restriction check).
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

  async emitToUsers(userIds: string[], data: any): Promise<void> {
    if (userIds.length === 0) return;
    const rooms = userIds.map((id) => getUserRoomName(id));
    this.server.to(rooms).emit('message', data);
  }

  async emitToSpaceExceptUsers(
    spaceId: string,
    excludeUserIds: string[],
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);
    const sockets = await this.server.in(room).fetchSockets();
    const excludeSet = new Set(excludeUserIds);

    for (const socket of sockets) {
      const userId = socket.data.userId as string;
      if (userId && !excludeSet.has(userId)) {
        socket.emit('message', data);
      }
    }
  }

  isTreeEvent(data: any): boolean {
    return TREE_EVENTS.has(data?.operation) && !!data?.spaceId;
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

  private extractPageId(data: any): string | null {
    switch (data.operation) {
      case 'addTreeNode':
        return data.payload?.data?.id ?? null;
      case 'moveTreeNode':
        return data.payload?.id ?? null;
      case 'deleteTreeNode':
        return data.payload?.node?.id ?? null;
      case 'updateOne':
        return data.id ?? null;
      default:
        return null;
    }
  }
}
