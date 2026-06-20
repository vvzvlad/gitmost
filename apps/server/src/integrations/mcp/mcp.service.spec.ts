import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  parseBasicAuth,
  FailedLoginLimiter,
  resolveMcpSessionConfig,
  isCredentialsFailure,
  isInitializeRequestBody,
  verifyBearerAccess,
  sharedTokenMatches,
  clientIp,
  bindAccessJwtVerifier,
  extractBearer,
  decideBasicGate,
  mapAuthResultToResponse,
  McpAuthDeps,
} from './mcp-auth.helpers';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { CREDENTIALS_MISMATCH_MESSAGE } from '../../core/auth/auth.constants';

// The /mcp per-user auth decision logic is tested through the framework-free
// `resolveMcpSessionConfig` helper that McpService delegates to. McpService
// itself cannot be instantiated under jest because importing AuthService drags
// in the React email templates + queue constants graph; extracting the pure
// logic (and wiring it in) keeps it both tested AND used (per the plan).

function basicHeader(email: string, password: string): string {
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

function makeDeps(over: Partial<McpAuthDeps> = {}): McpAuthDeps {
  return {
    apiUrl: 'http://127.0.0.1:3000/api',
    email: over.email,
    password: over.password,
    findWorkspace:
      over.findWorkspace ?? jest.fn().mockResolvedValue({ id: 'ws-1' }),
    login: over.login ?? jest.fn().mockResolvedValue('issued-user-jwt'),
    verifyCredentials:
      over.verifyCredentials ?? jest.fn().mockResolvedValue(undefined),
    verifyAccessJwt:
      over.verifyAccessJwt ??
      jest.fn().mockResolvedValue({ sub: 'user-1', email: 'u@e.com' }),
    // Default gate is a no-op (pass-through), matching a build with no SSO
    // enforcement and no EE MFA module. Individual tests override it to assert
    // the SSO/MFA reject behaviour.
    enforceBasicGate: over.enforceBasicGate,
    limiter: over.limiter ?? new FailedLoginLimiter(5, 60_000),
    clientIp: over.clientIp ?? '10.0.0.1',
    // Default to the session-INIT request (no mcp-session-id) so existing
    // assertions about login() being called keep their meaning.
    isSessionInit: over.isSessionInit ?? true,
  };
}

describe('parseBasicAuth', () => {
  it('decodes email:password', () => {
    expect(parseBasicAuth(basicHeader('a@b.com', 'pw'))).toEqual({
      email: 'a@b.com',
      password: 'pw',
    });
  });

  it('splits on the FIRST colon so passwords may contain colons', () => {
    expect(parseBasicAuth(basicHeader('a@b.com', 'p:w:x'))).toEqual({
      email: 'a@b.com',
      password: 'p:w:x',
    });
  });

  it('returns null for non-Basic / malformed headers', () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth('Bearer xyz')).toBeNull();
    expect(
      parseBasicAuth('Basic ' + Buffer.from('nocolon').toString('base64')),
    ).toBeNull();
  });

  it('returns null when the email part is empty (":password")', () => {
    expect(
      parseBasicAuth('Basic ' + Buffer.from(':pw').toString('base64')),
    ).toBeNull();
  });
});

describe('extractBearer', () => {
  it('extracts the token from a "Bearer <token>" header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme (lowercase + uppercase)', () => {
    // The split keeps the token as-is; only the scheme is compared lowercased.
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('BEARER abc')).toBe('abc');
  });

  it('returns undefined for a non-Bearer scheme (e.g. Basic)', () => {
    expect(extractBearer('Basic abc')).toBeUndefined();
  });

  it('returns undefined for an undefined header', () => {
    expect(extractBearer(undefined)).toBeUndefined();
  });
});

