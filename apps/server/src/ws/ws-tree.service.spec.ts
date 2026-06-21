import { Test, TestingModule } from '@nestjs/testing';
import { WsTreeService } from './ws-tree.service';
import { WsService } from './ws.service';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  PageMovedEvent,
  TreeNodeSnapshot,
} from '../database/listeners/page.listener';
import {
  getSpaceRoomName,
  WS_SPACE_RESTRICTION_CACHE_PREFIX,
} from './ws.utils';

const snapshot: TreeNodeSnapshot = {
  id: 'page-1',
  slugId: 'slug-1',
  title: 'Hello',
  icon: '📄',
  position: 'a1',
  spaceId: 'space-1',
  parentPageId: null,
};

describe('WsTreeService', () => {
  let service: WsTreeService;
  let wsService: {
    emitTreeEvent: jest.Mock;
    emitToSpaceRoom: jest.Mock;
    emitDeleteToUnauthorized: jest.Mock;
    emitToAuthorizedUsers: jest.Mock;
  };
  let pagePermissionRepo: { hasRestrictedAncestor: jest.Mock };

  beforeEach(async () => {
    wsService = {
      emitTreeEvent: jest.fn().mockResolvedValue(undefined),
      emitToSpaceRoom: jest.fn(),
      emitDeleteToUnauthorized: jest.fn().mockResolvedValue(undefined),
      emitToAuthorizedUsers: jest.fn().mockResolvedValue(undefined),
    };
    pagePermissionRepo = {
      // Default: not restricted, so broadcastPageMoved skips the compensating
      // delete unless a test opts in.
      hasRestrictedAncestor: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsTreeService,
        { provide: WsService, useValue: wsService },
        { provide: PagePermissionRepo, useValue: pagePermissionRepo },
      ],
    }).compile();

    service = module.get<WsTreeService>(WsTreeService);
  });

  it('broadcastPageCreated emits addTreeNode with the expected shape', async () => {
    await service.broadcastPageCreated(snapshot);

    expect(wsService.emitTreeEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({
        operation: 'addTreeNode',
        spaceId: 'space-1',
        payload: expect.objectContaining({
          parentId: null,
          index: 0,
          data: expect.objectContaining({
            id: 'page-1',
            slugId: 'slug-1',
            name: 'Hello',
            title: 'Hello',
            icon: '📄',
            position: 'a1',
            spaceId: 'space-1',
            parentPageId: null,
            hasChildren: false,
            children: [],
          }),
        }),
      }),
    );
  });

  it('broadcastPageDeleted emits deleteTreeNode with the root node only', async () => {
    await service.broadcastPageDeleted({
      ...snapshot,
      parentPageId: 'parent-9',
    });

    expect(wsService.emitTreeEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({
        operation: 'deleteTreeNode',
        spaceId: 'space-1',
        payload: {
          node: { id: 'page-1', slugId: 'slug-1', parentPageId: 'parent-9' },
        },
      }),
    );
  });

  it('broadcastPageMoved emits moveTreeNode with old + new parent and position', async () => {
    const event: PageMovedEvent = {
      workspaceId: 'ws-1',
      oldParentId: 'old-parent',
      hasChildren: true,
      node: { ...snapshot, parentPageId: 'new-parent', position: 'a5' },
    };

    await service.broadcastPageMoved(event);

    expect(wsService.emitTreeEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({
        operation: 'moveTreeNode',
        spaceId: 'space-1',
        payload: expect.objectContaining({
          id: 'page-1',
          parentId: 'new-parent',
          oldParentId: 'old-parent',
          index: 0,
          position: 'a5',
          pageData: expect.objectContaining({
            id: 'page-1',
            slugId: 'slug-1',
            position: 'a5',
            parentPageId: 'new-parent',
            hasChildren: true,
          }),
        }),
      }),
    );
  });

  it('broadcastPageMoved into an UNrestricted location does NOT emit a compensating delete', async () => {
    pagePermissionRepo.hasRestrictedAncestor.mockResolvedValue(false);

    const event: PageMovedEvent = {
      workspaceId: 'ws-1',
      oldParentId: 'old-parent',
      hasChildren: false,
      node: { ...snapshot, parentPageId: 'new-parent', position: 'a5' },
    };

    await service.broadcastPageMoved(event);

    // Normal path: move goes to the whole room via emitTreeEvent, and neither
    // the authorized-only move path nor the compensating delete fire.
    expect(wsService.emitTreeEvent).toHaveBeenCalledTimes(1);
    expect(wsService.emitToAuthorizedUsers).not.toHaveBeenCalled();
    expect(wsService.emitDeleteToUnauthorized).not.toHaveBeenCalled();
  });

  it('broadcastPageMoved into a RESTRICTED subtree routes the move to authorized users only AND emits a compensating delete to unauthorized — from one fresh decision', async () => {
    // Destination is now under a restricted ancestor.
    pagePermissionRepo.hasRestrictedAncestor.mockResolvedValue(true);

    const event: PageMovedEvent = {
      workspaceId: 'ws-1',
      oldParentId: 'old-parent',
      hasChildren: false,
      node: { ...snapshot, parentPageId: 'restricted-parent', position: 'a5' },
    };

    await service.broadcastPageMoved(event);

    // The single fresh restriction decision was read exactly once...
    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledTimes(1);
    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith(
      'page-1',
    );

    // ...and it must NOT go through the cache-gated room-wide emitTreeEvent,
    // which could leak the move to the whole room during the stale-cache window.
    expect(wsService.emitTreeEvent).not.toHaveBeenCalled();

    // The move is delivered to authorized users only.
    expect(wsService.emitToAuthorizedUsers).toHaveBeenCalledTimes(1);
    expect(wsService.emitToAuthorizedUsers).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({
        operation: 'moveTreeNode',
        spaceId: 'space-1',
        payload: expect.objectContaining({ id: 'page-1' }),
      }),
    );

    // The users who lost access get a deleteTreeNode for the moved node, scoped
    // to the same page id (same fresh authorized set → disjoint from the move).
    expect(wsService.emitDeleteToUnauthorized).toHaveBeenCalledTimes(1);
    expect(wsService.emitDeleteToUnauthorized).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({
        operation: 'deleteTreeNode',
        spaceId: 'space-1',
        payload: {
          node: expect.objectContaining({ id: 'page-1', slugId: 'slug-1' }),
        },
      }),
    );
  });

  it('broadcastRefetchRoot emits refetchRootTreeNodeEvent to the space room', async () => {
    await service.broadcastRefetchRoot('space-7');

    expect(wsService.emitToSpaceRoom).toHaveBeenCalledWith('space-7', {
      operation: 'refetchRootTreeNodeEvent',
      spaceId: 'space-7',
    });
  });
});

