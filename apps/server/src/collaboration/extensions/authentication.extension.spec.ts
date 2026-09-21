import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthenticationExtension } from './authentication.extension';
import { SpaceRole } from '../../common/helpers/types/permission';
import { JwtType } from '../../core/auth/dto/jwt-payload';

/**
 * Unit tests for the collab read-only downgrade matrix in
 * `AuthenticationExtension.onAuthenticate`. This is a security boundary: a wrong
 * branch here is either a collab-auth bypass (writer on a page they may only
 * read) or a denial. We mock every repo and inspect both the thrown exception
 * type and the `connectionConfig.readOnly` flag the extension mutates.
 */

const PAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = 'user-1';
const WORKSPACE_ID = 'ws-1';
const SPACE_ID = 'space-1';

const buildUser = (overrides: Partial<any> = {}) => ({
  id: USER_ID,
  workspaceId: WORKSPACE_ID,
  deactivatedAt: null,
  deletedAt: null,
  name: 'Alice',
  avatarUrl: null,
  ...overrides,
});

const buildPage = (overrides: Partial<any> = {}) => ({
  id: PAGE_ID,
  spaceId: SPACE_ID,
  workspaceId: WORKSPACE_ID,
  deletedAt: null,
  ...overrides,
});

// Default jwt payload: a plain human collab token (no agent provenance claims).
const buildJwt = (overrides: Partial<any> = {}) => ({
  sub: USER_ID,
  workspaceId: WORKSPACE_ID,
  type: JwtType.COLLAB,
  ...overrides,
});

