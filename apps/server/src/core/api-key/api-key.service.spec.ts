import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
// #558 deny-observability: mock only the counter so we can assert validate()
// increments api_key_auth_denied_total{reason} on each deny branch. Every other
// export stays real (the registry is otherwise a no-op unless METRICS_PORT set).
jest.mock('../../integrations/metrics/metrics.registry', () => ({
  ...jest.requireActual('../../integrations/metrics/metrics.registry'),
  incApiKeyAuthDenied: jest.fn(),
}));
import { ApiKeyService } from './api-key.service';
import { JwtType } from '../auth/dto/jwt-payload';
import { incApiKeyAuthDenied } from '../../integrations/metrics/metrics.registry';

const incDenied = incApiKeyAuthDenied as jest.Mock;

/**
 * Security contract for ApiKeyService.validate — the single validator shared by
 * jwt.strategy (REST) and the /mcp Bearer router.
 *
 * Invariants under test:
 *  - Anti-enumeration: every DEFINITE deny (missing/revoked/expired row, disabled
 *    user, workspace mismatch, kill-switch off) throws the SAME bare
 *    UnauthorizedException — an agent cannot distinguish expired from revoked.
 *  - deny-on-decision / 5xx-on-infra: an UNEXPECTED (infra) error PROPAGATES as
 *    itself (→ 5xx), never masked as a 401.
 *  - Expiry is read from the ROW, never a JWT exp claim.
 *  - No validate cache (each call re-reads the row → immediate revocation).
 */

function makeDeps(over: Partial<Record<string, any>> = {}) {
  const apiKeyRepo = {
    findById: jest.fn(),
    insert: jest.fn(),
    softDelete: jest.fn(),
    touchLastUsed: jest.fn().mockResolvedValue(undefined),
    ...(over.apiKeyRepo ?? {}),
  };
  const userRepo = {
    findById: jest.fn(),
    ...(over.userRepo ?? {}),
  };
  const workspaceRepo = {
    findById: jest.fn().mockResolvedValue({ id: 'ws-1' }),
    ...(over.workspaceRepo ?? {}),
  };
  const tokenService = {
    generateApiToken: jest.fn().mockResolvedValue('minted.jwt.token'),
    ...(over.tokenService ?? {}),
  };
  const service = new (ApiKeyService as unknown as new (...a: any[]) => ApiKeyService)(
    apiKeyRepo,
    userRepo,
    workspaceRepo,
    tokenService,
  );
  return { service, apiKeyRepo, userRepo, workspaceRepo, tokenService };
}

const payload = (over: Record<string, any> = {}) => ({
  sub: 'u-1',
  workspaceId: 'ws-1',
  apiKeyId: 'key-1',
  type: JwtType.API_KEY,
  ...over,
});

const activeRow = (over: Record<string, any> = {}) => ({
  id: 'key-1',
  name: 'k',
  creatorId: 'u-1',
  workspaceId: 'ws-1',
  expiresAt: null,
  lastUsedAt: null,
  deletedAt: null,
  ...over,
});

const activeUser = (over: Record<string, any> = {}) => ({
  id: 'u-1',
  workspaceId: 'ws-1',
  deactivatedAt: null,
  deletedAt: null,
  isAgent: false,
  ...over,
});

