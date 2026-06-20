import { Test, TestingModule } from '@nestjs/testing';
import { PageWsListener } from './page-ws.listener';
import { WsTreeService } from '../ws-tree.service';
import {
  PageEvent,
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