describe('AuthenticationExtension.onAuthenticate', () => {
  let ext: AuthenticationExtension;
  let tokenService: { verifyJwt: jest.Mock };
  let userRepo: { findById: jest.Mock };
  let pageRepo: { findById: jest.Mock };
  let spaceMemberRepo: { getUserSpaceRoles: jest.Mock };
  let pagePermissionRepo: { canUserEditPage: jest.Mock };
  let apiKeyService: { validate: jest.Mock };

  // Build the hocuspocus onAuthenticate payload. connectionConfig.readOnly
  // starts false; the extension flips it to true on a read-only downgrade.
  const buildData = (token = 'tok') => ({
    documentName: `page.${PAGE_ID}`,
    token,
    connectionConfig: { readOnly: false },
  });

  beforeEach(() => {
    tokenService = { verifyJwt: jest.fn().mockResolvedValue(buildJwt()) };
    userRepo = { findById: jest.fn().mockResolvedValue(buildUser()) };
    pageRepo = { findById: jest.fn().mockResolvedValue(buildPage()) };
    spaceMemberRepo = {
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([{ userId: USER_ID, role: SpaceRole.WRITER }]),
    };
    pagePermissionRepo = {
      // No page-level restriction by default → defer to space role.
      canUserEditPage: jest.fn().mockResolvedValue({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      }),
    };

    apiKeyService = {
      validate: jest.fn().mockResolvedValue({ user: {}, workspace: {} }),
    };

    ext = new AuthenticationExtension(
      tokenService as any,
      userRepo as any,
      pageRepo as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
      apiKeyService as any,
    );
    // Silence the extension's logger (it warns/debugs on denial branches).
    jest.spyOn(ext['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'debug').mockImplementation(() => undefined);
  });

  it('invalid token → UnauthorizedException (no repo lookups happen)', async () => {
    tokenService.verifyJwt.mockRejectedValue(new Error('bad sig'));

    await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userRepo.findById).not.toHaveBeenCalled();
  });

  it('user not found → Unauthorized', async () => {
    userRepo.findById.mockResolvedValue(null);
    await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('user disabled (deactivatedAt set) → Unauthorized', async () => {
    userRepo.findById.mockResolvedValue(
      buildUser({ deactivatedAt: new Date() }),
    );
    await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('page not found → NotFoundException', async () => {
    pageRepo.findById.mockResolvedValue(null);
    await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('no space role → Unauthorized', async () => {
    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([]);
    await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('page-level restriction canAccess=false → Unauthorized (restricted-page denial)', async () => {
    pagePermissionRepo.canUserEditPage.mockResolvedValue({
      hasAnyRestriction: true,
      canAccess: false,
      canEdit: false,
    });
    await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('restriction canAccess=true & canEdit=false → readOnly (no restricted-page write)', async () => {
    pagePermissionRepo.canUserEditPage.mockResolvedValue({
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: false,
    });
    const data = buildData();
    const ctx = await ext.onAuthenticate(data as any);

    expect(data.connectionConfig.readOnly).toBe(true);
    expect(ctx.actor).toBe('user');
  });

  it('restriction canAccess=true & canEdit=true → writable (readOnly stays false)', async () => {
    pagePermissionRepo.canUserEditPage.mockResolvedValue({
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: true,
    });
    const data = buildData();
    await ext.onAuthenticate(data as any);

    expect(data.connectionConfig.readOnly).toBe(false);
  });

  it('no restriction + space READER → readOnly', async () => {
    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([
      { userId: USER_ID, role: SpaceRole.READER },
    ]);
    const data = buildData();
    await ext.onAuthenticate(data as any);

    expect(data.connectionConfig.readOnly).toBe(true);
  });

  it('no restriction + space WRITER → writable', async () => {
    const data = buildData();
    await ext.onAuthenticate(data as any);
    expect(data.connectionConfig.readOnly).toBe(false);
  });

  it('soft-deleted page (deletedAt set) → readOnly even for a WRITER', async () => {
    // A writer must NOT be able to mutate a page in the trash via collab.
    pageRepo.findById.mockResolvedValue(buildPage({ deletedAt: new Date() }));
    const data = buildData();
    await ext.onAuthenticate(data as any);

    expect(data.connectionConfig.readOnly).toBe(true);
  });

  it('agent JWT (actor=agent + aiChatId) propagates into the connection context', async () => {
    tokenService.verifyJwt.mockResolvedValue(
      buildJwt({ actor: 'agent', aiChatId: 'chat-7' }),
    );
    const ctx = await ext.onAuthenticate(buildData() as any);

    expect(ctx.actor).toBe('agent');
    expect(ctx.aiChatId).toBe('chat-7');
    expect(ctx.user.id).toBe(USER_ID);
  });

  it('human JWT (no provenance claims) → actor=user, aiChatId=null', async () => {
    const ctx = await ext.onAuthenticate(buildData() as any);

    expect(ctx.actor).toBe('user');
    expect(ctx.aiChatId).toBeNull();
    // Wiring guard (#143): the collab seam MUST opt into the isAgent flag —
    // it is not in baseFields, so without this option findById omits it and a
    // flagged service account's collab edits would silently persist as 'user'.
    expect(userRepo.findById).toHaveBeenCalledWith(
      USER_ID,
      WORKSPACE_ID,
      expect.objectContaining({ includeIsAgent: true }),
    );
  });

  it('is_agent user with NO claim → actor=agent (collab seam consults the signed identity)', async () => {
    // Arch A regression guard: a flagged agent user editing page CONTENT over the
    // collab websocket carries a plain COLLAB token (no actor claim). Before the
    // shared resolveProvenance() wiring this seam derived actor from the claim
    // alone, so such edits persisted as lastUpdatedSource='user' — drifting from
    // the REST seam. The seam must now stamp 'agent' from the is_agent flag,
    // matching jwt.strategy.
    userRepo.findById.mockResolvedValue(buildUser({ isAgent: true }));
    const ctx = await ext.onAuthenticate(buildData() as any);

    expect(ctx.actor).toBe('agent');
    // No internal ai_chats row for an external api_key agent's collab edit → null.
    expect(ctx.aiChatId).toBeNull();
  });

  it('#559 api_key principal (ordinary user) → actor=agent + apiKeyId in context (external MCP)', async () => {
    // An EXTERNAL MCP collab connection carries principal='api_key' + apiKeyId but
    // NO actor claim, and the key owner is an ordinary (non-is_agent) user. The
    // seam must still stamp actor='agent' and thread the key id into the context
    // so persistence.extension persists last_updated_api_key_id and the page shows
    // the "External MCP" persona named after the key.
    tokenService.verifyJwt.mockResolvedValue(
      buildJwt({ principal: 'api_key', apiKeyId: 'key-42' }),
    );
    userRepo.findById.mockResolvedValue(buildUser({ isAgent: false }));
    const ctx = await ext.onAuthenticate(buildData() as any);

    expect(ctx.actor).toBe('agent');
    expect(ctx.aiChatId).toBeNull();
    expect(ctx.apiKeyId).toBe('key-42');
  });

  // --- #501: api-key laundering guard (fail-closed discriminator) ----------
  describe('api-key laundering guard', () => {
    it('api_key principal → row-checks the key on connect (valid key proceeds)', async () => {
      tokenService.verifyJwt.mockResolvedValue(
        buildJwt({ principal: 'api_key', apiKeyId: 'key-1' }),
      );
      const data = buildData();
      await ext.onAuthenticate(data as any);

      expect(apiKeyService.validate).toHaveBeenCalledTimes(1);
      expect(apiKeyService.validate).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyId: 'key-1', type: JwtType.API_KEY }),
      );
    });

    it('REVOKED api_key → Unauthorized on connect, BEFORE any page/user lookup', async () => {
      tokenService.verifyJwt.mockResolvedValue(
        buildJwt({ principal: 'api_key', apiKeyId: 'key-1' }),
      );
      // The shared validator denies a revoked key.
      apiKeyService.validate.mockRejectedValue(new UnauthorizedException());

      await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
        UnauthorizedException,
      );
      // No new collab connection: the key check gates before page access.
      expect(pageRepo.findById).not.toHaveBeenCalled();
    });

    it('api_key principal missing apiKeyId → Unauthorized (malformed)', async () => {
      tokenService.verifyJwt.mockResolvedValue(
        buildJwt({ principal: 'api_key' }),
      );
      await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(apiKeyService.validate).not.toHaveBeenCalled();
    });

    it('session principal → NO api-key check (session-backed, incl. internal agent)', async () => {
      tokenService.verifyJwt.mockResolvedValue(
        buildJwt({ principal: 'session' }),
      );
      await ext.onAuthenticate(buildData() as any);
      expect(apiKeyService.validate).not.toHaveBeenCalled();
    });

    it('claimless token WITHIN the grace window → trusted (legacy pre-rollout)', async () => {
      // Default rolloutAt = now, so we are inside the grace window.
      tokenService.verifyJwt.mockResolvedValue(buildJwt()); // no principal
      await expect(
        ext.onAuthenticate(buildData() as any),
      ).resolves.toBeDefined();
      expect(apiKeyService.validate).not.toHaveBeenCalled();
    });

    it('claimless token AFTER the grace window → Unauthorized (fail-closed)', async () => {
      // Move the rollout reference far into the past so the grace has elapsed.
      (ext as any).rolloutAt = Date.now() - 25 * 60 * 60 * 1000;
      tokenService.verifyJwt.mockResolvedValue(buildJwt()); // no principal
      await expect(ext.onAuthenticate(buildData() as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('infra error from the api-key row-check propagates (not masked)', async () => {
      tokenService.verifyJwt.mockResolvedValue(
        buildJwt({ principal: 'api_key', apiKeyId: 'key-1' }),
      );
      const boom = new Error('db down');
      apiKeyService.validate.mockRejectedValue(boom);
      await expect(ext.onAuthenticate(buildData() as any)).rejects.toBe(boom);
    });
  });
});
