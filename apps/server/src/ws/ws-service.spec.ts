import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { WsService } from './ws.service';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import {
  getSpaceRoomName,
  WS_SPACE_RESTRICTION_CACHE_PREFIX,
  WS_CACHE_TTL_MS,
} from './ws.utils';

/**
 * WsService server-side unit tests (M7 item 2):
 *  - spaceHasRestrictions cache lifecycle (miss -> read+set with TTL; hit ->
 *    no re-read; documents the stale-false window).
 *  - broadcastToAuthorizedUsers fan-out (authorized-only delivery, multi-socket
 *    fan-out per user, sockets with no userId skipped).
 *
 * Both private methods are exercised through their public entry points:
 * spaceHasRestrictions via emitTreeEvent, broadcastToAuthorizedUsers via the
 * restricted-page path of emitTreeEvent. WsService is constructed with mocked
 * cache + repo and a mocked socket.io server, so no live infra is needed.
 */

describe('WsService.spaceHasRestrictions (cache lifecycle, via emitTreeEvent)', () => {
  let service: WsService;
  let pagePermissionRepo: {
    hasRestrictedPagesInSpace: jest.Mock;
    hasRestrictedAncestor: jest.Mock;
    getUserIdsWithPageAccess: jest.Mock;
  };
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let roomEmit: jest.Mock;

  beforeEach(async () => {
    pagePermissionRepo = {
      hasRestrictedPagesInSpace: jest.fn(),
      hasRestrictedAncestor: jest.fn(),
      getUserIdsWithPageAccess: jest.fn(),
    };
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
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
    const server = {
      to: jest.fn().mockReturnValue({ emit: roomEmit }),
      in: jest.fn().mockReturnValue({ fetchSockets: jest.fn() }),
    };
    service.setServer(server as never);
  });

  const cacheKey = (spaceId: string): string =>
    `${WS_SPACE_RESTRICTION_CACHE_PREFIX}${spaceId}`;

  it('first call MISSES the cache -> reads the repo and sets it with WS_CACHE_TTL_MS', async () => {
    cache.get.mockResolvedValue(null); // miss
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(true);
    pagePermissionRepo.hasRestrictedAncestor.mockResolvedValue(false);

    await service.emitTreeEvent('space-1', 'page-1', { op: 'x' });

    expect(cache.get).toHaveBeenCalledWith(cacheKey('space-1'));
    expect(pagePermissionRepo.hasRestrictedPagesInSpace).toHaveBeenCalledTimes(1);
    expect(pagePermissionRepo.hasRestrictedPagesInSpace).toHaveBeenCalledWith(
      'space-1',
    );
    // The freshly-read verdict is cached with the 30s TTL.
    expect(cache.set).toHaveBeenCalledWith(
      cacheKey('space-1'),
      true,
      WS_CACHE_TTL_MS,
    );
  });

  it('second call HITS the cache -> the repo is NOT re-read', async () => {
    // Cache hit returns false (no restrictions) -> open-space fast path.
    cache.get.mockResolvedValue(false);

    await service.emitTreeEvent('space-1', 'page-1', { op: 'x' });

    expect(cache.get).toHaveBeenCalledWith(cacheKey('space-1'));
    // The whole point of the cache: no repo read on a hit.
    expect(pagePermissionRepo.hasRestrictedPagesInSpace).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    // false verdict -> broadcast to the whole room (open-space fast path).
    expect(roomEmit).toHaveBeenCalledWith('message', { op: 'x' });
  });

  it('a cached `false` is returned even when restrictions now exist (the stale window)', async () => {
    // The cache says "no restrictions" (false) but the repo, if asked, would now
    // say true. spaceHasRestrictions trusts the cached false and never re-reads —
    // this documents the up-to-TTL stale window the production comment warns about
    // (a payload can fan out room-wide until the cache is invalidated/expires).
    cache.get.mockResolvedValue(false);
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(true);

    await service.emitTreeEvent('space-1', 'page-1', { op: 'stale' });

    expect(pagePermissionRepo.hasRestrictedPagesInSpace).not.toHaveBeenCalled();
    // Treated as open -> the event is broadcast to the WHOLE room.
    expect(roomEmit).toHaveBeenCalledWith('message', { op: 'stale' });
  });

  it('caches a `false` verdict too (so the next emit hits, not re-reads)', async () => {
    cache.get.mockResolvedValueOnce(null); // first call: miss
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(false);

    await service.emitTreeEvent('space-2', 'page-9', { op: 'y' });

    expect(cache.set).toHaveBeenCalledWith(
      cacheKey('space-2'),
      false,
      WS_CACHE_TTL_MS,
    );
  });
});

