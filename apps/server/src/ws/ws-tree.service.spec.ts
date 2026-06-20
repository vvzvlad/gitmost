import { Test, TestingModule } from '@nestjs/testing';
import { WsTreeService } from './ws-tree.service';
import { WsService } from './ws.service';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  PageMovedEvent,
  TreeNodeSnapshot,
} from '../database/listeners/page.listener';
import { getSpaceRoomName } from './ws.utils';

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
  let wsService: { emitTreeEvent: jest.Mock; emitToSpaceRoom: jest.Mock };

  beforeEach(async () => {
    wsService = {
      emitTreeEvent: jest.fn().mockResolvedValue(undefined),
      emitToSpaceRoom: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [WsTreeService, { provide: WsService, useValue: wsService }],
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
});
