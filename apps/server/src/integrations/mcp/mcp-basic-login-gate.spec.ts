import { UnauthorizedException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// These tests exercise the REAL McpService.enforceBasicLoginGate (the pre-token
// SSO/MFA gate on the /mcp HTTP-Basic path). Unlike the resolveMcpSessionConfig
// tests in mcp.service.spec.ts — which STUB the gate and only assert it runs
// before login()/verifyCredentials — here the gate logic is instantiated for
// real and only its LEAF dependencies are mocked:
//   - the workspace object (plain object with/without enforceSso),
//   - the user credentials (plain object),
//   - the lazily-required EE MFA module (jest.mock with { virtual: true } so we
//     can simulate BOTH "bundled" and "not bundled" community-build states),
//   - the injected MfaService instance (via a stub moduleRef).
//
// McpService cannot normally be imported under jest because it imports
// AuthService, which drags in the React email-template graph
// (@docmost/transactional/emails/*) that the jest moduleNameMapper does not
// resolve. We therefore mock the heavy collaborator modules (auth.service,
// token.service, the @docmost/db repos and mcp-auth.helpers) at the module
// level so importing mcp.service.ts succeeds. None of those are touched by the
// gate itself, so the gate runs unmodified against the real code path.
// ---------------------------------------------------------------------------

// The EE MFA module specifier the jest.mock below intercepts MUST be
// byte-for-byte the specifier that mcp.service.ts lazily require()s
// ('./../../ee/mfa/services/mfa.service'). jest.mock is hoisted above all
// non-hoisted code, so the path is inlined as a literal in the call below
// rather than referenced through a const (which would not yet be initialised).
// `{ virtual: true }` is required because the EE module does not exist in this
// OSS build (there is no src/ee directory) — without it jest cannot register a
// mock for a path it cannot resolve on disk.

// Mutable handle the virtual mock factory reads, so each test can decide whether
// the EE module is "bundled" (factory returns a MfaService class) or "not
// bundled" (factory throws, mimicking the require() failing on a community
// build). jest.mock is hoisted, so the factory must close over this lazily.
let mfaModuleState: { bundled: boolean; checkMfaRequirements?: jest.Mock } = {
  bundled: false,
};

jest.mock(
  './../../ee/mfa/services/mfa.service',
  () => {
    if (!mfaModuleState.bundled) {
      // Simulate a community/fork build with no EE MFA module: the real
      // require() throws, which the gate catches as the "no MFA gate" path.
      throw new Error('Cannot find module (EE MFA not bundled)');
    }
    // "Bundled" build: expose a MfaService class token. The actual instance the
    // gate calls is resolved through moduleRef.get(MfaModule.MfaService), which
    // our stub moduleRef returns regardless of the token identity.
    class MfaService {}
    return { MfaService };
  },
  { virtual: true },
);

// --- Mock the heavy collaborator modules so importing mcp.service succeeds. ---
// The gate never calls into these; they exist only to satisfy the import graph.
jest.mock('../../core/auth/services/auth.service', () => ({
  AuthService: class AuthService {},
}));
jest.mock('../../core/auth/services/token.service', () => ({
  TokenService: class TokenService {},
}));
jest.mock('@docmost/db/repos/workspace/workspace.repo', () => ({
  WorkspaceRepo: class WorkspaceRepo {},
}));
jest.mock('@docmost/db/repos/user/user.repo', () => ({
  UserRepo: class UserRepo {},
}));
jest.mock('@docmost/db/repos/session/user-session.repo', () => ({
  UserSessionRepo: class UserSessionRepo {},
}));
// mcp-auth.helpers exports runtime values the gate relies on (decideBasicGate,
// mapAuthResultToResponse, etc.). Keep the REAL helpers so the gate exercises
// real logic; only stub FailedLoginLimiter so its constructor runs without a
// real sweep timer. The module is framework-free and loads cleanly under jest
// (mcp.service.spec.ts already imports it directly), so requireActual is safe.
jest.mock('./mcp-auth.helpers', () => {
  const actual = jest.requireActual('./mcp-auth.helpers');
  return {
    ...actual,
    FailedLoginLimiter: class FailedLoginLimiter {
      sweep() {}
    },
  };
});

// Import AFTER the mocks are registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { McpService } from './mcp.service';

type GateCreds = { email: string; password: string };

// Build an McpService instance with stubbed constructor deps. We never call the
// auth/db collaborators from the gate, so undefined stand-ins are fine for all
// but moduleRef, which the MFA branch reads.
function makeService(opts: {
  checkMfaRequirements?: jest.Mock;
}): { service: McpService; gate: (ws: unknown, creds: GateCreds) => Promise<void> } {
  // Stub moduleRef.get -> returns an object whose checkMfaRequirements is the
  // provided mock. The gate calls moduleRef.get(MfaModule.MfaService).
  const moduleRef = {
    get: jest.fn().mockReturnValue({
      checkMfaRequirements:
        opts.checkMfaRequirements ?? jest.fn().mockResolvedValue(undefined),
    }),
  };

  const service = new McpService(
    undefined as never, // workspaceRepo
    undefined as never, // authService
    undefined as never, // tokenService
    undefined as never, // userRepo
    undefined as never, // userSessionRepo
    moduleRef as never, // moduleRef (read by the MFA branch)
    undefined as never, // sandboxStore (unused by the login-gate path)
  );
  // Stop the constructor's unref'd sweep timer leaking across tests.
  service.onModuleDestroy();

  // enforceBasicLoginGate is private; reach it through the instance. Calling the
  // REAL method (not a stub) is the whole point of this suite.
  const gate = (
    service as unknown as {
      enforceBasicLoginGate: (ws: unknown, creds: GateCreds) => Promise<void>;
    }
  ).enforceBasicLoginGate.bind(service);

  return { service, gate };
}

const CREDS: GateCreds = { email: 'user@example.com', password: 'pw' };

describe('McpService.enforceBasicLoginGate (REAL gate, leaf deps mocked)', () => {
  beforeEach(() => {
    // Reset to the community-build default (no EE module) before each test.
    mfaModuleState = { bundled: false };
    jest.clearAllMocks();
  });

  describe('SSO enforcement (validateSsoEnforcement)', () => {
    it('rejects with Unauthorized when the workspace enforces SSO, before any MFA/login', async () => {
      const { gate } = makeService({});
      const workspace = { id: 'ws-1', enforceSso: true };

      await expect(gate(workspace, CREDS)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // The /mcp 401 surfaces an SSO-specific message (not a generic MCP error).
      await expect(gate(workspace, CREDS)).rejects.toThrow(/enforced SSO/i);
    });

    it('does NOT consult the MFA module when SSO is enforced (gate short-circuits)', async () => {
      // Even if the EE module WERE bundled, the SSO branch throws first, so the
      // moduleRef MFA lookup must never run.
      mfaModuleState = {
        bundled: true,
        checkMfaRequirements: jest.fn(),
      };
      const { service, gate } = makeService({
        checkMfaRequirements: mfaModuleState.checkMfaRequirements,
      });
      const moduleRefGet = (
        service as unknown as { moduleRef: { get: jest.Mock } }
      ).moduleRef.get;

      await expect(
        gate({ id: 'ws-1', enforceSso: true }, CREDS),
      ).rejects.toThrow(/enforced SSO/i);
      // The SSO branch fired before the MFA require/lookup.
      expect(moduleRefGet).not.toHaveBeenCalled();
      expect(mfaModuleState.checkMfaRequirements).not.toHaveBeenCalled();
    });
  });

  describe('community build: EE MFA module NOT bundled', () => {
    it('passes (no throw) when SSO is not enforced and the lazy require fails (no MFA gate)', async () => {
      // mfaModuleState.bundled === false -> the virtual mock factory throws,
      // exactly like require() of a missing EE module on a community build.
      const { service, gate } = makeService({});
      const moduleRefGet = (
        service as unknown as { moduleRef: { get: jest.Mock } }
      ).moduleRef.get;

      await expect(
        gate({ id: 'ws-1', enforceSso: false }, CREDS),
      ).resolves.toBeUndefined();
      // The require() failed, so the gate returned before touching moduleRef.
      expect(moduleRefGet).not.toHaveBeenCalled();
    });
  });

  describe('EE MFA module bundled', () => {
    it('rejects with a "use a Bearer token" signal when the user has MFA enabled', async () => {
      const check = jest.fn().mockResolvedValue({
        userHasMfa: true,
        requiresMfaSetup: false,
      });
      mfaModuleState = { bundled: true, checkMfaRequirements: check };
      const { gate } = makeService({ checkMfaRequirements: check });

      const promise = gate({ id: 'ws-1', enforceSso: false }, CREDS);
      await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        gate({ id: 'ws-1', enforceSso: false }, CREDS),
      ).rejects.toThrow(/Bearer access token/i);
      // The real requirement check was consulted with the creds + workspace.
      expect(check).toHaveBeenCalledWith(
        CREDS,
        { id: 'ws-1', enforceSso: false },
        undefined,
      );
    });

    it('rejects when the workspace enforces MFA (requiresMfaSetup)', async () => {
      // requiresMfaSetup === true models a workspace that enforces MFA for a
      // user who has not set it up yet; the Basic path cannot complete it.
      const check = jest.fn().mockResolvedValue({
        userHasMfa: false,
        requiresMfaSetup: true,
      });
      mfaModuleState = { bundled: true, checkMfaRequirements: check };
      const { gate } = makeService({ checkMfaRequirements: check });

      await expect(
        gate({ id: 'ws-1', enforceSso: false }, CREDS),
      ).rejects.toThrow(/Bearer access token/i);
    });

    it('passes when the user has no MFA and the workspace does not enforce it', async () => {
      const check = jest.fn().mockResolvedValue({
        userHasMfa: false,
        requiresMfaSetup: false,
      });
      mfaModuleState = { bundled: true, checkMfaRequirements: check };
      const { gate } = makeService({ checkMfaRequirements: check });

      await expect(
        gate({ id: 'ws-1', enforceSso: false }, CREDS),
      ).resolves.toBeUndefined();
      // The bundled module's requirement check WAS consulted (proving we took
      // the bundled branch, not the community no-op branch).
      expect(check).toHaveBeenCalledTimes(1);
    });

    it('passes when checkMfaRequirements returns a falsy result (no requirement flags)', async () => {
      // Defensive: a bundled module that returns undefined must not reject.
      const check = jest.fn().mockResolvedValue(undefined);
      mfaModuleState = { bundled: true, checkMfaRequirements: check };
      const { gate } = makeService({ checkMfaRequirements: check });

      await expect(
        gate({ id: 'ws-1', enforceSso: false }, CREDS),
      ).resolves.toBeUndefined();
    });
  });
});