describe('ApiKeyService.validate', () => {
  it('returns { user, workspace } for a valid active key', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    userRepo.findById.mockResolvedValue(activeUser());

    const res = await service.validate(payload() as any);

    expect(res.user).toMatchObject({ id: 'u-1' });
    expect(res.workspace).toMatchObject({ id: 'ws-1' });
    // Loads isAgent so downstream provenance does not silently degrade.
    expect(userRepo.findById).toHaveBeenCalledWith('u-1', 'ws-1', {
      includeIsAgent: true,
    });
  });

  // --- Anti-enumeration: every deny is the SAME bare 401 -------------------
  const denyCases: Array<[string, (d: ReturnType<typeof makeDeps>) => void]> = [
    [
      'missing/orphaned row',
      (d) => d.apiKeyRepo.findById.mockResolvedValue(undefined),
    ],
    [
      'revoked (soft-deleted → findById returns undefined)',
      (d) => d.apiKeyRepo.findById.mockResolvedValue(undefined),
    ],
    [
      'expired (expires_at in the past)',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(
          activeRow({ expiresAt: new Date(Date.now() - 1000) }),
        );
        d.userRepo.findById.mockResolvedValue(activeUser());
      },
    ],
    [
      'disabled user',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow());
        d.userRepo.findById.mockResolvedValue(
          activeUser({ deactivatedAt: new Date() }),
        );
      },
    ],
    [
      'user not found',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow());
        d.userRepo.findById.mockResolvedValue(undefined);
      },
    ],
    [
      'creator/sub mismatch',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow({ creatorId: 'other' }));
        d.userRepo.findById.mockResolvedValue(activeUser());
      },
    ],
    [
      'workspace row missing',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow());
        d.userRepo.findById.mockResolvedValue(activeUser());
        d.workspaceRepo.findById.mockResolvedValue(undefined);
      },
    ],
    [
      'malformed payload (missing apiKeyId)',
      () => undefined,
    ],
  ];

  it.each(denyCases)(
    'throws a bare UnauthorizedException with NO message for: %s',
    async (label, arrange) => {
      const deps = makeDeps();
      arrange(deps);
      const p =
        label === 'malformed payload (missing apiKeyId)'
          ? (payload({ apiKeyId: undefined }) as any)
          : (payload() as any);

      const err = await deps.service.validate(p).catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      // Anti-enumeration: identical, class-less message for every failure mode.
      expect(err.message).toBe('Unauthorized');
    },
  );

  // --- Kill-switch removed: keys work with no env variable ------------------
  it('validates with no API_KEYS_ENABLED env (kill-switch fully removed)', async () => {
    // The service no longer takes EnvironmentService — there is no env gate left.
    const { service, apiKeyRepo, userRepo } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    userRepo.findById.mockResolvedValue(activeUser());

    await expect(service.validate(payload() as any)).resolves.toMatchObject({
      user: { id: 'u-1' },
    });
  });

  // --- Infra error propagates (5xx), NOT masked as 401 ---------------------
  it('PROPAGATES an infra (DB) error instead of masking it as 401', async () => {
    const { service, apiKeyRepo } = makeDeps();
    const boom = new Error('connection terminated');
    apiKeyRepo.findById.mockRejectedValue(boom);

    await expect(service.validate(payload() as any)).rejects.toBe(boom);
  });

  // --- No cache: revocation is immediate on the next call ------------------
  it('re-reads the row on every call (no validate cache → immediate revocation)', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    userRepo.findById.mockResolvedValue(activeUser());
    await service.validate(payload() as any);

    // Now the key is revoked (row invisible) — the very next call denies.
    apiKeyRepo.findById.mockResolvedValue(undefined);
    await expect(service.validate(payload() as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.findById).toHaveBeenCalledTimes(2);
  });

  // --- last_used_at is throttled + fire-and-forget -------------------------
  it('touches last_used_at when stale and skips when fresh', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    userRepo.findById.mockResolvedValue(activeUser());

    // Stale (never used) -> touch.
    apiKeyRepo.findById.mockResolvedValue(activeRow({ lastUsedAt: null }));
    await service.validate(payload() as any);
    expect(apiKeyRepo.touchLastUsed).toHaveBeenCalledTimes(1);

    // Fresh (used 1 minute ago) -> skip.
    apiKeyRepo.touchLastUsed.mockClear();
    apiKeyRepo.findById.mockResolvedValue(
      activeRow({ lastUsedAt: new Date(Date.now() - 60_000) }),
    );
    await service.validate(payload() as any);
    expect(apiKeyRepo.touchLastUsed).not.toHaveBeenCalled();
  });

  it('a failing last_used_at touch never fails the request', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow({ lastUsedAt: null }));
    userRepo.findById.mockResolvedValue(activeUser());
    apiKeyRepo.touchLastUsed.mockRejectedValue(new Error('write failed'));

    await expect(service.validate(payload() as any)).resolves.toMatchObject({
      user: { id: 'u-1' },
    });
  });

  // --- #558 deny-observability: replaces the deleted /mcp Basic limiter's
  // visibility. A revoked/dead key hammering validate() must not be SILENT: each
  // deny emits a rate-limited operator WARN keyed on (apiKeyId, reason) AND
  // increments api_key_auth_denied_total{reason}. The apiKeyId is only ever
  // logged AFTER the JWT signature was verified (validate is reached post-verify),
  // so it is a bounded, issued id — never an unverified attacker value. We assert
  // the LOG (the counter is a no-op unless METRICS_PORT is set), NOT the 401 body
  // (the response stays a uniform bare 401 — anti-enumeration).
  describe('deny-observability WARN (rate-limited, per apiKeyId+reason)', () => {
    // Reset the counter mock so each test asserts only ITS OWN deny increments,
    // not calls leaked from a sibling test (the mock is module-level).
    beforeEach(() => incDenied.mockClear());

    it('WARNs with the reason + apiKeyId on a revoked/missing key deny', async () => {
      const { service, apiKeyRepo } = makeDeps();
      const warn = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
      apiKeyRepo.findById.mockResolvedValue(undefined); // revoked/missing row

      await expect(
        service.validate(payload({ apiKeyId: 'key-XYZ' }) as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('reason=revoked_or_missing');
      expect(msg).toContain('apiKeyId=key-XYZ');
      // The prom counter is incremented with the EXACT reason (unthrottled,
      // unlike the WARN). Deleting the incApiKeyAuthDenied line fails here.
      expect(incDenied).toHaveBeenCalledWith('revoked_or_missing');
    });

    it('is rate-limited: a second identical deny within the window does NOT re-WARN', async () => {
      const { service, apiKeyRepo } = makeDeps();
      const warn = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
      apiKeyRepo.findById.mockResolvedValue(undefined);

      const p = payload({ apiKeyId: 'key-HAMMER' }) as any;
      await service.validate(p).catch(() => undefined);
      await service.validate(p).catch(() => undefined);
      await service.validate(p).catch(() => undefined);

      // Three denies for the SAME (apiKeyId, reason) → exactly ONE WARN line.
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a malformed payload (no apiKeyId) WARNs with apiKeyId=unknown', async () => {
      const { service } = makeDeps();
      const warn = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.validate(payload({ apiKeyId: undefined }) as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('reason=malformed_payload');
      expect(msg).toContain('apiKeyId=unknown');
      // Counter incremented with the EXACT reason for this second branch too.
      expect(incDenied).toHaveBeenCalledWith('malformed_payload');
    });
  });
});

describe('ApiKeyService.create (mint-then-insert, no exp)', () => {
  it('mints the JWT BEFORE inserting the row and returns the token once', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    const order: string[] = [];
    tokenService.generateApiToken.mockImplementation(async () => {
      order.push('mint');
      return 'tok';
    });
    apiKeyRepo.insert.mockImplementation(async (row: any) => {
      order.push('insert');
      return { ...row, createdAt: new Date() };
    });

    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;
    const res = await service.create(user, 'my key');

    expect(order).toEqual(['mint', 'insert']);
    expect(res.token).toBe('tok');
    // The id is generated before minting and reused for the row.
    const mintArg = tokenService.generateApiToken.mock.calls[0][0];
    const insertArg = apiKeyRepo.insert.mock.calls[0][0];
    expect(mintArg.apiKeyId).toBe(insertArg.id);
  });

  it('applies the 1-year default when expiresAt is undefined', async () => {
    const { service, apiKeyRepo } = makeDeps();
    apiKeyRepo.insert.mockImplementation(async (row: any) => row);
    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;

    await service.create(user, 'k');

    const insertArg = apiKeyRepo.insert.mock.calls[0][0];
    const days =
      (insertArg.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(367);
  });

  it('honors an explicit null (unlimited)', async () => {
    const { service, apiKeyRepo } = makeDeps();
    apiKeyRepo.insert.mockImplementation(async (row: any) => row);
    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;

    await service.create(user, 'k', null);

    expect(apiKeyRepo.insert.mock.calls[0][0].expiresAt).toBeNull();
  });

  it('does NOT insert a row when minting fails (mint-then-insert → inert)', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    tokenService.generateApiToken.mockRejectedValue(new Error('mint failed'));
    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;

    await expect(service.create(user, 'k')).rejects.toThrow('mint failed');
    expect(apiKeyRepo.insert).not.toHaveBeenCalled();
  });
});

