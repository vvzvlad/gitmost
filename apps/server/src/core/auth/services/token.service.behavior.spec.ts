import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { TokenService } from './token.service';
import { JwtType } from '../dto/jwt-payload';

/**
 * Behaviour contract for TokenService.
 *
 * These are LIVE security tests: TokenService is constructed directly with a
 * stubbed JwtService and EnvironmentService (the established direct-instantiation
 * style — see verify-user-credentials.live.spec.ts). They exercise the real
 * decision logic of the service:
 *
 *  - verifyJwt enforces the token TYPE, blocking confused-deputy / token-type
 *    confusion (an attachment token must not be accepted as an access token).
 *  - generateAccessToken / generateCollabToken refuse to mint a token for a
 *    disabled (deactivated/deleted) user, and only stamp the non-spoofable
 *    `actor:'agent'` provenance claim when the caller explicitly supplies it —
 *    a forged actor claim would be a privilege escalation.
 *  - generateCollabToken uses the expected 24h expiry.
 */

const APP_SECRET = 'test-app-secret';

function makeTokenService(over: {
  sign?: jest.Mock;
  verifyAsync?: jest.Mock;
  getAppSecret?: jest.Mock;
} = {}): {
  service: TokenService;
  jwtService: { sign: jest.Mock; verifyAsync: jest.Mock };
  environmentService: { getAppSecret: jest.Mock };
} {
  const jwtService = {
    // Sentinel return value so we can assert the token is whatever sign produced.
    sign: over.sign ?? jest.fn().mockReturnValue('signed-token-sentinel'),
    verifyAsync: over.verifyAsync ?? jest.fn(),
  };
  const environmentService = {
    getAppSecret: over.getAppSecret ?? jest.fn().mockReturnValue(APP_SECRET),
  };

  // Constructor signature (token.service.ts): (jwtService, environmentService).
  const service = new (TokenService as unknown as new (
    ...args: unknown[]
  ) => TokenService)(jwtService, environmentService);

  return { service, jwtService, environmentService };
}

// Minimal User-shaped object. Cast to any at call sites because the production
// User type carries many more fields we do not touch on these paths.
function makeUser(over: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'user@example.com',
    workspaceId: 'ws-1',
    deactivatedAt: null,
    deletedAt: null,
    ...over,
  };
}

describe('TokenService.verifyJwt (token-type enforcement)', () => {
  it('verifies the token with the app secret from EnvironmentService', async () => {
    const verifyAsync = jest
      .fn()
      .mockResolvedValue({ type: JwtType.ACCESS, sub: 'user-1' });
    const { service, jwtService, environmentService } = makeTokenService({
      verifyAsync,
    });

    await service.verifyJwt('some.jwt.token', JwtType.ACCESS);

    expect(jwtService.verifyAsync).toHaveBeenCalledTimes(1);
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('some.jwt.token', {
      secret: APP_SECRET,
    });
    expect(environmentService.getAppSecret).toHaveBeenCalled();
  });

  it('returns the payload when its type matches the expected type', async () => {
    const payload = { type: JwtType.ACCESS, sub: 'user-1', workspaceId: 'ws-1' };
    const { service } = makeTokenService({
      verifyAsync: jest.fn().mockResolvedValue(payload),
    });

    const result = await service.verifyJwt('token', JwtType.ACCESS);

    expect(result).toBe(payload);
  });

  it('REJECTS a payload whose type does not match the expected type (no type confusion)', async () => {
    // A genuine, correctly-signed attachment token must not pass as an access
    // token. If the type guard were removed, this would resolve instead of throw.
    const attachmentPayload = { type: JwtType.ATTACHMENT, attachmentId: 'a-1' };
    const { service } = makeTokenService({
      verifyAsync: jest.fn().mockResolvedValue(attachmentPayload),
    });

    await expect(
      service.verifyJwt('token', JwtType.ACCESS),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.verifyJwt('token', JwtType.ACCESS),
    ).rejects.toMatchObject({
      message: 'Invalid JWT token. Token type does not match.',
    });
  });
});