describe('WsService.emitTreeEvent', () => {
  let service: WsService;
  let pagePermissionRepo: {
    hasRestrictedPagesInSpace: jest.Mock;
    hasRestrictedAncestor: jest.Mock;
    getUserIdsWithPageAccess: jest.Mock;
  };
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let roomEmit: jest.Mock;
  let server: any;

  beforeEach(async () => {
    pagePermissionRepo = {
      hasRestrictedPagesInSpace: jest.fn(),
      hasRestrictedAncestor: jest.fn(),
      getUserIdsWithPageAccess: jest.fn(),
    };
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsService,
        { provide: PagePermissionRepo, useValue: pagePermissionRepo },
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    service = module.get<WsService>(WsService);

    roomEmit = jest.fn();
    server = {
      to: jest.fn().mockReturnValue({ emit: roomEmit }),
      in: jest.fn().mockReturnValue({ fetchSockets: jest.fn() }),
    };
    service.setServer(server);
  });

  it('open space: broadcasts to the whole space room', async () => {
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(false);

    const data = { operation: 'addTreeNode' };
    await service.emitTreeEvent('space-1', 'page-1', data);

    expect(server.to).toHaveBeenCalledWith(getSpaceRoomName('space-1'));
    expect(roomEmit).toHaveBeenCalledWith('message', data);
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
  });

  it('restricted page: only authorized users receive the event', async () => {
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(true);
    pagePermissionRepo.hasRestrictedAncestor.mockResolvedValue(true);
    pagePermissionRepo.getUserIdsWithPageAccess.mockResolvedValue(['user-ok']);

    const okEmit = jest.fn();
    const noEmit = jest.fn();
    const sockets = [
      { id: 's1', data: { userId: 'user-ok' }, emit: okEmit },
      { id: 's2', data: { userId: 'user-no' }, emit: noEmit },
    ];
    server.in.mockReturnValue({
      fetchSockets: jest.fn().mockResolvedValue(sockets),
    });

    const data = { operation: 'addTreeNode' };
    await service.emitTreeEvent('space-1', 'page-1', data);

    // Did NOT broadcast to the whole room.
    expect(roomEmit).not.toHaveBeenCalled();
    expect(okEmit).toHaveBeenCalledWith('message', data);
    expect(noEmit).not.toHaveBeenCalled();
  });

  it('emitCommentEvent open space: broadcasts to the whole space room', async () => {
    // emitCommentEvent forwards to the SAME unified restriction gate as
    // emitTreeEvent, so the open-space fast path must behave identically.
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(false);

    const data = { operation: 'addComment' };
    await service.emitCommentEvent('space-1', 'page-1', data);

    expect(server.to).toHaveBeenCalledWith(getSpaceRoomName('space-1'));
    expect(roomEmit).toHaveBeenCalledWith('message', data);
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
  });

  it('emitCommentEvent restricted page: only authorized users receive the event', async () => {
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(true);
    pagePermissionRepo.hasRestrictedAncestor.mockResolvedValue(true);
    pagePermissionRepo.getUserIdsWithPageAccess.mockResolvedValue(['user-ok']);

    const okEmit = jest.fn();
    const noEmit = jest.fn();
    const sockets = [
      { id: 's1', data: { userId: 'user-ok' }, emit: okEmit },
      { id: 's2', data: { userId: 'user-no' }, emit: noEmit },
    ];
    server.in.mockReturnValue({
      fetchSockets: jest.fn().mockResolvedValue(sockets),
    });

    const data = { operation: 'addComment' };
    await service.emitCommentEvent('space-1', 'page-1', data);

    expect(roomEmit).not.toHaveBeenCalled();
    expect(okEmit).toHaveBeenCalledWith('message', data);
    expect(noEmit).not.toHaveBeenCalled();
  });

  it('invalidateSpaceRestrictionCache deletes the cached restriction verdict for that space only', async () => {
    await service.invalidateSpaceRestrictionCache('space-42');

    expect(cache.del).toHaveBeenCalledTimes(1);
    expect(cache.del).toHaveBeenCalledWith(
      `${WS_SPACE_RESTRICTION_CACHE_PREFIX}space-42`,
    );
  });

  it('emitDeleteToUnauthorized sends ONLY to sockets whose user lacks page access', async () => {
    pagePermissionRepo.getUserIdsWithPageAccess.mockResolvedValue(['user-ok']);

    const okEmit = jest.fn();
    const noEmit = jest.fn();
    const anonEmit = jest.fn();
    const sockets = [
      { id: 's1', data: { userId: 'user-ok' }, emit: okEmit },
      { id: 's2', data: { userId: 'user-no' }, emit: noEmit },
      // Unauthenticated socket (no userId) — must also receive the delete.
      { id: 's3', data: {}, emit: anonEmit },
    ];
    server.in.mockReturnValue({
      fetchSockets: jest.fn().mockResolvedValue(sockets),
    });

    const data = { operation: 'deleteTreeNode' };
    await service.emitDeleteToUnauthorized('space-1', 'page-1', data);

    // Authorized user does NOT get the delete (they got the move instead).
    expect(okEmit).not.toHaveBeenCalled();
    // Unauthorized + anonymous sockets DO get the delete.
    expect(noEmit).toHaveBeenCalledWith('message', data);
    expect(anonEmit).toHaveBeenCalledWith('message', data);
  });
});

