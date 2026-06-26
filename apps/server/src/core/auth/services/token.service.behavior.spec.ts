import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
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
});