describe('TokenService.generateAccessToken', () => {
  it('throws ForbiddenException and does NOT sign for a disabled (deactivated) user', async () => {
    const { service, jwtService } = makeTokenService();
    const disabledUser = makeUser({ deactivatedAt: new Date() });

    await expect(
      service.generateAccessToken(disabledUser as never, 'session-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException and does NOT sign for a deleted user', async () => {
    const { service, jwtService } = makeTokenService();
    const deletedUser = makeUser({ deletedAt: new Date() });

    await expect(
      service.generateAccessToken(deletedUser as never, 'session-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('signs an ACCESS token with correct sub/workspaceId and NO actor claim by default', async () => {
    const { service, jwtService } = makeTokenService();
    const user = makeUser({ id: 'user-42', workspaceId: 'ws-9' });

    const token = await service.generateAccessToken(user as never, 'session-7');

    expect(token).toBe('signed-token-sentinel');
    expect(jwtService.sign).toHaveBeenCalledTimes(1);
    const payload = jwtService.sign.mock.calls[0][0];
    expect(payload).toMatchObject({
      sub: 'user-42',
      workspaceId: 'ws-9',
      type: JwtType.ACCESS,
      sessionId: 'session-7',
    });
    // The default (human) path must carry no provenance claim — a downstream
    // 'user' actor is inferred from its absence.
    expect(payload).not.toHaveProperty('actor');
    expect(payload).not.toHaveProperty('aiChatId');
  });

  it('stamps actor:agent + aiChatId only when provenance is explicitly supplied', async () => {
    const { service, jwtService } = makeTokenService();
    const user = makeUser({ id: 'user-42', workspaceId: 'ws-9' });

    await service.generateAccessToken(user as never, 'session-7', {
      actor: 'agent',
      aiChatId: 'chat-123',
    });

    const payload = jwtService.sign.mock.calls[0][0];
    expect(payload).toMatchObject({
      sub: 'user-42',
      type: JwtType.ACCESS,
      actor: 'agent',
      aiChatId: 'chat-123',
    });
  });
});

describe('TokenService.generateCollabToken', () => {
  it('throws ForbiddenException and does NOT sign for a disabled user', async () => {
    const { service, jwtService } = makeTokenService();
    const disabledUser = makeUser({ deactivatedAt: new Date() });

    await expect(
      service.generateCollabToken(disabledUser as never, 'ws-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('signs a COLLAB token with a 24h expiry for a normal user', async () => {
    const { service, jwtService } = makeTokenService();
    const user = makeUser({ id: 'user-3' });

    await service.generateCollabToken(user as never, 'ws-77');

    expect(jwtService.sign).toHaveBeenCalledTimes(1);
    const [payload, options] = jwtService.sign.mock.calls[0];
    expect(payload).toMatchObject({
      sub: 'user-3',
      workspaceId: 'ws-77',
      type: JwtType.COLLAB,
    });
    expect(payload).not.toHaveProperty('actor');
    expect(options).toEqual({ expiresIn: '24h' });
  });

  it('stamps actor:agent + aiChatId on the collab token only when provenance is supplied', async () => {
    const { service, jwtService } = makeTokenService();
    const user = makeUser({ id: 'user-3' });

    await service.generateCollabToken(user as never, 'ws-77', {
      actor: 'agent',
      aiChatId: 'chat-456',
    });

    const [payload] = jwtService.sign.mock.calls[0];
    expect(payload).toMatchObject({
      type: JwtType.COLLAB,
      actor: 'agent',
      aiChatId: 'chat-456',
    });
  });

  // #501 fail-closed discriminator: EVERY collab token carries a principal.
  it("defaults principal to 'session' with NO apiKeyId (normal/internal-agent path)", async () => {
    const { service, jwtService } = makeTokenService();
    await service.generateCollabToken(makeUser() as never, 'ws-1');
    const [payload] = jwtService.sign.mock.calls[0];
    expect(payload.principal).toBe('session');
    expect(payload).not.toHaveProperty('apiKeyId');
  });

  it("the internal agent (provenance, NO apiKey) still gets principal='session'", async () => {
    const { service, jwtService } = makeTokenService();
    await service.generateCollabToken(
      makeUser() as never,
      'ws-1',
      { actor: 'agent', aiChatId: 'chat-1' },
    );
    const [payload] = jwtService.sign.mock.calls[0];
    // Keyed on api-key ORIGIN, not actor: an is_agent session token is 'session'.
    expect(payload.principal).toBe('session');
    expect(payload).not.toHaveProperty('apiKeyId');
  });

  it("stamps principal='api_key' + apiKeyId when minted by an api-key principal", async () => {
    const { service, jwtService } = makeTokenService();
    await service.generateCollabToken(
      makeUser() as never,
      'ws-1',
      undefined,
      { apiKeyId: 'key-9' },
    );
    const [payload] = jwtService.sign.mock.calls[0];
    expect(payload.principal).toBe('api_key');
    expect(payload.apiKeyId).toBe('key-9');
  });
});

/**
 * API-key token minting MUST carry NO `exp` claim — the ONLY source of truth for
 * a key's lifetime/revocation is its `api_keys` row, checked on every request.
 *
 * This is a LIVE-bug regression: the shared JwtService is registered with a
 * global `signOptions.expiresIn` (default '90d') that merges into every sign(),
 * so an api-key minted through it silently gets exp=now+90d and an "unlimited"
 * key dies in 90 days. TokenService.generateApiToken mints through a dedicated
 * no-expiry signer instead. These tests construct the REAL signer (a real secret
 * via the stubbed EnvironmentService) and decode the produced JWT to assert the
 * observable property: no `exp`.
 */
describe('TokenService.generateApiToken (no exp claim ever)', () => {
  const APP_SECRET_LOCAL = 'apikey-secret';

  function makeRealSignerService() {
    // Give the SHARED jwtService a global expiresIn so a regression (minting
    // through it) would show up as an exp claim — the exact live bug.
    const { JwtService } = require('@nestjs/jwt');
    const sharedJwt = new JwtService({
      secret: APP_SECRET_LOCAL,
      signOptions: { expiresIn: '90d', issuer: 'Docmost' },
    });
    const environmentService = {
      getAppSecret: () => APP_SECRET_LOCAL,
    };
    const service = new (TokenService as unknown as new (
      ...args: unknown[]
    ) => TokenService)(sharedJwt, environmentService);
    return { service };
  }

  const user = makeUser({ id: 'svc-1', workspaceId: 'ws-1' });

  it('mints an api-key JWT with NO exp claim and issuer Docmost', async () => {
    const { service } = makeRealSignerService();

    const token = await service.generateApiToken({
      apiKeyId: 'key-1',
      user: user as never,
      workspaceId: 'ws-1',
    });

    const decoded = jwt.decode(token) as Record<string, unknown>;
    // The observable security property: no expiry lives in the JWT.
    expect(decoded.exp).toBeUndefined();
    expect(decoded).toMatchObject({
      sub: 'svc-1',
      apiKeyId: 'key-1',
      workspaceId: 'ws-1',
      type: JwtType.API_KEY,
      iss: 'Docmost',
    });
  });

  // #557: the copyable-key contract. noTimestamp suppresses `iat`, so the token
  // is a pure deterministic function of (payload, secret) — re-minting the SAME
  // key yields a BYTE-IDENTICAL value, which is what makes "reveal" a safe
  // re-mint rather than a stored secret.
  it('mints an api-key JWT with NEITHER exp NOR iat (deterministic)', async () => {
    const { service } = makeRealSignerService();

    const token = await service.generateApiToken({
      apiKeyId: 'key-1',
      user: user as never,
      workspaceId: 'ws-1',
    });

    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.exp).toBeUndefined();
    expect(decoded.iat).toBeUndefined();
  });

  it('two mints of the SAME key are byte-identical (re-mint = reveal)', async () => {
    const { service } = makeRealSignerService();
    const opts = {
      apiKeyId: 'key-1',
      user: user as never,
      workspaceId: 'ws-1',
    };

    const first = await service.generateApiToken(opts);
    // A different time (and a fresh signer instance) must not change the bytes.
    await new Promise((r) => setTimeout(r, 1100));
    const { service: service2 } = makeRealSignerService();
    const second = await service2.generateApiToken(opts);

    expect(second).toBe(first);
  });

  it('demonstrates the live bug it guards: the SHARED signer WOULD add exp', () => {
    const { JwtService } = require('@nestjs/jwt');
    const sharedJwt = new JwtService({
      secret: APP_SECRET_LOCAL,
      signOptions: { expiresIn: '90d', issuer: 'Docmost' },
    });
    // Even with empty per-call options the global expiresIn merges in.
    const leaky = sharedJwt.sign({ sub: 'x', type: JwtType.API_KEY }, {});
    expect((jwt.decode(leaky) as Record<string, unknown>).exp).toBeDefined();
  });

  it('refuses to mint for a disabled user', async () => {
    const { service } = makeRealSignerService();
    await expect(
      service.generateApiToken({
        apiKeyId: 'key-1',
        user: makeUser({ deactivatedAt: new Date() }) as never,
        workspaceId: 'ws-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * verifyJwtOneOf is the type-routing primitive: verify the signature once and
 * assert the token type is on an explicit allowlist. It must NOT degrade into a
 * "return whatever type" helper — a token whose type is off the allowlist is
 * rejected with the same generic error as a single-type mismatch.
 */
describe('TokenService.verifyJwtOneOf (allowlist type-routing)', () => {
  it('returns the payload when the type is on the allowlist', async () => {
    const verifyAsync = jest
      .fn()
      .mockResolvedValue({ type: JwtType.API_KEY, sub: 'u-1' });
    const { service } = makeTokenService({ verifyAsync });

    const payload = await service.verifyJwtOneOf(token123(), [
      JwtType.ACCESS,
      JwtType.API_KEY,
    ]);

    expect(payload).toMatchObject({ type: JwtType.API_KEY, sub: 'u-1' });
    expect(verifyAsync).toHaveBeenCalledTimes(1);
  });

  it('accepts the OTHER allowed type too', async () => {
    const verifyAsync = jest
      .fn()
      .mockResolvedValue({ type: JwtType.ACCESS, sub: 'u-1' });
    const { service } = makeTokenService({ verifyAsync });

    await expect(
      service.verifyJwtOneOf(token123(), [JwtType.ACCESS, JwtType.API_KEY]),
    ).resolves.toMatchObject({ type: JwtType.ACCESS });
  });

  it('rejects a token whose type is OFF the allowlist (confused-deputy guard)', async () => {
    const verifyAsync = jest
      .fn()
      .mockResolvedValue({ type: JwtType.COLLAB, sub: 'u-1' });
    const { service } = makeTokenService({ verifyAsync });

    await expect(
      service.verifyJwtOneOf(token123(), [JwtType.ACCESS, JwtType.API_KEY]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verifies the signature exactly ONCE', async () => {
    const verifyAsync = jest
      .fn()
      .mockResolvedValue({ type: JwtType.ACCESS });
    const { service } = makeTokenService({ verifyAsync });
    await service.verifyJwtOneOf(token123(), [JwtType.ACCESS]);
    expect(verifyAsync).toHaveBeenCalledTimes(1);
  });
});

function token123(): string {
  return 'a.b.c';
}
