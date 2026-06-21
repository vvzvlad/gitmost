import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { UserRole } from '../../../common/helpers/types/permission';

// Direct-instantiation unit tests for the privilege/last-owner guards in
// WorkspaceService.updateWorkspaceUserRole / deactivateUser / deleteUser.
//
// These guards are the membership-safety net: they stop an ADMIN from acting on
// an OWNER, prevent the LAST owner from being demoted/removed (which would
// orphan the workspace), and block a user from locking themselves out. Each
// test constructs the service directly with jest-mocked repos (matching
// page.service.spec.ts / workspace-update-gate.spec.ts) and asserts BOTH the
// thrown exception AND that no destructive DB write happened on a rejection.
//
// Constructor arg order (18 positional deps) is pinned here so a reorder is
// caught: workspaceRepo, spaceService, spaceMemberService, groupRepo,
// groupUserRepo, userRepo, environmentService, domainService,
// licenseCheckService, shareRepo, watcherRepo, favoriteRepo, db,
// attachmentQueue, billingQueue, aiQueue, auditService, userSessionRepo.

type UserRow = {
  id: string;
  role: UserRole | string;
  deletedAt?: Date | null;
  deactivatedAt?: Date | null;
  name?: string;
  email?: string;
};

const WORKSPACE_ID = 'ws-1';

function buildService(opts?: {
  target?: UserRow | null;
  ownerCount?: number;
}) {
  // userRepo: findById resolves the target member; roleCountByWorkspaceId
  // returns how many OWNERs exist (drives the last-owner guard); updateUser is
  // the destructive write we assert is/ isn't called.
  const userRepo = {
    findById: jest.fn().mockResolvedValue(opts?.target ?? null),
    roleCountByWorkspaceId: jest
      .fn()
      .mockResolvedValue(opts?.ownerCount ?? 2),
    updateUser: jest.fn().mockResolvedValue(undefined),
  };

  const auditService = { log: jest.fn() };

  // db.transaction().execute(cb) runs the callback with a fake trx. Only the
  // happy paths of deactivate/delete reach this; the guard-rejection tests
  // throw before it. The trx exposes deleteFrom(...).where(...).execute() and
  // updateTable(...).set(...).where(...).execute() chains used inside.
  const trxChain: any = {
    deleteFrom: jest.fn().mockReturnThis(),
    updateTable: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    transaction: jest.fn().mockReturnValue({
      execute: jest.fn(async (cb: any) => cb(trxChain)),
    }),
  };

  const userSessionRepo = {
    revokeByUserId: jest.fn().mockResolvedValue(undefined),
  };
  const watcherRepo = {
    deleteByUserAndWorkspace: jest.fn().mockResolvedValue(undefined),
  };
  const favoriteRepo = {
    deleteByUserAndWorkspace: jest.fn().mockResolvedValue(undefined),
  };
  const attachmentQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new WorkspaceService(
    {} as any, // workspaceRepo
    {} as any, // spaceService
    {} as any, // spaceMemberService
    {} as any, // groupRepo
    {} as any, // groupUserRepo
    userRepo as any, // userRepo
    {} as any, // environmentService
    {} as any, // domainService
    {} as any, // licenseCheckService
    {} as any, // shareRepo
    watcherRepo as any, // watcherRepo
    favoriteRepo as any, // favoriteRepo
    db as any, // db
    attachmentQueue as any, // attachmentQueue
    {} as any, // billingQueue
    {} as any, // aiQueue
    auditService as any, // auditService
    userSessionRepo as any, // userSessionRepo
  );

  return { service, userRepo, auditService, db, userSessionRepo };
}

const authUser = (role: UserRole, id = 'auth-1') =>
  ({ id, role }) as any;