/**
 * ApiKeyService.reveal — the KEY-STATE gate for the copyable-key flow. Owner-only
 * (even for an admin), and EVERY negative is a uniform NotFoundException so there
 * is no existence/state oracle. Re-mint is deterministic (delegated to
 * TokenService); here we only assert the gate + normalization.
 */
describe('ApiKeyService.reveal', () => {
  const caller = (over: Record<string, any> = {}) =>
    ({ id: 'u-1', email: 'u@x.io', workspaceId: 'ws-1', ...over }) as any;

  it('re-mints and returns the token for a live key owned by the caller', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    tokenService.generateApiToken.mockResolvedValue('remint.tok');

    const token = await service.reveal({
      apiKeyId: 'key-1',
      user: caller(),
      workspaceId: 'ws-1',
    });

    expect(token).toBe('remint.tok');
    // Re-mints against the SAME id + the caller (== creator) so the value matches.
    expect(tokenService.generateApiToken).toHaveBeenCalledWith({
      apiKeyId: 'key-1',
      user: expect.objectContaining({ id: 'u-1' }),
      workspaceId: 'ws-1',
    });
  });

  it('404 for a missing/revoked key (findById returns undefined)', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(undefined);

    await expect(
      service.reveal({ apiKeyId: 'key-1', user: caller(), workspaceId: 'ws-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // No re-mint on any negative.
    expect(tokenService.generateApiToken).not.toHaveBeenCalled();
  });

  it("404 for another user's key — owner-only, even for an admin", async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    // The caller is a workspace admin (irrelevant here — reveal ignores CASL).
    apiKeyRepo.findById.mockResolvedValue(activeRow({ creatorId: 'someone-else' }));

    await expect(
      service.reveal({ apiKeyId: 'key-1', user: caller(), workspaceId: 'ws-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tokenService.generateApiToken).not.toHaveBeenCalled();
  });

  it('404 for an expired key (expiry read from the row) — no dead token issued', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(
      activeRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(
      service.reveal({ apiKeyId: 'key-1', user: caller(), workspaceId: 'ws-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tokenService.generateApiToken).not.toHaveBeenCalled();
  });

  it('normalizes a disabled-creator ForbiddenException (403) to a uniform 404', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    // generateApiToken throws ForbiddenException when isUserDisabled(user).
    tokenService.generateApiToken.mockRejectedValue(new ForbiddenException());

    await expect(
      service.reveal({ apiKeyId: 'key-1', user: caller(), workspaceId: 'ws-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('propagates an UNEXPECTED re-mint error (not masked as 404)', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    const boom = new Error('signer exploded');
    tokenService.generateApiToken.mockRejectedValue(boom);

    await expect(
      service.reveal({ apiKeyId: 'key-1', user: caller(), workspaceId: 'ws-1' }),
    ).rejects.toBe(boom);
  });
});
