import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CREDENTIALS_MISMATCH_MESSAGE } from '../auth.constants';
import { hashPassword } from '../../../common/helpers';

/**
 * LIVE security contract for AuthService.verifyUserCredentials / login (M4
 * item 5).
 *
 * The (now-fixed) jest config CAN import AuthService at the module level (the
 * `^src/(.*)$` moduleNameMapper resolves the transitive `src/...` imports and the
 * ts-jest transform loads the graph). AuthService cannot be `.compile()`-d via
 * the Nest TestingModule (its full provider graph is not wired here), but it can
 * be constructed directly with mocked collaborators — which is exactly what we
 * need to exercise the credential-check decision live.
 *
 * The load-bearing property: verifyUserCredentials (and login(), which reuses it)
 * throws EXACTLY the shared CREDENTIALS_MISMATCH_MESSAGE for all three
 * credentials-failure cases — unknown email, disabled user, wrong password. The
 * /mcp Basic brute-force limiter only counts a failure when it recognises THIS
 * exact message (isCredentialsFailure in mcp-auth.helpers matches the same shared
 * constant); a reword that diverged here would silently turn /mcp Basic into an
 * unthrottled password-guessing oracle.
 */

const WORKSPACE_ID = 'ws-1';

// Build an AuthService with the dependencies verifyUserCredentials/login touch
// stubbed, and a userRepo whose findByEmail is overridable per test. Only the
// collaborators actually reached on these paths need real behaviour; the rest
// are inert mocks (constructor wiring only).
function makeAuthService(over: {
  findByEmail?: jest.Mock;
} = {}): {
  service: AuthService;
  userRepo: { findByEmail: jest.Mock; updateLastLogin: jest.Mock };
  sessionService: { createSessionAndToken: jest.Mock };
  auditService: { log: jest.Mock };
} {
  const userRepo = {
    findByEmail: over.findByEmail ?? jest.fn(),
    updateLastLogin: jest.fn().mockResolvedValue(undefined),
  };
  const sessionService = {
    createSessionAndToken: jest.fn().mockResolvedValue('issued-token'),
  };
  const auditService = { log: jest.fn() };
  // environmentService: isCloud() false (so throwIfEmailNotVerified does not
  // require verification) + a stable app secret.
  const environmentService = {
    isCloud: jest.fn().mockReturnValue(false),
    getAppSecret: jest.fn().mockReturnValue('test-secret'),
  };

  // Constructor signature (auth.service.ts): signupService, tokenService,
  // sessionService, userSessionRepo, userRepo, userTokenRepo, mailService,
  // domainService, environmentService, db, auditService.
  const service = new (AuthService as unknown as new (...args: unknown[]) => AuthService)(
    {}, // signupService
    {}, // tokenService
    sessionService, // sessionService
    {}, // userSessionRepo
    userRepo, // userRepo
    {}, // userTokenRepo
    {}, // mailService
    {}, // domainService
    environmentService, // environmentService
    {}, // db
    auditService, // auditService
  );

  return { service, userRepo, sessionService, auditService };
}