describe('WorkspaceService.updateWorkspaceUserRole role guards', () => {
  it('forbids an ADMIN acting on an OWNER target (no updateUser)', async () => {
    const { service, userRepo, auditService } = buildService({
      target: { id: 'u-target', role: UserRole.OWNER },
    });

    await expect(
      service.updateWorkspaceUserRole(
        authUser(UserRole.ADMIN),
        { userId: 'u-target', role: UserRole.MEMBER } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(userRepo.updateUser).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('forbids an ADMIN promoting someone to OWNER (no updateUser)', async () => {
    const { service, userRepo } = buildService({
      target: { id: 'u-target', role: UserRole.MEMBER },
    });

    await expect(
      service.updateWorkspaceUserRole(
        authUser(UserRole.ADMIN),
        { userId: 'u-target', role: UserRole.OWNER } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });

  it('rejects demoting the LAST owner with BadRequest (no updateUser)', async () => {
    const { service, userRepo } = buildService({
      target: { id: 'u-target', role: UserRole.OWNER },
      ownerCount: 1,
    });

    await expect(
      service.updateWorkspaceUserRole(
        authUser(UserRole.OWNER),
        { userId: 'u-target', role: UserRole.ADMIN } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });

  it('allows demoting an owner when more than one owner exists', async () => {
    const { service, userRepo, auditService } = buildService({
      target: { id: 'u-target', role: UserRole.OWNER },
      ownerCount: 2,
    });

    await service.updateWorkspaceUserRole(
      authUser(UserRole.OWNER),
      { userId: 'u-target', role: UserRole.ADMIN } as any,
      WORKSPACE_ID,
    );

    expect(userRepo.updateUser).toHaveBeenCalledTimes(1);
    expect(userRepo.updateUser).toHaveBeenCalledWith(
      { role: UserRole.ADMIN },
      'u-target',
      WORKSPACE_ID,
    );
    expect(auditService.log).toHaveBeenCalledTimes(1);
  });

  it('returns early on a same-role no-op WITHOUT a DB write or audit', async () => {
    const { service, userRepo, auditService } = buildService({
      target: { id: 'u-target', role: UserRole.MEMBER },
    });

    const result = await service.updateWorkspaceUserRole(
      authUser(UserRole.OWNER),
      { userId: 'u-target', role: UserRole.MEMBER } as any,
      WORKSPACE_ID,
    );

    // Same-role early return hands back the loaded user untouched.
    expect(result).toEqual({ id: 'u-target', role: UserRole.MEMBER });
    expect(userRepo.updateUser).not.toHaveBeenCalled();
    expect(userRepo.roleCountByWorkspaceId).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('performs a valid MEMBER->ADMIN change: updateUser + audit', async () => {
    const { service, userRepo, auditService } = buildService({
      target: { id: 'u-target', role: UserRole.MEMBER },
    });

    await service.updateWorkspaceUserRole(
      authUser(UserRole.OWNER),
      { userId: 'u-target', role: UserRole.ADMIN } as any,
      WORKSPACE_ID,
    );

    expect(userRepo.updateUser).toHaveBeenCalledWith(
      { role: UserRole.ADMIN },
      'u-target',
      WORKSPACE_ID,
    );
    expect(auditService.log).toHaveBeenCalledTimes(1);
  });

  it('rejects with BadRequest when the target member is not found', async () => {
    const { service, userRepo } = buildService({ target: null });

    await expect(
      service.updateWorkspaceUserRole(
        authUser(UserRole.OWNER),
        { userId: 'missing', role: UserRole.ADMIN } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.deactivateUser guards', () => {
  it('rejects self-deactivation with BadRequest (no DB tx)', async () => {
    const { service, db } = buildService({
      target: { id: 'auth-1', role: UserRole.OWNER },
    });

    await expect(
      service.deactivateUser(authUser(UserRole.OWNER, 'auth-1'), 'auth-1', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects an ADMIN deactivating an OWNER with BadRequest', async () => {
    const { service, db } = buildService({
      target: { id: 'u-owner', role: UserRole.OWNER },
    });

    await expect(
      service.deactivateUser(authUser(UserRole.ADMIN), 'u-owner', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects deactivating the LAST owner with BadRequest', async () => {
    const { service, db } = buildService({
      target: { id: 'u-owner', role: UserRole.OWNER },
      ownerCount: 1,
    });

    await expect(
      service.deactivateUser(authUser(UserRole.OWNER), 'u-owner', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects deactivating an already-deactivated user with BadRequest', async () => {
    const { service, db } = buildService({
      target: {
        id: 'u-member',
        role: UserRole.MEMBER,
        deactivatedAt: new Date(),
      },
    });

    await expect(
      service.deactivateUser(authUser(UserRole.OWNER), 'u-member', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('deactivates a normal member: writes deactivatedAt + revokes sessions', async () => {
    const { service, userRepo, userSessionRepo, db } = buildService({
      target: { id: 'u-member', role: UserRole.MEMBER },
      ownerCount: 2,
    });

    await service.deactivateUser(
      authUser(UserRole.OWNER),
      'u-member',
      WORKSPACE_ID,
    );

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(userRepo.updateUser).toHaveBeenCalledTimes(1);
    // The first positional arg is the patch object with a fresh deactivatedAt.
    expect(userRepo.updateUser.mock.calls[0][1]).toBe('u-member');
    expect(userRepo.updateUser.mock.calls[0][2]).toBe(WORKSPACE_ID);
    expect(userSessionRepo.revokeByUserId).toHaveBeenCalled();
  });
});

describe('WorkspaceService.deleteUser guards', () => {
  it('rejects deleting the LAST owner with BadRequest', async () => {
    const { service, db } = buildService({
      target: { id: 'u-owner', role: UserRole.OWNER },
      ownerCount: 1,
    });

    await expect(
      service.deleteUser(authUser(UserRole.OWNER), 'u-owner', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects self-deletion with BadRequest', async () => {
    // Two owners exist so the last-owner guard does not fire first; the
    // self-target guard is what we are pinning here.
    const { service, db } = buildService({
      target: { id: 'auth-1', role: UserRole.OWNER },
      ownerCount: 2,
    });

    await expect(
      service.deleteUser(authUser(UserRole.OWNER, 'auth-1'), 'auth-1', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects an ADMIN deleting an OWNER with BadRequest', async () => {
    const { service, db } = buildService({
      target: { id: 'u-owner', role: UserRole.OWNER },
      ownerCount: 2,
    });

    await expect(
      service.deleteUser(authUser(UserRole.ADMIN), 'u-owner', WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('deletes a normal member: anonymises + revokes sessions inside the tx', async () => {
    const { service, userRepo, userSessionRepo, db } = buildService({
      target: { id: 'u-member', role: UserRole.MEMBER },
      ownerCount: 2,
    });

    await service.deleteUser(authUser(UserRole.OWNER), 'u-member', WORKSPACE_ID);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(userRepo.updateUser).toHaveBeenCalledTimes(1);
    expect(userRepo.updateUser.mock.calls[0][1]).toBe('u-member');
    expect(userSessionRepo.revokeByUserId).toHaveBeenCalled();
  });
});