describe('WsService.broadcastToAuthorizedUsers fan-out (via emitTreeEvent restricted path)', () => {
  let service: WsService;
  let pagePermissionRepo: {
    hasRestrictedPagesInSpace: jest.Mock;
    hasRestrictedAncestor: jest.Mock;
    getUserIdsWithPageAccess: jest.Mock;
  };
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let fetchSockets: jest.Mock;
  let serverIn: jest.Mock;

  beforeEach(async () => {
    pagePermissionRepo = {
      hasRestrictedPagesInSpace: jest.fn(),
      hasRestrictedAncestor: jest.fn(),
      getUserIdsWithPageAccess: jest.fn(),
    };
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsService,
        { provide: PagePermissionRepo, useValue: pagePermissionRepo },
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    service = module.get<WsService>(WsService);

    fetchSockets = jest.fn();
    serverIn = jest.fn().mockReturnValue({ fetchSockets });
    const server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      in: serverIn,
    };
    service.setServer(server as never);

    // Reach broadcastToAuthorizedUsers through emitTreeEvent's restricted path:
    // the space has restrictions (cache miss -> repo says true) and the page has
    // a restricted ancestor, so the emit is scoped to the authorized users.
    pagePermissionRepo.hasRestrictedPagesInSpace.mockResolvedValue(true);
    pagePermissionRepo.hasRestrictedAncestor.mockResolvedValue(true);
  });

  it('only sockets whose userId is in getUserIdsWithPageAccess receive the event', async () => {
    pagePermissionRepo.getUserIdsWithPageAccess.mockResolvedValue(['user-ok']);

    const okEmit = jest.fn();
    const noEmit = jest.fn();
    fetchSockets.mockResolvedValue([
      { id: 's1', data: { userId: 'user-ok' }, emit: okEmit },
      { id: 's2', data: { userId: 'user-no' }, emit: noEmit },
    ]);

    const data = { operation: 'moveTreeNode' };
    await service.emitTreeEvent('space-1', 'page-1', data);

    // The authorized set is resolved from the candidate userIds present on the
    // sockets (deduped), then only those users' sockets get the event.
    expect(pagePermissionRepo.getUserIdsWithPageAccess).toHaveBeenCalledWith(
      'page-1',
      expect.arrayContaining(['user-ok', 'user-no']),
    );
    expect(okEmit).toHaveBeenCalledWith('message', data);
    expect(noEmit).not.toHaveBeenCalled();
  });

  it('a user with TWO sockets receives the event on BOTH (userSocketMap fan-out)', async () => {
    pagePermissionRepo.getUserIdsWithPageAccess.mockResolvedValue(['user-ok']);

    const tab1 = jest.fn();
    const tab2 = jest.fn();
    fetchSockets.mockResolvedValue([
      { id: 's1', data: { userId: 'user-ok' }, emit: tab1 },
      { id: 's2', data: { userId: 'user-ok' }, emit: tab2 },
    ]);

    const data = { operation: 'moveTreeNode' };
    await service.emitTreeEvent('space-1', 'page-1', data);

    // Both of the authorized user's sockets (e.g. two browser tabs) receive it.
    expect(tab1).toHaveBeenCalledWith('message', data);
    expect(tab2).toHaveBeenCalledWith('message', data);
    // The candidate set is deduped to a single userId even with two sockets.
    expect(pagePermissionRepo.getUserIdsWithPageAccess).toHaveBeenCalledWith(
      'page-1',
      ['user-ok'],
    );
  });

  it('a socket with NO userId is skipped (not a candidate, never emitted to)', async () => {
    pagePermissionRepo.getUserIdsWithPageAccess.mockResolvedValue(['user-ok']);

    const okEmit = jest.fn();
    const anonEmit = jest.fn();
    fetchSockets.mockResolvedValue([
      { id: 's1', data: { userId: 'user-ok' }, emit: okEmit },
      // Unauthenticated socket: no userId -> excluded from the candidate map.
      { id: 's2', data: {}, emit: anonEmit },
    ]);

    const data = { operation: 'moveTreeNode' };
    await service.emitTreeEvent('space-1', 'page-1', data);

    expect(okEmit).toHaveBeenCalledWith('message', data);
    expect(anonEmit).not.toHaveBeenCalled();
    // The no-userId socket is not even offered as a candidate to the repo.
    expect(pagePermissionRepo.getUserIdsWithPageAccess).toHaveBeenCalledWith(
      'page-1',
      ['user-ok'],
    );
  });

  it('no sockets in the room -> no repo lookup, no emit', async () => {
    fetchSockets.mockResolvedValue([]);

    await service.emitTreeEvent('space-1', 'page-1', { op: 'x' });

    expect(pagePermissionRepo.getUserIdsWithPageAccess).not.toHaveBeenCalled();
  });

  it('routes through the space room name', async () => {
    pagePermissionRepo.getUserIdsWithPageAccess.mockResolvedValue([]);
    fetchSockets.mockResolvedValue([
      { id: 's1', data: { userId: 'u' }, emit: jest.fn() },
    ]);

    await service.emitTreeEvent('space-7', 'page-1', { op: 'x' });

    expect(serverIn).toHaveBeenCalledWith(getSpaceRoomName('space-7'));
  });
});