describe('isCredentialsFailure', () => {
  it('is true for the credentials-mismatch UnauthorizedException', () => {
    expect(
      isCredentialsFailure(
        new UnauthorizedException('Email or password does not match'),
      ),
    ).toBe(true);
  });

  it('is false for business errors like email-not-verified', () => {
    expect(
      isCredentialsFailure(
        new BadRequestException('Please verify your email address.'),
      ),
    ).toBe(false);
    expect(isCredentialsFailure(new Error('boom'))).toBe(false);
  });

  // --- Cross-file coupling lock (item 1) ---------------------------------
  // The /mcp Basic brute-force limiter ONLY counts a failure when
  // isCredentialsFailure(err) is true. AuthService.verifyUserCredentials throws
  // the credentials failure with the shared CREDENTIALS_MISMATCH_MESSAGE for
  // unknown email / wrong password / disabled user. If that message were
  // reworded without updating the matcher, the limiter would stop counting and
  // /mcp Basic would become an unthrottled password-guessing oracle. These
  // tests lock the coupling to the SHARED constant (single source of truth) so a
  // reword is a compile-time/test-time break, not a silent security regression.

  it('recognises the exact UnauthorizedException AuthService throws (the shared constant)', () => {
    // Reconstruct the EXACT exception AuthService.verifyUserCredentials throws
    // for every credentials-failure case (it uses CREDENTIALS_MISMATCH_MESSAGE),
    // and assert the REAL isCredentialsFailure recognises it. No hardcoded string
    // is duplicated here — both sides reference the single shared constant.
    const authThrows = new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE);
    expect(isCredentialsFailure(authThrows)).toBe(true);
  });

  it('the matcher is coupled to the single source of truth, not a local literal', () => {
    // If someone reworded CREDENTIALS_MISMATCH_MESSAGE, this still passes only
    // because the matcher derives its substring from the SAME constant. This
    // pins the coupling structurally: there is one message both files share.
    expect(CREDENTIALS_MISMATCH_MESSAGE).toBeTruthy();
    expect(
      isCredentialsFailure(
        new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE),
      ),
    ).toBe(true);
    // A DIFFERENT message (a hypothetical reword that forgot to go through the
    // constant) must NOT be silently recognised, proving the matcher is not just
    // "always true".
    expect(
      isCredentialsFailure(new UnauthorizedException('totally different wording')),
    ).toBe(false);
  });
});

describe('AuthService verifyUserCredentials <-> isCredentialsFailure coupling (item 1)', () => {
  // AuthService cannot be constructed under jest: importing it pulls in
  // src/integrations/queue/constants (a `src/`-rooted absolute import) which the
  // jest moduleNameMapper does not resolve under rootDir:src — the heavy auth
  // graph. So instead of a live AuthService unit, we assert the security
  // contract structurally: AuthService.verifyUserCredentials throws an
  // UnauthorizedException built from the SHARED CREDENTIALS_MISMATCH_MESSAGE
  // (see auth.service.ts), and the REAL isCredentialsFailure recognises it. The
  // single shared constant is the lock: there is no second copy of the string to
  // drift out of sync.
  it('the credentials-failure UnauthorizedException is counted by the limiter matcher', () => {
    // unknown email / disabled user / wrong password all surface as this:
    const credentialsFailure = new UnauthorizedException(
      CREDENTIALS_MISMATCH_MESSAGE,
    );
    expect(isCredentialsFailure(credentialsFailure)).toBe(true);
  });

  it('email-not-verified (a different, business error) is NOT counted', () => {
    // throwIfEmailNotVerified throws a BadRequestException, which must not burn a
    // victim's limiter budget; the matcher rejects it.
    expect(
      isCredentialsFailure(
        new BadRequestException('Please verify your email address.'),
      ),
    ).toBe(false);
  });
});

describe('FailedLoginLimiter', () => {
  it('blocks after threshold failures within the window; reset clears it', () => {
    const lim = new FailedLoginLimiter(3, 1000);
    const k = 'ip:1.2.3.4';
    expect(lim.isBlocked(k, 0)).toBe(false);
    lim.recordFailure(k, 0);
    lim.recordFailure(k, 0);
    expect(lim.isBlocked(k, 0)).toBe(false);
    lim.recordFailure(k, 0);
    expect(lim.isBlocked(k, 0)).toBe(true);
    lim.reset(k);
    expect(lim.isBlocked(k, 0)).toBe(false);
  });

  it('rolls over after the window', () => {
    const lim = new FailedLoginLimiter(1, 1000);
    const k = 'ip:1.2.3.4';
    lim.recordFailure(k, 0);
    expect(lim.isBlocked(k, 0)).toBe(true);
    expect(lim.isBlocked(k, 1000)).toBe(false);
  });

  describe('sweep (expired-bucket eviction, injectable clock)', () => {
    // sweep() drops buckets whose windowStart is older than windowMs so
    // never-revisited keys cannot accumulate forever. It takes an injectable
    // `now` so the behaviour is deterministic without faking timers.
    it('drops a bucket strictly older than windowMs', () => {
      const lim = new FailedLoginLimiter(5, 1000);
      // Seed a bucket at t=0 (windowStart=0).
      lim.recordFailure('stale', 0);
      // Sweep well past the window: now - windowStart = 5000 >= 1000 -> dropped.
      lim.sweep(5000);
      // A dropped bucket means a brand-new bucket is created on next touch, so
      // the prior failure count is gone (a single fresh failure is far from 5).
      lim.recordFailure('stale', 5001);
      expect(lim.isBlocked('stale', 5001)).toBe(false);
    });

    it('drops a bucket exactly at the windowMs boundary (>= is inclusive)', () => {
      const lim = new FailedLoginLimiter(1, 1000);
      lim.recordFailure('boundary', 0); // windowStart=0, blocked at threshold 1
      expect(lim.isBlocked('boundary', 0)).toBe(true);
      // now - windowStart = 1000 == windowMs -> the >= check evicts it.
      lim.sweep(1000);
      // Re-touch at the same instant: a fresh bucket (count 0) is created, so the
      // key is no longer blocked, proving the boundary bucket was swept.
      expect(lim.isBlocked('boundary', 1000)).toBe(false);
    });

    it('retains a fresh bucket still within the window', () => {
      const lim = new FailedLoginLimiter(1, 1000);
      lim.recordFailure('fresh', 0); // windowStart=0
      // now - windowStart = 999 < 1000 -> the bucket survives the sweep.
      lim.sweep(999);
      // Still blocked because the bucket (and its count) was retained.
      expect(lim.isBlocked('fresh', 999)).toBe(true);
    });
  });
});

