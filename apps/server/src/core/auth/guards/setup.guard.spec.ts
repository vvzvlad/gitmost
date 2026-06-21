import { ForbiddenException } from '@nestjs/common';
import { SetupGuard } from './setup.guard';

/**
 * Security contract for SetupGuard.
 *
 * /auth/setup creates the very first workspace + owner on a self-hosted
 * instance. The guard is the only thing stopping that endpoint from being
 * re-run to mint a SECOND owner on an already-initialised instance (privilege
 * escalation), or from being reachable at all on cloud. It is constructed
 * directly with a stubbed workspace repo and environment service.
 *
 * The guard's canActivate takes no ExecutionContext argument, so we call it
 * with none.
 */

function makeGuard(over: {
  isCloud?: boolean;
  workspaceCount?: number;
} = {}): {
  guard: SetupGuard;
  workspaceRepo: { count: jest.Mock };
  environmentService: { isCloud: jest.Mock };
} {
  const workspaceRepo = {
    count: jest.fn().mockResolvedValue(over.workspaceCount ?? 0),
  };
  const environmentService = {
    isCloud: jest.fn().mockReturnValue(over.isCloud ?? false),
  };

  // Constructor signature (setup.guard.ts): (workspaceRepo, environmentService).
  const guard = new (SetupGuard as unknown as new (
    ...args: unknown[]
  ) => SetupGuard)(workspaceRepo, environmentService);

  return { guard, workspaceRepo, environmentService };
}

describe('SetupGuard.canActivate', () => {
  it('cloud instance -> returns false (setup blocked) without checking the workspace count', async () => {
    const { guard, workspaceRepo } = makeGuard({ isCloud: true });

    await expect(guard.canActivate()).resolves.toBe(false);
    // Short-circuits before touching the repo.
    expect(workspaceRepo.count).not.toHaveBeenCalled();
  });

  it('self-hosted with 0 existing workspaces -> returns true (first-time setup allowed)', async () => {
    const { guard, workspaceRepo } = makeGuard({
      isCloud: false,
      workspaceCount: 0,
    });

    await expect(guard.canActivate()).resolves.toBe(true);
    expect(workspaceRepo.count).toHaveBeenCalledTimes(1);
  });

  it('self-hosted with an existing workspace -> throws ForbiddenException (no second owner)', async () => {
    const { guard } = makeGuard({ isCloud: false, workspaceCount: 1 });

    await expect(guard.canActivate()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard.canActivate()).rejects.toMatchObject({
      message: 'Workspace setup already completed.',
    });
  });

  it('self-hosted with many existing workspaces -> still throws ForbiddenException', async () => {
    const { guard } = makeGuard({ isCloud: false, workspaceCount: 5 });

    await expect(guard.canActivate()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
