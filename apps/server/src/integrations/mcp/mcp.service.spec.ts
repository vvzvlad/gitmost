import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  parseBasicAuth,
  FailedLoginLimiter,
  resolveMcpSessionConfig,
  isCredentialsFailure,
  verifyBearerAccess,
  McpAuthDeps,
} from './mcp-auth.helpers';

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
});