describe('verifyBearerAccess (Bearer revocation/disabled checks)', () => {
  const goodPayload = {
    sub: 'user-1',
    email: 'u@e.com',
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
  };

  function bearerDeps(over: Partial<Parameters<typeof verifyBearerAccess>[1]> = {}) {
    return {
      verifyJwt: over.verifyJwt ?? jest.fn().mockResolvedValue(goodPayload),
      findUser:
        over.findUser ?? jest.fn().mockResolvedValue({ deactivatedAt: null }),
      findActiveSession:
        over.findActiveSession ??
        jest
          .fn()
          .mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1' }),
    };
  }

  it('valid token + active session + enabled user -> resolves identity', async () => {
    const res = await verifyBearerAccess('t', bearerDeps());
    expect(res).toEqual({ sub: 'user-1', email: 'u@e.com' });
  });

  it('rejects when the session is no longer active (logged out / revoked)', async () => {
    await expect(
      verifyBearerAccess(
        't',
        bearerDeps({ findActiveSession: jest.fn().mockResolvedValue(undefined) }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the session belongs to a different user', async () => {
    await expect(
      verifyBearerAccess(
        't',
        bearerDeps({
          findActiveSession: jest
            .fn()
            .mockResolvedValue({ userId: 'other', workspaceId: 'ws-1' }),
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the user is disabled (deactivated/deleted)', async () => {
    await expect(
      verifyBearerAccess(
        't',
        bearerDeps({
          findUser: jest.fn().mockResolvedValue({ deactivatedAt: new Date() }),
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      verifyBearerAccess(
        't',
        bearerDeps({ findUser: jest.fn().mockResolvedValue(undefined) }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('propagates a verifyJwt failure (bad signature/exp/type)', async () => {
    await expect(
      verifyBearerAccess(
        't',
        bearerDeps({
          verifyJwt: jest
            .fn()
            .mockRejectedValue(new UnauthorizedException('jwt expired')),
        }),
      ),
    ).rejects.toThrow('jwt expired');
  });
});

describe('resolveMcpSessionConfig', () => {
  it('Basic good creds -> calls login with the default workspace, returns a getToken config', async () => {
    const login = jest.fn().mockResolvedValue('issued-user-jwt');
    const findWorkspace = jest.fn().mockResolvedValue({ id: 'ws-1' });
    const resolved = await resolveMcpSessionConfig(
      basicHeader('user@example.com', 'pw'),
      makeDeps({ login, findWorkspace }),
    );
    expect(findWorkspace).toHaveBeenCalled();
    expect(login).toHaveBeenCalledWith(
      { email: 'user@example.com', password: 'pw' },
      'ws-1',
    );
    expect('getToken' in resolved.config).toBe(true);
    const cfg = resolved.config as { getToken: () => Promise<string> };
    await expect(cfg.getToken()).resolves.toBe('issued-user-jwt');
    expect(resolved.identity).toBe('basic:user@example.com');
  });

  it('Basic password containing a colon is split on the first colon', async () => {
    const login = jest.fn().mockResolvedValue('jwt');
    await resolveMcpSessionConfig(
      basicHeader('user@example.com', 'a:b:c'),
      makeDeps({ login }),
    );
    expect(login).toHaveBeenCalledWith(
      { email: 'user@example.com', password: 'a:b:c' },
      'ws-1',
    );
  });

  it('Basic bad creds -> specific 401 (not generic) and increments the limiter', async () => {
    const limiter = new FailedLoginLimiter(5, 60_000);
    const login = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException('Email or password does not match'),
      );
    const deps = makeDeps({ login, limiter });

    await expect(
      resolveMcpSessionConfig(basicHeader('user@example.com', 'wrong'), deps),
    ).rejects.toThrow('Email or password does not match');
    // The failure was recorded; drive to the threshold (5) -> throttled message.
    for (let i = 0; i < 4; i++) {
      await resolveMcpSessionConfig(
        basicHeader('user@example.com', 'wrong'),
        deps,
      ).catch(() => undefined);
    }
    await expect(
      resolveMcpSessionConfig(basicHeader('user@example.com', 'wrong'), deps),
    ).rejects.toThrow(/Too many failed MCP login attempts/);
  });

  it('Bearer -> verifies as ACCESS and returns a getToken config', async () => {
    const verifyAccessJwt = jest
      .fn()
      .mockResolvedValue({ sub: 'user-9', email: 'u@e.com' });
    const resolved = await resolveMcpSessionConfig(
      'Bearer some.jwt.value',
      makeDeps({ verifyAccessJwt }),
    );
    expect(verifyAccessJwt).toHaveBeenCalledWith('some.jwt.value');
    const cfg = resolved.config as { getToken: () => Promise<string> };
    await expect(cfg.getToken()).resolves.toBe('some.jwt.value');
    expect(resolved.identity).toBe('bearer:user-9');
  });

  it('Bearer invalid -> specific 401 from verifyAccessJwt', async () => {
    const verifyAccessJwt = jest
      .fn()
      .mockRejectedValue(new UnauthorizedException('jwt expired'));
    await expect(
      resolveMcpSessionConfig('Bearer expired', makeDeps({ verifyAccessJwt })),
    ).rejects.toThrow('jwt expired');
  });

  it('no creds + env service account configured -> service-account config', async () => {
    const resolved = await resolveMcpSessionConfig(
      undefined,
      makeDeps({ email: 'svc@example.com', password: 'svcpw' }),
    );
    expect('email' in resolved.config).toBe(true);
    const cfg = resolved.config as { email: string; password: string };
    expect(cfg.email).toBe('svc@example.com');
    expect(cfg.password).toBe('svcpw');
    expect(resolved.identity).toBe('service-account');
  });

  it('no creds + no env service account -> meaningful 401 listing accepted methods', async () => {
    await expect(
      resolveMcpSessionConfig(undefined, makeDeps()),
    ).rejects.toThrow(/HTTP Basic auth.*Bearer access token.*service account/s);
  });

  it('SESSION INIT Basic -> mints a session via login() (verifyCredentials NOT called)', async () => {
    const login = jest.fn().mockResolvedValue('issued-user-jwt');
    const verifyCredentials = jest.fn().mockResolvedValue(undefined);
    const resolved = await resolveMcpSessionConfig(
      basicHeader('user@example.com', 'pw'),
      makeDeps({ login, verifyCredentials, isSessionInit: true }),
    );
    expect(login).toHaveBeenCalledTimes(1);
    expect(verifyCredentials).not.toHaveBeenCalled();
    const cfg = resolved.config as { getToken: () => Promise<string> };
    await expect(cfg.getToken()).resolves.toBe('issued-user-jwt');
    expect(resolved.identity).toBe('basic:user@example.com');
  });

  it('SUBSEQUENT Basic correct creds -> uses verifyCredentials, NEVER login() (no new session/audit), same identity', async () => {
    const login = jest.fn().mockResolvedValue('issued-user-jwt');
    const verifyCredentials = jest.fn().mockResolvedValue(undefined);
    const resolved = await resolveMcpSessionConfig(
      basicHeader('user@example.com', 'pw'),
      makeDeps({ login, verifyCredentials, isSessionInit: false }),
    );
    // The side-effecting login() (audit + lastLoginAt + user_sessions insert)
    // is NOT hit on a subsequent request: only the non-side-effecting verify.
    expect(login).not.toHaveBeenCalled();
    expect(verifyCredentials).toHaveBeenCalledWith(
      { email: 'user@example.com', password: 'pw' },
      'ws-1',
    );
    // Identity still matches the init identity so anti-fixation accepts it.
    expect(resolved.identity).toBe('basic:user@example.com');
  });

  it('SUBSEQUENT Basic wrong password -> still 401 (anti-fixation), without minting a session', async () => {
    const login = jest.fn().mockResolvedValue('issued-user-jwt');
    const verifyCredentials = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException('Email or password does not match'),
      );
    await expect(
      resolveMcpSessionConfig(
        basicHeader('user@example.com', 'wrong'),
        makeDeps({ login, verifyCredentials, isSessionInit: false }),
      ),
    ).rejects.toThrow('Email or password does not match');
    expect(login).not.toHaveBeenCalled();
  });

  it('global per-email limiter key blocks an attacker rotating IP/XFF for one account', async () => {
    const limiter = new FailedLoginLimiter(5, 60_000);
    const login = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException('Email or password does not match'),
      );
    // 5 failures against the SAME email but DIFFERENT IPs each time. The per-IP
    // and per-IP+email keys never accumulate, but the global per-email key does.
    for (let i = 0; i < 5; i++) {
      await resolveMcpSessionConfig(
        basicHeader('victim@example.com', 'wrong'),
        makeDeps({ login, limiter, clientIp: `10.0.0.${i}` }),
      ).catch(() => undefined);
    }
    // A 6th attempt from yet another fresh IP is now throttled purely by the
    // email key — proving IP/XFF rotation no longer evades the limiter.
    await expect(
      resolveMcpSessionConfig(
        basicHeader('victim@example.com', 'wrong'),
        makeDeps({ login, limiter, clientIp: '10.0.0.99' }),
      ),
    ).rejects.toThrow(/Too many failed MCP login attempts/);
  });

  it('limiter does NOT count business errors (email not verified) as a failed login', async () => {
    const limiter = new FailedLoginLimiter(1, 60_000);
    const login = jest
      .fn()
      .mockRejectedValue(
        new BadRequestException('Please verify your email address.'),
      );
    const deps = () =>
      makeDeps({ login, limiter, clientIp: '10.0.0.7' });
    // First attempt: business error, surfaced as 401, but must NOT increment.
    await resolveMcpSessionConfig(
      basicHeader('user@example.com', 'pw'),
      deps(),
    ).catch(() => undefined);
    // With threshold 1, if it had counted, the next attempt would be throttled.
    // Instead it should reach login() again (same business error, NOT throttle).
    await expect(
      resolveMcpSessionConfig(basicHeader('user@example.com', 'pw'), deps()),
    ).rejects.toThrow(/verify your email/);
  });

  it('anti-fixation: different users yield different identity keys (compared by the http identify hook)', async () => {
    const a = await resolveMcpSessionConfig(
      basicHeader('alice@example.com', 'pw'),
      makeDeps(),
    );
    const b = await resolveMcpSessionConfig(
      basicHeader('bob@example.com', 'pw'),
      makeDeps(),
    );
    expect(a.identity).toBe('basic:alice@example.com');
    expect(b.identity).toBe('basic:bob@example.com');
    expect(a.identity).not.toBe(b.identity);
  });

  // --- BLOCKER: SSO/MFA pre-token gate on the Basic path ---

  it('Basic rejected (no token) when the SSO/MFA gate throws (SSO enforced)', async () => {
    const login = jest.fn().mockResolvedValue('issued-user-jwt');
    const verifyCredentials = jest.fn().mockResolvedValue(undefined);
    // The service wires enforceBasicGate to validateSsoEnforcement + the lazy
    // MFA check. Here we stub it to throw as it would for an SSO-enforced
    // workspace; the gate runs BEFORE login()/verifyCredentials, so no token.
    const enforceBasicGate = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException('This workspace has enforced SSO login.'),
      );
    await expect(
      resolveMcpSessionConfig(
        basicHeader('user@example.com', 'pw'),
        makeDeps({ login, verifyCredentials, enforceBasicGate }),
      ),
    ).rejects.toThrow(/enforced SSO/);
    expect(enforceBasicGate).toHaveBeenCalledWith(
      { id: 'ws-1' },
      { email: 'user@example.com', password: 'pw' },
    );
    // The pre-token gate fired first: no token-minting login() and no
    // verifyCredentials() happened.
    expect(login).not.toHaveBeenCalled();
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it('Basic rejected with a "use a Bearer token" message when MFA is required', async () => {
    const login = jest.fn().mockResolvedValue('issued-user-jwt');
    // Mirror McpService.enforceBasicLoginGate when the EE MFA module is present
    // and the user has MFA: it throws telling the caller to use a Bearer token.
    const enforceBasicGate = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException(
          'This account requires multi-factor authentication. MCP HTTP Basic ' +
            'cannot complete MFA — log in normally and use a Bearer access token ' +
            'instead.',
        ),
      );
    await expect(
      resolveMcpSessionConfig(
        basicHeader('mfa-user@example.com', 'pw'),
        makeDeps({ login, enforceBasicGate }),
      ),
    ).rejects.toThrow(/use a Bearer access token/);
    expect(login).not.toHaveBeenCalled();
  });

  it('Bearer path is NOT subjected to the Basic SSO/MFA gate', async () => {
    // The gate is only consulted on the Basic branch. A Bearer token (minted
    // post-gate by the normal login) must not be blocked by it.
    const enforceBasicGate = jest.fn();
    const resolved = await resolveMcpSessionConfig(
      'Bearer some.jwt.value',
      makeDeps({ enforceBasicGate }),
    );
    expect(enforceBasicGate).not.toHaveBeenCalled();
    expect('getToken' in resolved.config).toBe(true);
  });

  it('a session-INIT login() success DOES reset the global per-email key', async () => {
    const limiter = new FailedLoginLimiter(5, 60_000);
    // Pre-load some failure budget on the global email key.
    const emailKey = 'email:victim@example.com';
    limiter.recordFailure(emailKey);
    limiter.recordFailure(emailKey);
    await resolveMcpSessionConfig(
      basicHeader('victim@example.com', 'pw'),
      makeDeps({ limiter, isSessionInit: true }),
    );
    // After a real init login, the deliberate authentication clears the email
    // bucket entirely.
    expect(limiter.isBlocked(emailKey)).toBe(false);
    limiter.recordFailure(emailKey);
    // Only one failure now (bucket was reset), so still far from threshold 5.
    expect(limiter.isBlocked(emailKey)).toBe(false);
  });

  it('a SUBSEQUENT valid login does NOT reset the global per-email bucket (only per-IP keys)', async () => {
    const limiter = new FailedLoginLimiter(2, 60_000);
    const clientIp = '10.0.0.5';
    const emailLc = 'victim@example.com';
    const emailKey = `email:${emailLc}`;
    const ipKey = `ip:${clientIp}`;
    const ipEmailKey = `ip-email:${clientIp}:${emailLc}`;
    // An attacker (different IP rotation) has driven the global email key to the
    // threshold; also seed the per-IP keys for the victim's own IP.
    limiter.recordFailure(emailKey);
    limiter.recordFailure(emailKey);
    limiter.recordFailure(ipKey);
    limiter.recordFailure(ipEmailKey);

    // The victim's live session would be throttled too (shared email key), so to
    // exercise the SUBSEQUENT success path we use a SEPARATE limiter assertion:
    // verify the reset behaviour directly on the keys the helper touches. Build a
    // limiter where only the per-IP budget is set so the request is not blocked.
    const lim2 = new FailedLoginLimiter(2, 60_000);
    lim2.recordFailure(emailKey); // 1 failure on the global email key
    lim2.recordFailure(ipKey);
    lim2.recordFailure(ipEmailKey);
    const verifyCredentials = jest.fn().mockResolvedValue(undefined);
    await resolveMcpSessionConfig(
      basicHeader(emailLc, 'pw'),
      makeDeps({ limiter: lim2, clientIp, verifyCredentials, isSessionInit: false }),
    );
    expect(verifyCredentials).toHaveBeenCalled();
    // Per-IP keys were cleared by the subsequent success...
    expect(lim2.isBlocked(ipKey)).toBe(false);
    // ...but the global per-email key was DELIBERATELY left intact (still 1).
    lim2.recordFailure(emailKey); // -> 2 == threshold
    expect(lim2.isBlocked(emailKey)).toBe(true);
  });
});

describe('isInitializeRequestBody (session-INIT detection)', () => {
  it('true only for a single JSON-RPC object with method === "initialize"', () => {
    expect(isInitializeRequestBody({ jsonrpc: '2.0', method: 'initialize' })).toBe(
      true,
    );
  });

  it('false for a non-initialize method (e.g. tools/call)', () => {
    expect(
      isInitializeRequestBody({ jsonrpc: '2.0', method: 'tools/call' }),
    ).toBe(false);
  });

  it('false for a batch (array) body, null/undefined, or a non-object', () => {
    expect(
      isInitializeRequestBody([{ jsonrpc: '2.0', method: 'initialize' }]),
    ).toBe(false);
    expect(isInitializeRequestBody(undefined)).toBe(false);
    expect(isInitializeRequestBody(null)).toBe(false);
    expect(isInitializeRequestBody('initialize')).toBe(false);
  });
});

describe('isSessionInit decision (no mcp-session-id AND initialize body)', () => {
  // The service computes isSessionInit = !mcp-session-id && isInitializeRequestBody(body).
  // This proves a header-less but NON-initialize request is NOT treated as init,
  // so it goes down the non-side-effecting verifyCredentials path (no orphan
  // session/audit before http.ts 400s it).
  const decide = (sessionId: string | undefined, body: unknown): boolean =>
    !sessionId && isInitializeRequestBody(body);

  it('no header + initialize body -> init', () => {
    expect(decide(undefined, { method: 'initialize' })).toBe(true);
  });

  it('no header + non-initialize body -> NOT init (verifyCredentials path)', () => {
    expect(decide(undefined, { method: 'tools/list' })).toBe(false);
  });

  it('has session-id -> never init regardless of body', () => {
    expect(decide('sess-1', { method: 'initialize' })).toBe(false);
  });
});

describe('resolveMcpSessionConfig non-initialize request side effects', () => {
  it('header-less NON-initialize request does NOT call session-minting login() (uses verifyCredentials)', async () => {
    // Simulate the service decision: no mcp-session-id but body is NOT initialize
    // -> isSessionInit false -> the helper must use verifyCredentials, not login.
    const login = jest.fn().mockResolvedValue('issued-user-jwt');
    const verifyCredentials = jest.fn().mockResolvedValue(undefined);
    const isSessionInit = isInitializeRequestBody({ method: 'tools/call' }); // false
    await resolveMcpSessionConfig(
      basicHeader('user@example.com', 'pw'),
      makeDeps({ login, verifyCredentials, isSessionInit }),
    );
    expect(login).not.toHaveBeenCalled();
    expect(verifyCredentials).toHaveBeenCalledWith(
      { email: 'user@example.com', password: 'pw' },
      'ws-1',
    );
  });
});

describe('sharedTokenMatches (X-MCP-Token constant-time guard, item 2)', () => {
  it('equal token -> true', () => {
    expect(sharedTokenMatches('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('wrong token of the SAME length -> false (timingSafeEqual path)', () => {
    // Same length so it reaches timingSafeEqual; the bytes differ -> no match.
    expect(sharedTokenMatches('aaaaaa', 'aaaaab')).toBe(false);
  });

  it('different-length token -> false WITHOUT throwing (early-return before timingSafeEqual)', () => {
    // timingSafeEqual throws on unequal-length buffers; the early length check
    // must short-circuit so a length mismatch is a clean non-match, not a throw.
    expect(() => sharedTokenMatches('expected', 'short')).not.toThrow();
    expect(sharedTokenMatches('expected', 'short')).toBe(false);
    expect(sharedTokenMatches('expected', 'a-much-longer-provided-value')).toBe(
      false,
    );
  });

  it('array-valued header -> uses the FIRST element', () => {
    // Multiple X-MCP-Token headers arrive as string[]; only the first is used.
    expect(sharedTokenMatches('tok', ['tok', 'ignored'])).toBe(true);
    expect(sharedTokenMatches('tok', ['wrong', 'tok'])).toBe(false);
  });

  it('undefined / non-string provided -> false', () => {
    expect(sharedTokenMatches('tok', undefined)).toBe(false);
    // An empty array yields provided[0] === undefined -> non-string -> false.
    expect(sharedTokenMatches('tok', [])).toBe(false);
    expect(sharedTokenMatches('tok', [undefined as unknown as string])).toBe(
      false,
    );
  });
});

describe('clientIp (XFF-fallback precedence, item 5)', () => {
  it('req.ip wins over socket.remoteAddress AND over X-Forwarded-For', () => {
    expect(
      clientIp({
        ip: '1.1.1.1',
        socket: { remoteAddress: '2.2.2.2' },
        headers: { 'x-forwarded-for': '3.3.3.3' },
      }),
    ).toBe('1.1.1.1');
  });

  it('socket.remoteAddress is used only when req.ip is absent (still beats XFF)', () => {
    expect(
      clientIp({
        socket: { remoteAddress: '2.2.2.2' },
        headers: { 'x-forwarded-for': '3.3.3.3' },
      }),
    ).toBe('2.2.2.2');
  });

  it('X-Forwarded-For is the LAST resort, and only the FIRST hop is taken', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '3.3.3.3, 4.4.4.4, 5.5.5.5' },
      }),
    ).toBe('3.3.3.3');
  });

  it("returns 'unknown' when nothing usable is present", () => {
    expect(clientIp({ headers: {} })).toBe('unknown');
    // An array-valued XFF header is not treated as a string source -> unknown.
    expect(
      clientIp({ headers: { 'x-forwarded-for': ['3.3.3.3'] } }),
    ).toBe('unknown');
    // An empty XFF string is ignored too.
    expect(clientIp({ headers: { 'x-forwarded-for': '' } })).toBe('unknown');
  });
});

describe('bindAccessJwtVerifier enforces JwtType.ACCESS (item 3)', () => {
  it('calls TokenService.verifyJwt with JwtType.ACCESS as the second argument', async () => {
    // Mock TokenService: assert the type literal is pinned to ACCESS so swapping
    // to REFRESH (or omitting the type) breaks this test.
    const verifyJwt = jest
      .fn()
      .mockResolvedValue({ sub: 'user-1', workspaceId: 'ws-1' });
    const verify = bindAccessJwtVerifier({ verifyJwt });

    await verify('the.access.jwt');

    expect(verifyJwt).toHaveBeenCalledTimes(1);
    expect(verifyJwt).toHaveBeenCalledWith('the.access.jwt', JwtType.ACCESS);
    // Pin the real enum value too, so renaming/repointing the enum member is caught.
    expect(verifyJwt.mock.calls[0][1]).toBe('access');
  });

  it('passes through the verified payload', async () => {
    const payload = { sub: 'user-9', email: 'u@e.com', workspaceId: 'ws-1' };
    const verifyJwt = jest.fn().mockResolvedValue(payload);
    await expect(
      bindAccessJwtVerifier({ verifyJwt })('t'),
    ).resolves.toBe(payload);
  });

  // The Bearer revocation/disabled checks (verifyBearerAccess) are covered above;
  // this binds the ACCESS-type enforcement that verifyMcpBearer wires in.
  it('feeds verifyBearerAccess so the whole Bearer chain enforces ACCESS', async () => {
    const verifyJwt = jest.fn().mockResolvedValue({
      sub: 'user-1',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
    });
    const res = await verifyBearerAccess('t', {
      verifyJwt: bindAccessJwtVerifier({ verifyJwt }),
      findUser: jest.fn().mockResolvedValue({ deactivatedAt: null }),
      findActiveSession: jest
        .fn()
        .mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1' }),
    });
    expect(verifyJwt).toHaveBeenCalledWith('t', JwtType.ACCESS);
    expect(res).toEqual({ sub: 'user-1', email: undefined });
  });
});

describe('decideBasicGate (pure SSO/MFA pre-token gate, refactor R1)', () => {
  // The pure decision extracted out of McpService.enforceBasicLoginGate. It is
  // tested WITHOUT ModuleRef and WITHOUT an on-disk EE MFA module: the SSO verdict
  // and the MFA requirement result are passed in as plain values.

  it('SSO enforced -> throws Unauthorized ("enforced SSO")', () => {
    expect(() => decideBasicGate({ ssoEnforced: true })).toThrow(
      UnauthorizedException,
    );
    expect(() => decideBasicGate({ ssoEnforced: true })).toThrow(/enforced SSO/);
    // SSO takes precedence even if MFA flags are also set.
    expect(() =>
      decideBasicGate({ ssoEnforced: true, mfa: { userHasMfa: true } }),
    ).toThrow(/enforced SSO/);
  });

  it('no SSO + no MFA module (mfa undefined) -> resolves (Basic allowed)', () => {
    // A community/fork build with no EE MFA module passes mfa: undefined and the
    // gate must allow the password login (same as the controller with no MFA).
    expect(() => decideBasicGate({ ssoEnforced: false })).not.toThrow();
    expect(() =>
      decideBasicGate({ ssoEnforced: false, mfa: undefined }),
    ).not.toThrow();
  });

  it('MFA present + userHasMfa -> rejects ("use a Bearer access token")', () => {
    expect(() =>
      decideBasicGate({ ssoEnforced: false, mfa: { userHasMfa: true } }),
    ).toThrow(/use a Bearer access token/);
    expect(() =>
      decideBasicGate({ ssoEnforced: false, mfa: { userHasMfa: true } }),
    ).toThrow(UnauthorizedException);
  });

  it('MFA present + requiresMfaSetup -> rejects', () => {
    expect(() =>
      decideBasicGate({ ssoEnforced: false, mfa: { requiresMfaSetup: true } }),
    ).toThrow(/use a Bearer access token/);
  });

  it('MFA present but none required (both flags false) -> resolves', () => {
    expect(() =>
      decideBasicGate({
        ssoEnforced: false,
        mfa: { userHasMfa: false, requiresMfaSetup: false },
      }),
    ).not.toThrow();
  });
});

describe('mapAuthResultToResponse (handle status/body mapping, refactor R2)', () => {
  // The pure response decision extracted out of McpService.handle. It maps the
  // pre-hijack gauntlet (shared token, enablement, auth error) to either a fixed
  // JSON error response or the hijack path — never leaking the password/header.

  it('wrong X-MCP-Token -> 401 {error:"Unauthorized"} and NOT the hijack path', () => {
    const d = mapAuthResultToResponse({ sharedTokenOk: false, enabled: true });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Unauthorized' },
    });
  });

  it('workspace MCP disabled -> 403', () => {
    const d = mapAuthResultToResponse({ sharedTokenOk: true, enabled: false });
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.status).toBe(403);
      expect(d.body).toEqual({ error: 'MCP is disabled for this workspace' });
    }
  });

  it('an UnauthorizedException -> 401 with err.message; no password/header leaked', () => {
    // Construct an UnauthorizedException whose message is the SPECIFIC auth reason.
    const err = new UnauthorizedException('Email or password does not match');
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: true,
      error: err,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Email or password does not match' },
    });
    // The surfaced body is ONLY the exception message — never the raw secret.
    if (d.kind === 'respond') {
      const serialized = JSON.stringify(d.body);
      expect(serialized).not.toContain('password=');
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Basic ');
      expect(serialized).not.toContain('Bearer ');
    }
  });

  it('a non-Unauthorized error -> 500 generic (no error detail surfaced)', () => {
    const err = new Error('db blew up: connection string secret');
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: true,
      error: err,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 500,
      body: { error: 'Internal server error' },
    });
    // The generic body must NOT echo the underlying error message.
    if (d.kind === 'respond') {
      expect(d.body.error).not.toContain('secret');
    }
  });

  it('happy path (auth resolved, no error) -> hijack', () => {
    const d = mapAuthResultToResponse({ sharedTokenOk: true, enabled: true });
    expect(d).toEqual({ kind: 'hijack' });
  });

  it('shared-token failure takes precedence over disabled/error', () => {
    // Even with a disabled workspace and an error, a bad shared token is the
    // first gate, so the response is the uniform 401 Unauthorized.
    const d = mapAuthResultToResponse({
      sharedTokenOk: false,
      enabled: false,
      error: new UnauthorizedException('should not surface'),
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Unauthorized' },
    });
  });
});