describe('move-into-restricted disjointness contract (WsTreeService + real WsService)', () => {
  // CONTRACT: a move under a restricted ancestor PARTITIONS the room. The
  // authorized set (gets the moveTreeNode via emitToAuthorizedUsers) and its
  // complement (gets the deleteTreeNode via emitDeleteToUnauthorized) are
  // disjoint and together cover every socket — and an anonymous (no-userId)
  // socket lands in the delete set. We wire a REAL WsService (only its repo,
  // cache and socket server mocked) so both broadcasts run against the SAME fixed
  // socket set, the way they do in production.
  let treeService: WsTreeService;
  let pagePermissionRepo: {
    hasRestrictedPagesInSpace: jest.Mock;
    hasRestrictedAncestor: jest.Mock;
    getUserIdsWithPageAccess: jest.Mock;
  };

  // Fixed room: two authorized users (one with two sockets), one unauthorized
  // user, one anonymous socket.
  const moveSeen: string[] = [];
  const deleteSeen: string[] = [];

  const mkSocket = (id: string, userId: string | undefined) => ({
    id,
    data: userId ? { userId } : {},
    emit: jest.fn((_event: string, payload: { operation: string }) => {
      if (payload.operation === 'moveTreeNode') moveSeen.push(id);
      if (payload.operation === 'deleteTreeNode') deleteSeen.push(id);
    }),
  });

  const sockets = [
    mkSocket('s-ok-1', 'user-ok'), // authorized, tab 1
    mkSocket('s-ok-2', 'user-ok'), // authorized, tab 2 (fan-out)
    mkSocket('s-no', 'user-no'), // unauthorized
    mkSocket('s-anon', undefined), // anonymous (no userId)
  ];

  beforeEach(async () => {
    moveSeen.length = 0;
    deleteSeen.length = 0;

    pagePermissionRepo = {
      hasRestrictedPagesInSpace: jest.fn().mockResolvedValue(true),
      // The move destination IS under a restricted ancestor.
      hasRestrictedAncestor: jest.fn().mockResolvedValue(true),
      // Only user-ok is authorized to see the page.
      getUserIdsWithPageAccess: jest.fn().mockResolvedValue(['user-ok']),
    };
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsTreeService,
        WsService,
        { provide: PagePermissionRepo, useValue: pagePermissionRepo },
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    const wsService = module.get<WsService>(WsService);
    const server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      }),
    };
    wsService.setServer(server as never);

    treeService = module.get<WsTreeService>(WsTreeService);
  });

  it('authorized set (move) and complement (delete) partition the room; anon is in delete', async () => {
    const event: PageMovedEvent = {
      workspaceId: 'ws-1',
      oldParentId: 'old-parent',
      hasChildren: false,
      node: { ...snapshot, parentPageId: 'restricted-parent', position: 'a5' },
    };

    await treeService.broadcastPageMoved(event);

    const moveSet = new Set(moveSeen);
    const deleteSet = new Set(deleteSeen);

    // Authorized user's BOTH sockets got the move; nobody else did.
    expect(moveSet).toEqual(new Set(['s-ok-1', 's-ok-2']));
    // Everyone else (unauthorized + anonymous) got the delete.
    expect(deleteSet).toEqual(new Set(['s-no', 's-anon']));

    // DISJOINT: no socket received both a move and a delete.
    const intersection = [...moveSet].filter((id) => deleteSet.has(id));
    expect(intersection).toEqual([]);

    // PARTITION: the two sets together cover every socket in the room exactly.
    const union = new Set([...moveSet, ...deleteSet]);
    expect(union).toEqual(new Set(sockets.map((s) => s.id)));

    // The anonymous socket specifically lands in the DELETE set, never the move.
    expect(deleteSet.has('s-anon')).toBe(true);
    expect(moveSet.has('s-anon')).toBe(false);
  });
});
