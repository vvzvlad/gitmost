import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { JwtType } from '../dto/jwt-payload';

/**
 * Provenance derivation in JwtStrategy.validate (jwt.strategy.ts).
 *
 * The strategy must derive the agent-edit provenance from the SIGNED server-side
 * identity, never from a client-controlled field. The security invariant under
 * test: a user flagged is_agent stamps 'agent'; an ordinary user resolves to
 * 'user'; and an `actor` claim in the token CANNOT escalate a non-agent user
 * past the existing internal-AI-chat claim semantics (anti-spoof — a plain user
 * cannot obtain created_source='agent').
 *
 * The strategy is constructed directly with stub deps. The PassportStrategy base
 * only needs a secret at construction time; validate() is exercised on its own.
 */
describe('JwtStrategy — provenance derivation', () => {
  function makeStrategy(user: any) {
    const userRepo: any = { findById: jest.fn(async () => user) };
    const workspaceRepo: any = {
      findById: jest.fn(async () => ({ id: 'ws-1' })),
    };
    const userSessionRepo: any = { findActiveById: jest.fn() };
    const sessionActivityService: any = { trackActivity: jest.fn() };
    const environmentService: any = { getAppSecret: () => 'test-secret' };
    // ACCESS-path tests never touch the api-key seam; a bare stub suffices.
    const apiKeyService: any = { validate: jest.fn() };

    const strategy = new JwtStrategy(
      userRepo,
      workspaceRepo,
      userSessionRepo,
      sessionActivityService,
      environmentService,
      apiKeyService,
    );
    return { strategy, userRepo };
  }

  // A bare request whose `raw` collects the provenance the strategy stamps.
  const makeReq = () => ({ raw: {} as Record<string, any> });

  const accessPayload = (over?: Record<string, any>) => ({
    sub: 'user-1',
    email: 'u@test.local',
    workspaceId: 'ws-1',
    type: JwtType.ACCESS,
    ...over,
  });

  it("stamps actor='agent' for an is_agent user (derived from the signed identity)", async () => {
    const { strategy, userRepo } = makeStrategy({
      id: 'user-1',
      isAgent: true,
      deactivatedAt: null,
      deletedAt: null,
    });
    const req = makeReq();

    await strategy.validate(req, accessPayload() as any);

    expect(req.raw.actor).toBe('agent');
    // External MCP agent: no internal ai_chats row → null.
    expect(req.raw.aiChatId).toBeNull();
    // Wiring guard (#143): the seam MUST opt into the isAgent flag, otherwise
    // findById omits it (it is not in baseFields) and provenance silently
    // degrades to 'user'.
    expect(userRepo.findById).toHaveBeenCalledWith(
      'user-1',
      'ws-1',
      expect.objectContaining({ includeIsAgent: true }),
    );
  });

  it("stamps actor='user' for an ordinary user", async () => {
    const { strategy } = makeStrategy({
      id: 'user-1',
      isAgent: false,
      deactivatedAt: null,
      deletedAt: null,
    });
    const req = makeReq();

    await strategy.validate(req, accessPayload() as any);

    expect(req.raw.actor).toBe('user');
    expect(req.raw.aiChatId).toBeNull();
  });

  it("honors a SIGNED actor='agent' claim on a non-agent user's token (the internal AI-chat path)", async () => {
    // A non-agent user (the plain no-claim → 'user' case is covered above). A
    // token that DOES carry actor='agent' resolves to 'agent' — BY DESIGN: that
    // claim can only exist on a SERVER-MINTED provenance token (the internal AI
    // chat), never on a plain login token, because the token is signed with the
    // app secret. The guarantee is that a client cannot FORGE this signed claim,
    // not that the strategy ignores it. (A plain user still cannot obtain
    // 'agent' — they have no way to get such a token.)
    const { strategy } = makeStrategy({
      id: 'user-1',
      isAgent: false,
      deactivatedAt: null,
      deletedAt: null,
    });
    const req2 = makeReq();
    await strategy.validate(
      req2,
      accessPayload({ actor: 'agent', aiChatId: 'chat-1' }) as any,
    );
    expect(req2.raw.actor).toBe('agent');
    expect(req2.raw.aiChatId).toBe('chat-1');
  });

  it('rejects a disabled is_agent user (Unauthorized) before stamping provenance', async () => {
    const { strategy } = makeStrategy({
      id: 'user-1',
      isAgent: true,
      deactivatedAt: new Date('2026-01-01'),
      deletedAt: null,
    });
    const req = makeReq();

    await expect(
      strategy.validate(req, accessPayload() as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(req.raw.actor).toBeUndefined();
  });
});

/**
 * Provenance derivation on the API-KEY path (jwt.strategy.validateApiKey, #486
 * + #501).
 *
 * The access-token path stamped provenance; the API-key path returned early
 * WITHOUT it, so an is_agent API key's REST writes recorded no 'agent' marker.
 * The API-key payload carries no signed claim, so provenance is resolved from the
 * SERVER-SIDE user returned by ApiKeyService.validate: isAgent -> 'agent',
 * otherwise 'user'; aiChatId is always null (an API key has no ai_chats row).
 *
 * #501 wires the CORE ApiKeyService (the EE `ee/api-key` module is absent in the
 * fork) directly into the strategy — no dynamic require. The strategy also stamps
 * `req.raw.authType='api_key'` + `req.raw.apiKeyId` for the "a token cannot manage
 * tokens" guard on the /api-keys surface.
 */
describe('JwtStrategy — API-key provenance derivation (#486/#501)', () => {
  function makeApiKeyStrategy(validateImpl: (p: any) => Promise<any>) {
    const userRepo: any = { findById: jest.fn() };
    const workspaceRepo: any = { findById: jest.fn() };
    const userSessionRepo: any = { findActiveById: jest.fn() };
    const sessionActivityService: any = { trackActivity: jest.fn() };
    const environmentService: any = { getAppSecret: () => 'test-secret' };
    const validate = jest.fn(validateImpl);
    const apiKeyService: any = { validate };

    const strategy = new JwtStrategy(
      userRepo,
      workspaceRepo,
      userSessionRepo,
      sessionActivityService,
      environmentService,
      apiKeyService,
    );
    return { strategy, validate };
  }

  const makeReq = () => ({ raw: {} as Record<string, any> });
  const apiKeyPayload = () => ({
    sub: 'svc-1',
    workspaceId: 'ws-1',
    apiKeyId: 'key-1',
    type: JwtType.API_KEY,
  });

  it("stamps actor='agent' + authType/apiKeyId for an is_agent API key", async () => {
    const validated = {
      user: { id: 'svc-1', isAgent: true },
      workspace: { id: 'ws-1' },
    };
    const { strategy, validate } = makeApiKeyStrategy(async () => validated);
    const req = makeReq();

    const result = await strategy.validate(req, apiKeyPayload() as any);

    expect(validate).toHaveBeenCalledTimes(1);
    expect(req.raw.actor).toBe('agent');
    // API keys carry no internal ai_chats row -> null.
    expect(req.raw.aiChatId).toBeNull();
    // Principal-kind markers for the management-surface guard.
    expect(req.raw.authType).toBe('api_key');
    expect(req.raw.apiKeyId).toBe('key-1');
    // The validated auth object is returned unchanged (req.user shape preserved).
    expect(result).toBe(validated);
  });

  it("stamps actor='agent' + apiKeyId for an ordinary (non-agent) API key (#559 external MCP)", async () => {
    // #559 — every api-key write is now an EXTERNAL MCP write, even for an
    // ordinary user's PERSONAL key: the access is programmatic via the key, so it
    // is attributed to the "External MCP" persona named after the key rather than
    // shown as the human. aiChatId stays null (no internal chat); the key id is
    // what distinguishes the persona.
    const { strategy } = makeApiKeyStrategy(async () => ({
      user: { id: 'u-1', isAgent: false },
      workspace: { id: 'ws-1' },
    }));
    const req = makeReq();

    await strategy.validate(req, apiKeyPayload() as any);

    expect(req.raw.actor).toBe('agent');
    expect(req.raw.aiChatId).toBeNull();
    expect(req.raw.apiKeyId).toBe('key-1');
    expect(req.raw.authType).toBe('api_key');
  });

  it('propagates a validate() rejection and stamps nothing', async () => {
    const { strategy } = makeApiKeyStrategy(async () => {
      throw new UnauthorizedException();
    });
    const req = makeReq();

    await expect(
      strategy.validate(req, apiKeyPayload() as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(req.raw.actor).toBeUndefined();
    expect(req.raw.authType).toBeUndefined();
  });
});