describe('AuthService.verifyUserCredentials (live credentials-mismatch contract)', () => {
  it('UNKNOWN email -> throws exactly CREDENTIALS_MISMATCH_MESSAGE', async () => {
    const { service } = makeAuthService({
      findByEmail: jest.fn().mockResolvedValue(undefined),
    });

    await expect(
      service.verifyUserCredentials(
        { email: 'nobody@example.com', password: 'whatever' },
        WORKSPACE_ID,
      ),
    ).rejects.toMatchObject({ message: CREDENTIALS_MISMATCH_MESSAGE });
    await expect(
      service.verifyUserCredentials(
        { email: 'nobody@example.com', password: 'whatever' },
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('DISABLED user -> throws exactly CREDENTIALS_MISMATCH_MESSAGE (no password oracle)', async () => {
    // A deactivated user must be indistinguishable from a wrong password: same
    // message, before any password comparison.
    const passwordHash = await hashPassword('correct-horse');
    const disabledUser = {
      id: 'u-1',
      email: 'disabled@example.com',
      password: passwordHash,
      deactivatedAt: new Date(),
      deletedAt: null,
      emailVerifiedAt: new Date(),
    };
    const { service } = makeAuthService({
      findByEmail: jest.fn().mockResolvedValue(disabledUser),
    });

    await expect(
      service.verifyUserCredentials(
        { email: 'disabled@example.com', password: 'correct-horse' },
        WORKSPACE_ID,
      ),
    ).rejects.toMatchObject({ message: CREDENTIALS_MISMATCH_MESSAGE });
  });

  it('WRONG password -> throws exactly CREDENTIALS_MISMATCH_MESSAGE', async () => {
    const passwordHash = await hashPassword('correct-horse');
    const user = {
      id: 'u-1',
      email: 'user@example.com',
      password: passwordHash,
      deactivatedAt: null,
      deletedAt: null,
      emailVerifiedAt: new Date(),
    };
    const { service } = makeAuthService({
      findByEmail: jest.fn().mockResolvedValue(user),
    });

    await expect(
      service.verifyUserCredentials(
        { email: 'user@example.com', password: 'wrong-password' },
        WORKSPACE_ID,
      ),
    ).rejects.toMatchObject({ message: CREDENTIALS_MISMATCH_MESSAGE });
  });

  it('CORRECT credentials -> resolves the matched user (no side effects here)', async () => {
    const passwordHash = await hashPassword('correct-horse');
    const user = {
      id: 'u-1',
      email: 'user@example.com',
      password: passwordHash,
      deactivatedAt: null,
      deletedAt: null,
      emailVerifiedAt: new Date(),
    };
    const { service, sessionService, auditService, userRepo } =
      makeAuthService({ findByEmail: jest.fn().mockResolvedValue(user) });

    const result = await service.verifyUserCredentials(
      { email: 'user@example.com', password: 'correct-horse' },
      WORKSPACE_ID,
    );
    expect(result).toBe(user);
    // verifyUserCredentials is non-side-effecting: no session/audit/lastLogin.
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
    expect(userRepo.updateLastLogin).not.toHaveBeenCalled();
  });
});

describe('AuthService.login (live credentials-mismatch contract via verifyUserCredentials)', () => {
  it('UNKNOWN email -> login throws exactly CREDENTIALS_MISMATCH_MESSAGE, mints NO session', async () => {
    const { service, sessionService } = makeAuthService({
      findByEmail: jest.fn().mockResolvedValue(undefined),
    });

    await expect(
      service.login(
        { email: 'nobody@example.com', password: 'whatever' },
        WORKSPACE_ID,
      ),
    ).rejects.toMatchObject({ message: CREDENTIALS_MISMATCH_MESSAGE });
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('WRONG password -> login throws exactly CREDENTIALS_MISMATCH_MESSAGE', async () => {
    const passwordHash = await hashPassword('correct-horse');
    const user = {
      id: 'u-1',
      email: 'user@example.com',
      password: passwordHash,
      deactivatedAt: null,
      deletedAt: null,
      emailVerifiedAt: new Date(),
    };
    const { service } = makeAuthService({
      findByEmail: jest.fn().mockResolvedValue(user),
    });

    await expect(
      service.login(
        { email: 'user@example.com', password: 'wrong-password' },
        WORKSPACE_ID,
      ),
    ).rejects.toMatchObject({ message: CREDENTIALS_MISMATCH_MESSAGE });
  });

  it('CORRECT credentials -> login mints the session (the side-effecting path)', async () => {
    const passwordHash = await hashPassword('correct-horse');
    const user = {
      id: 'u-1',
      email: 'user@example.com',
      password: passwordHash,
      deactivatedAt: null,
      deletedAt: null,
      emailVerifiedAt: new Date(),
    };
    const { service, sessionService, auditService, userRepo } =
      makeAuthService({ findByEmail: jest.fn().mockResolvedValue(user) });

    await expect(
      service.login(
        { email: 'user@example.com', password: 'correct-horse' },
        WORKSPACE_ID,
      ),
    ).resolves.toBe('issued-token');
    // login() reuses verifyUserCredentials but DOES run the three side effects.
    expect(userRepo.updateLastLogin).toHaveBeenCalledWith('u-1', WORKSPACE_ID);
    expect(auditService.log).toHaveBeenCalled();
    expect(sessionService.createSessionAndToken).toHaveBeenCalledWith(user);
  });

  it('the message login throws is the SAME shared constant the /mcp limiter matches', () => {
    // Cross-file coupling lock: the constant is the single source of truth shared
    // by AuthService and mcp-auth.helpers.isCredentialsFailure.
    expect(CREDENTIALS_MISMATCH_MESSAGE).toBe('Email or password does not match');
  });
});
