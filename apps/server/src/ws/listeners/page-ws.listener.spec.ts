import { Test, TestingModule } from '@nestjs/testing';
import { PageWsListener } from './page-ws.listener';
import { WsTreeService } from '../ws-tree.service';
import {
  PageEvent,
  PageMovedEvent,
  TreeNodeSnapshot,
} from '../../database/listeners/page.listener';

const snapshot: TreeNodeSnapshot = {
  id: 'page-1',
  slugId: 'slug-1',
  title: 'Hello',
  icon: '📄',
  position: 'a1',
  spaceId: 'space-1',
  parentPageId: null,
};

describe('PageWsListener.onPageCreated', () => {
  let listener: PageWsListener;
  let wsTree: {
    broadcastPageCreated: jest.Mock;
    broadcastRefetchRoot: jest.Mock;
  };

  beforeEach(async () => {
    wsTree = {
      broadcastPageCreated: jest.fn().mockResolvedValue(undefined),
      broadcastRefetchRoot: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PageWsListener,
        { provide: WsTreeService, useValue: wsTree },
      ],
    }).compile();

    listener = module.get<PageWsListener>(PageWsListener);
  });

  it('with `pages`: broadcasts a per-node addTreeNode and does NOT refetch root', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
      pages: [snapshot],
    };

    await listener.onPageCreated(event);

    expect(wsTree.broadcastPageCreated).toHaveBeenCalledTimes(1);
    expect(wsTree.broadcastPageCreated).toHaveBeenCalledWith(snapshot);
    expect(wsTree.broadcastRefetchRoot).not.toHaveBeenCalled();
  });

  it('without `pages` but WITH `spaceId` (bulk create): falls back to a root refetch', async () => {
    const event: PageEvent = {
      pageIds: ['page-1', 'page-2'],
      workspaceId: 'ws-1',
      spaceId: 'space-9',
    };

    await listener.onPageCreated(event);

    expect(wsTree.broadcastPageCreated).not.toHaveBeenCalled();
    expect(wsTree.broadcastRefetchRoot).toHaveBeenCalledTimes(1);
    expect(wsTree.broadcastRefetchRoot).toHaveBeenCalledWith('space-9');
  });

  it('with an EMPTY `pages` array but WITH `spaceId`: still falls back to a root refetch', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
      pages: [],
      spaceId: 'space-9',
    };

    await listener.onPageCreated(event);

    expect(wsTree.broadcastPageCreated).not.toHaveBeenCalled();
    expect(wsTree.broadcastRefetchRoot).toHaveBeenCalledWith('space-9');
  });

  it('without `pages` and without `spaceId`: does nothing (no broadcast)', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
    };

    await listener.onPageCreated(event);

    expect(wsTree.broadcastPageCreated).not.toHaveBeenCalled();
    expect(wsTree.broadcastRefetchRoot).not.toHaveBeenCalled();
  });
});

describe('PageWsListener delete/move/restore handlers', () => {
  let listener: PageWsListener;
  let wsTree: {
    broadcastPageCreated: jest.Mock;
    broadcastPageDeleted: jest.Mock;
    broadcastPageMoved: jest.Mock;
    broadcastRefetchRoot: jest.Mock;
  };
  let warnSpy: jest.SpyInstance;

  const secondSnapshot: TreeNodeSnapshot = {
    id: 'page-2',
    slugId: 'slug-2',
    title: 'World',
    icon: '📁',
    position: 'a2',
    spaceId: 'space-1',
    parentPageId: null,
  };

  beforeEach(async () => {
    wsTree = {
      broadcastPageCreated: jest.fn().mockResolvedValue(undefined),
      broadcastPageDeleted: jest.fn().mockResolvedValue(undefined),
      broadcastPageMoved: jest.fn().mockResolvedValue(undefined),
      broadcastRefetchRoot: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PageWsListener,
        { provide: WsTreeService, useValue: wsTree },
      ],
    }).compile();

    listener = module.get<PageWsListener>(PageWsListener);
    // The PAGE_RESTORED-without-spaceId branch logs a warning; silence + assert.
    warnSpy = jest
      .spyOn(listener['logger'], 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // --- onPageDeleted (PAGE_SOFT_DELETED / PAGE_DELETED) ---

  it('onPageDeleted with N `pages`: one broadcastPageDeleted per page', async () => {
    const event: PageEvent = {
      pageIds: ['page-1', 'page-2'],
      workspaceId: 'ws-1',
      pages: [snapshot, secondSnapshot],
    };

    await listener.onPageDeleted(event);

    expect(wsTree.broadcastPageDeleted).toHaveBeenCalledTimes(2);
    expect(wsTree.broadcastPageDeleted).toHaveBeenNthCalledWith(1, snapshot);
    expect(wsTree.broadcastPageDeleted).toHaveBeenNthCalledWith(
      2,
      secondSnapshot,
    );
  });

  it('onPageDeleted with an EMPTY `pages` array: no broadcast', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
      pages: [],
    };

    await listener.onPageDeleted(event);

    expect(wsTree.broadcastPageDeleted).not.toHaveBeenCalled();
  });

  it('onPageDeleted with UNDEFINED `pages`: no broadcast (no crash)', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
    };

    await listener.onPageDeleted(event);

    expect(wsTree.broadcastPageDeleted).not.toHaveBeenCalled();
  });

  // --- onPageMoved (PAGE_MOVED) ---

  it('onPageMoved: forwards the whole event to a single broadcastPageMoved', async () => {
    const event: PageMovedEvent = {
      workspaceId: 'ws-1',
      oldParentId: 'old-parent',
      hasChildren: false,
      node: { ...snapshot, parentPageId: 'new-parent', position: 'a5' },
    };

    await listener.onPageMoved(event);

    expect(wsTree.broadcastPageMoved).toHaveBeenCalledTimes(1);
    expect(wsTree.broadcastPageMoved).toHaveBeenCalledWith(event);
  });

  // --- onPageRestored (PAGE_RESTORED) ---

  it('onPageRestored WITHOUT spaceId: warns and does NOT refetch', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
    };

    await listener.onPageRestored(event);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PAGE_RESTORED'),
    );
    expect(wsTree.broadcastRefetchRoot).not.toHaveBeenCalled();
  });

  it('onPageRestored WITH spaceId: one broadcastRefetchRoot scoped to the space', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
      spaceId: 'space-9',
    };

    await listener.onPageRestored(event);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(wsTree.broadcastRefetchRoot).toHaveBeenCalledTimes(1);
    expect(wsTree.broadcastRefetchRoot).toHaveBeenCalledWith('space-9');
  });
});
