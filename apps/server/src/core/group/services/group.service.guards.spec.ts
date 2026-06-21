import { BadRequestException } from '@nestjs/common';
import { GroupService } from './group.service';

// Direct-instantiation unit tests for GroupService's integrity guards:
//  - the DEFAULT (system) group cannot be updated or deleted;
//  - group names are unique on create and on rename;
//  - renaming a group to its OWN current name is allowed (no false positive).
// Each rejection test also asserts that no destructive repo write fired.
//
// Constructor arg order (8 positional deps) is pinned: groupRepo, groupUserRepo,
// spaceMemberRepo, groupUserService, watcherRepo, favoriteRepo, db,
// auditService.

const WORKSPACE_ID = 'ws-1';

function buildService(opts?: {
  // group returned by groupRepo.findById (the target being updated/deleted)
  group?: any;
  // group returned by groupRepo.findByName (a name-collision probe)
  byName?: any;
}) {
  const groupRepo = {
    findById: jest.fn().mockResolvedValue(opts?.group ?? null),
    findByName: jest.fn().mockResolvedValue(opts?.byName ?? null),
    insertGroup: jest
      .fn()
      .mockResolvedValue({ id: 'g-new', name: 'New Group', description: null }),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const groupUserRepo = {
    getUserIdsByGroupId: jest.fn().mockResolvedValue([]),
  };
  const spaceMemberRepo = {
    getSpaceIdsByGroupId: jest.fn().mockResolvedValue([]),
  };
  const groupUserService = {
    addUsersToGroupBatch: jest.fn().mockResolvedValue(undefined),
  };
  const watcherRepo = {
    deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
  };
  const favoriteRepo = {
    deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    transaction: jest.fn().mockReturnValue({
      execute: jest.fn(async (cb: any) => cb({} as any)),
    }),
  };
  const auditService = { log: jest.fn() };

  const service = new GroupService(
    groupRepo as any, // groupRepo
    groupUserRepo as any, // groupUserRepo
    spaceMemberRepo as any, // spaceMemberRepo
    groupUserService as any, // groupUserService
    watcherRepo as any, // watcherRepo
    favoriteRepo as any, // favoriteRepo
    db as any, // db
    auditService as any, // auditService
  );

  return { service, groupRepo, auditService };
}

const authUser = { id: 'auth-1' } as any;

describe('GroupService.createGroup duplicate-name guard', () => {
  it('rejects creating a group with an existing name (no insert)', async () => {
    const { service, groupRepo } = buildService({
      byName: { id: 'g-existing', name: 'Engineering' },
    });

    await expect(
      service.createGroup(authUser, WORKSPACE_ID, {
        name: 'Engineering',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(groupRepo.insertGroup).not.toHaveBeenCalled();
  });

  it('creates a group when the name is free', async () => {
    const { service, groupRepo } = buildService({ byName: null });

    await service.createGroup(authUser, WORKSPACE_ID, {
      name: 'Engineering',
    } as any);

    expect(groupRepo.insertGroup).toHaveBeenCalledTimes(1);
    // isDefault must always be false for a user-created group.
    expect(groupRepo.insertGroup.mock.calls[0][0]).toMatchObject({
      name: 'Engineering',
      isDefault: false,
      workspaceId: WORKSPACE_ID,
    });
  });
});

describe('GroupService.updateGroup guards', () => {
  it('rejects updating a DEFAULT group with BadRequest (no update)', async () => {
    const { service, groupRepo } = buildService({
      group: {
        id: 'g-default',
        name: 'Everyone',
        description: null,
        isDefault: true,
      },
    });

    await expect(
      service.updateGroup(WORKSPACE_ID, {
        groupId: 'g-default',
        name: 'Renamed',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(groupRepo.update).not.toHaveBeenCalled();
  });

  it('rejects renaming to a name owned by a DIFFERENT group (no update)', async () => {
    const { service, groupRepo } = buildService({
      group: {
        id: 'g-1',
        name: 'Engineering',
        description: null,
        isDefault: false,
      },
      // A different group already holds the target name.
      byName: { id: 'g-2', name: 'Design' },
    });

    await expect(
      service.updateGroup(WORKSPACE_ID, {
        groupId: 'g-1',
        name: 'Design',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(groupRepo.update).not.toHaveBeenCalled();
  });

  it('allows renaming a group to its OWN current name (no false collision)', async () => {
    // findByName returns the same group; group.name === existingGroup.name, so
    // the duplicate guard must NOT fire.
    const sameGroup = {
      id: 'g-1',
      name: 'Engineering',
      description: null,
      isDefault: false,
    };
    const { service, groupRepo } = buildService({
      group: { ...sameGroup },
      byName: { ...sameGroup },
    });

    await service.updateGroup(WORKSPACE_ID, {
      groupId: 'g-1',
      name: 'Engineering',
    } as any);

    expect(groupRepo.update).toHaveBeenCalledTimes(1);
  });
});

describe('GroupService.deleteGroup guard', () => {
  it('rejects deleting a DEFAULT group with BadRequest (no delete)', async () => {
    const { service, groupRepo } = buildService({
      group: {
        id: 'g-default',
        name: 'Everyone',
        description: null,
        isDefault: true,
      },
    });

    await expect(
      service.deleteGroup('g-default', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(groupRepo.delete).not.toHaveBeenCalled();
  });

  it('deletes a non-default group', async () => {
    const { service, groupRepo } = buildService({
      group: {
        id: 'g-1',
        name: 'Engineering',
        description: null,
        isDefault: false,
      },
    });

    await service.deleteGroup('g-1', WORKSPACE_ID);

    expect(groupRepo.delete).toHaveBeenCalledTimes(1);
  });
});
