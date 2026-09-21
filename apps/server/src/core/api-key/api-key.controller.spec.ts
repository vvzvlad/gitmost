import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';

/**
 * Authorization contract for the /api-keys management surface.
 *
 *  - A token cannot manage tokens (an api_key PRINCIPAL is 403 on every method)
 *    — GitHub-PAT semantics closing post-revocation laundering.
 *  - admin (CASL Manage on API) sees/revokes all workspace keys; a member only
 *    their own.
 *  - reveal: password step-up (401 on wrong password), owner-only even for admin
 *    (404), api_key principal 403 — the copyable-key surface (#557).
 */

function makeController(over: any = {}) {
  const apiKeyService = {
    create: jest.fn().mockResolvedValue({
      token: 'tok',
      key: { id: 'k1', name: 'n', expiresAt: null, createdAt: new Date() },
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
    reveal: jest.fn().mockResolvedValue('remint.tok'),
    ...(over.apiKeyService ?? {}),
  };
  const apiKeyRepo = {
    findAllInWorkspace: jest.fn().mockResolvedValue([]),
    findByCreator: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    ...(over.apiKeyRepo ?? {}),
  };
  const workspaceAbility = {
    createForUser: jest.fn().mockReturnValue({
      can: (_a: any, _s: any) => over.canManage ?? false,
    }),
    ...(over.workspaceAbility ?? {}),
  };
  const authService = {
    verifyUserCredentials: jest.fn().mockResolvedValue({ id: 'u-1' }),
    ...(over.authService ?? {}),
  };
  const auditService = { log: jest.fn() };
  const controller = new ApiKeyController(
    apiKeyService as any,
    apiKeyRepo as any,
    workspaceAbility as any,
    authService as any,
    auditService as any,
  );
  return {
    controller,
    apiKeyService,
    apiKeyRepo,
    workspaceAbility,
    authService,
    auditService,
  };
}

const user = { id: 'u-1', email: 'u@x.io', workspaceId: 'ws-1' } as any;
const workspace = { id: 'ws-1' } as any;
const reqAccess = () => ({ raw: {}, ip: '1.2.3.4', socket: {} }) as any;
const reqApiKey = () =>
  ({ raw: { authType: 'api_key', apiKeyId: 'k-self' }, ip: '1.2.3.4', socket: {} }) as any;

describe('ApiKeyController — a token cannot manage tokens', () => {
  it('403 on create for an api_key principal', async () => {
    const { controller, apiKeyService } = makeController();
    await expect(
      controller.create({ name: 'x' } as any, user, reqApiKey()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(apiKeyService.create).not.toHaveBeenCalled();
  });

  it('403 on list for an api_key principal', async () => {
    const { controller } = makeController();
    await expect(
      controller.list(user, workspace, reqApiKey()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 on revoke for an api_key principal', async () => {
    const { controller } = makeController();
    await expect(
      controller.revoke({ id: 'k1' } as any, user, workspace, reqApiKey()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 on reveal for an api_key principal (a key cannot reveal its siblings)', async () => {
    const { controller, authService, apiKeyService } = makeController();
    await expect(
      controller.reveal(
        { id: 'k1', password: 'pw' } as any,
        user,
        workspace,
        reqApiKey(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Rejected BEFORE the step-up and the key lookup even run.
    expect(authService.verifyUserCredentials).not.toHaveBeenCalled();
    expect(apiKeyService.reveal).not.toHaveBeenCalled();
  });
});

describe('ApiKeyController — reveal (copyable key under step-up)', () => {
  it('re-mints and returns the token + logs API_KEY_REVEALED on success', async () => {
    const { controller, apiKeyService, authService, auditService } =
      makeController();
    const res = await controller.reveal(
      { id: 'k1', password: 'correct-horse' } as any,
      user,
      workspace,
      reqAccess(),
    );

    expect(res).toEqual({ token: 'remint.tok' });
    // Step-up ran with the caller's email + supplied password.
    expect(authService.verifyUserCredentials).toHaveBeenCalledWith(
      { email: 'u@x.io', password: 'correct-horse' },
      'ws-1',
    );
    expect(apiKeyService.reveal).toHaveBeenCalledWith({
      apiKeyId: 'k1',
      user,
      workspaceId: 'ws-1',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'api_key.revealed' }),
    );
  });

  it('401 on a wrong password — step-up runs BEFORE the key lookup (no oracle)', async () => {
    const { controller, apiKeyService } = makeController({
      authService: {
        verifyUserCredentials: jest
          .fn()
          .mockRejectedValue(new UnauthorizedException()),
      },
    });
    await expect(
      controller.reveal(
        { id: 'k1', password: 'wrong' } as any,
        user,
        workspace,
        reqAccess(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // The key is never looked up / re-minted when step-up fails.
    expect(apiKeyService.reveal).not.toHaveBeenCalled();
  });

  it("propagates the service's uniform 404 (absent/revoked/expired/non-owner)", async () => {
    const { controller, auditService } = makeController({
      apiKeyService: {
        reveal: jest.fn().mockRejectedValue(new NotFoundException()),
      },
    });
    await expect(
      controller.reveal(
        { id: 'k1', password: 'correct' } as any,
        user,
        workspace,
        reqAccess(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // No audit event on a failed reveal.
    expect(auditService.log).not.toHaveBeenCalled();
  });
});

describe('ApiKeyController — list scoping', () => {
  it('admin (Manage on API) lists ALL workspace keys', async () => {
    const { controller, apiKeyRepo } = makeController({ canManage: true });
    await controller.list(user, workspace, reqAccess());
    expect(apiKeyRepo.findAllInWorkspace).toHaveBeenCalledWith('ws-1');
    expect(apiKeyRepo.findByCreator).not.toHaveBeenCalled();
  });

  it('member lists ONLY their own keys', async () => {
    const { controller, apiKeyRepo } = makeController({ canManage: false });
    await controller.list(user, workspace, reqAccess());
    expect(apiKeyRepo.findByCreator).toHaveBeenCalledWith('u-1', 'ws-1');
    expect(apiKeyRepo.findAllInWorkspace).not.toHaveBeenCalled();
  });
});

describe('ApiKeyController — revoke scoping', () => {
  it("member cannot revoke another user's key (403)", async () => {
    const { controller, apiKeyRepo, apiKeyService } = makeController({
      canManage: false,
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'k1',
      creatorId: 'someone-else',
      workspaceId: 'ws-1',
    });
    await expect(
      controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(apiKeyService.revoke).not.toHaveBeenCalled();
  });

  it('member CAN revoke their own key', async () => {
    const { controller, apiKeyRepo, apiKeyService } = makeController({
      canManage: false,
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'k1',
      creatorId: 'u-1',
      workspaceId: 'ws-1',
    });
    await controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess());
    expect(apiKeyService.revoke).toHaveBeenCalledWith('k1', 'ws-1');
  });

  it("admin CAN revoke another user's key", async () => {
    const { controller, apiKeyRepo, apiKeyService } = makeController({
      canManage: true,
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'k1',
      creatorId: 'someone-else',
      workspaceId: 'ws-1',
    });
    await controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess());
    expect(apiKeyService.revoke).toHaveBeenCalledWith('k1', 'ws-1');
  });

  it('404 when the key does not exist', async () => {
    const { controller, apiKeyRepo } = makeController({ canManage: true });
    apiKeyRepo.findById.mockResolvedValue(undefined);
    await expect(
      controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ApiKeyController — create emits audit + returns token once', () => {
  it('logs API_KEY_CREATED and returns the token + computed expiry', async () => {
    const { controller, auditService } = makeController();
    const res = await controller.create(
      { name: 'ci' } as any,
      user,
      reqAccess(),
    );
    expect(res.token).toBe('tok');
    expect(res.apiKey).toMatchObject({ id: 'k1', name: 'n' });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'api_key.created' }),
    );
  });
});

// Sanity: the CASL subject used is the workspace API subject.
it('uses WorkspaceCaslSubject.API with the Manage action', () => {
  expect(WorkspaceCaslSubject.API).toBe('api_key');
  expect(WorkspaceCaslAction.Manage).toBeDefined();
});
