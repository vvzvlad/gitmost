// Unit tests for the git-sync control plane. The engine's `runCycle`
// (which owns the PULL->PUSH branch choreography) is mocked so we exercise ONLY
// the orchestrator's wiring: gating, the Redis leader lock + in-process mutex
// (via SpaceLockService),
// the remote-template substitution in the settings it hands the engine, the
// external-push ingest, and the idempotent interval lifecycle. The cycle
// mechanics themselves are covered by the engine's own cycle round-trip spec.
//
// The engine mock must be declared before importing the orchestrator so the
// runtime `loadGitSync()` bridge resolves to the mocked `runCycle` (the ESM
// `@docmost/git-sync` package cannot be `require()`d under jest). The `mock`
// prefix lets the hoisted factory reference it.
const mockRunCycle = jest.fn();

jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    runCycle: mockRunCycle,
  })),
}));

import { Logger } from '@nestjs/common';
import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  CompiledQuery,
} from 'kysely';
import {
  GitSyncOrchestrator,
  GitSyncLockHeldError,
} from './git-sync.orchestrator';
import { SpaceLockService } from './space-lock.service';

type AnyMock = jest.Mock;

const runCycleMock = mockRunCycle as unknown as AnyMock;

/** The default happy-path cycle result the engine returns. */
const OK_CYCLE = {
  ran: true,
  pull: { written: 0, deleted: 0, conflict: false },
  push: { mode: 'apply', failures: 0 },
};

interface BuildOptions {
  /** Env tunables (only the load-bearing ones are surfaced as overrides). */
  enabled?: boolean;
  serviceUserId?: string | undefined;
  remoteTemplate?: string | undefined;
  dataDir?: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  /** A hook applied to the fake vault so a test can override its behaviour. */
  vaultOverrides?: Record<string, unknown>;
  /**
   * The row `buildSettings` reads for the per-space `autoMergeConflicts` flag
   * (`executeTakeFirst` on the `autoMergeConflicts`-aliased query). Default: the
   * SAFE off value. Pass `undefined` to model a missing row (no space / no
   * settings).
   */
  settingsRow?: { autoMergeConflicts: boolean } | undefined;
  /**
   * The per-space opt-in flag `runOnce` reads via `isSpaceGitSyncEnabled`
   * (`executeTakeFirst` on the `enabled`-aliased query — a DIFFERENT query from
   * the `autoMergeConflicts` read above; commit c838fdee added it). Default
   * `true` so a build() space passes the per-space gate and the cycle proceeds.
   * Set `false` to model a space that did NOT opt in (skipped:'space-not-enabled').
   */
  spaceEnabled?: boolean;
}

interface Built {
  orchestrator: GitSyncOrchestrator;
  env: Record<string, AnyMock>;
  dataSource: { bind: AnyMock };
  client: Record<string, AnyMock>;
  vaultRegistry: { getVault: AnyMock; vaultPath: AnyMock };
  vault: Record<string, AnyMock>;
  scheduler: Record<string, AnyMock>;
  redis: { set: AnyMock; eval: AnyMock };
  redisService: { getOrThrow: AnyMock };
  db: unknown;
}

function build(opts: BuildOptions = {}): Built {
  const {
    enabled = true,
    remoteTemplate = undefined,
    dataDir = '/vaults',
    pollIntervalMs = 15000,
    debounceMs = 2000,
    vaultOverrides = {},
    spaceEnabled = true,
  } = opts;
  // Distinguish "key omitted" (default off row) from "key present but undefined"
  // (a deliberately MISSING settings row).
  const settingsRow =
    'settingsRow' in opts ? opts.settingsRow : { autoMergeConflicts: false };
  // Distinguish "key omitted" (default to a valid id) from "key present but
  // undefined" (the no-service-user test deliberately sets it undefined).
  const serviceUserId = 'serviceUserId' in opts ? opts.serviceUserId : 'svc-user';

  const env: Record<string, AnyMock> = {
    isGitSyncEnabled: jest.fn(() => enabled),
    getGitSyncServiceUserId: jest.fn(() => serviceUserId),
    getGitSyncRemoteTemplate: jest.fn(() => remoteTemplate),
    getGitSyncDataDir: jest.fn(() => dataDir),
    getGitSyncPollIntervalMs: jest.fn(() => pollIntervalMs),
    getGitSyncDebounceMs: jest.fn(() => debounceMs),
  };

  // The read-side / write-side client the datasource hands back.
  const client: Record<string, AnyMock> = {
    listSpaceTree: jest.fn(async () => ({ pages: [], complete: true })),
    // Historical behavior: every candidate id is a real page row. Present so the
    // fake does not rely on `listTrackedFiles -> []` to avoid the ghost-guard
    // probe, and won't break if a future test seeds tracked files.
    pageIdsExist: jest.fn(async (ids: string[]) => ids),
    deletePage: jest.fn(async () => undefined),
    createPage: jest.fn(async () => undefined),
    updatePageBody: jest.fn(async () => undefined),
  };
  const dataSource = { bind: jest.fn(() => client) };

  // The fake VaultGit: every method the orchestrator calls is a jest.fn.
  const vault: Record<string, AnyMock> = {
    assertGitAvailable: jest.fn(async () => undefined),
    ensureRepo: jest.fn(async () => undefined),
    isMergeInProgress: jest.fn(async () => false),
    ensureBranch: jest.fn(async () => undefined),
    checkout: jest.fn(async () => undefined),
    listTrackedFiles: jest.fn(async () => []),
    pinHeadToMain: jest.fn(async () => undefined),
    ...(vaultOverrides as Record<string, AnyMock>),
  };
  const vaultRegistry = {
    getVault: jest.fn(async () => vault),
    vaultPath: jest.fn((spaceId: string) => `${dataDir}/${spaceId}`),
  };

  const scheduler: Record<string, AnyMock> = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  };

  const redis = {
    // Default: lock acquired. Tests override per-case.
    set: jest.fn(async () => 'OK'),
    eval: jest.fn(async () => 1),
  };
  const redisService = { getOrThrow: jest.fn(() => redis) };

  // Chainable Kysely stub. TWO distinct single-row queries run through the same
  // builder and both end in `executeTakeFirst`, so the stub must tell them apart
  // by the column ALIAS the real code selects (they are otherwise identical):
  //   - `isSpaceGitSyncEnabled` (per-space opt-in gate in `runOnce`, added by
  //     c838fdee): `.select(sql\`...->>'enabled' = 'true'\`.as('enabled'))` ->
  //     the code reads `row?.enabled`. Return `{ enabled: spaceEnabled }`.
  //   - `buildSettings`: `.select(sql\`...->>'autoMergeConflicts' = 'true'\`
  //     .as('autoMergeConflicts'))` -> the code reads `row?.autoMergeConflicts`.
  //     Return `settingsRow` (default SAFE off; `undefined` models a missing row).
  // `enabledSpaces` uses `.select([...strings]).execute()` (no alias, no
  // executeTakeFirst) and is stubbed/replaced in the tests that exercise it.
  const db = (() => {
    let lastAlias: string | undefined;
    const aliasOf = (sel: unknown): string | undefined => {
      try {
        const node = (sel as { toOperationNode?: () => any })?.toOperationNode?.();
        return node?.kind === 'AliasNode' ? node.alias?.name : undefined;
      } catch {
        return undefined;
      }
    };
    const builder: any = {
      select: (sel: unknown) => {
        const alias = aliasOf(sel);
        if (alias) lastAlias = alias;
        return builder;
      },
      where: () => builder,
      executeTakeFirst: async () =>
        lastAlias === 'enabled' ? { enabled: spaceEnabled } : settingsRow,
      execute: async () => [],
    };
    return { selectFrom: () => builder };
  })();

  // The REAL SpaceLockService, constructed against the mock redis above, so all
  // existing lock assertions (lock-held, in-progress, leader lock, release CAS,
  // heartbeat) still exercise the same `redis.set`/`redis.eval` mock unchanged.
  const spaceLock = new SpaceLockService(redisService as any);

  const orchestrator = new GitSyncOrchestrator(
    env as any,
    dataSource as any,
    vaultRegistry as any,
    scheduler as any,
    spaceLock as any,
    db as any,
  );

  return {
    orchestrator,
    env,
    dataSource,
    client,
    vaultRegistry,
    vault,
    scheduler,
    redis,
    redisService,
    db,
  };
}

/** The engine runs a clean cycle by default. */
function primeEngineHappyPath(): void {
  runCycleMock.mockResolvedValue(OK_CYCLE);
}

beforeEach(() => {
  jest.clearAllMocks();
  primeEngineHappyPath();
});

describe('GitSyncOrchestrator', () => {
  describe('runOnce gating', () => {
    it("short-circuits with skipped:'disabled' when git-sync is disabled", async () => {
      const { orchestrator, redis, vaultRegistry } = build({ enabled: false });
      const res = await orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({ spaceId: 'space-1', ran: false, skipped: 'disabled' });
      // No lock, no vault work performed.
      expect(redis.set).not.toHaveBeenCalled();
      expect(vaultRegistry.getVault).not.toHaveBeenCalled();
    });

    it("returns skipped:'no-service-user' when the service user id is falsy", async () => {
      const { orchestrator, redis } = build({ serviceUserId: undefined });
      const res = await orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'no-service-user',
      });
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('in-process mutex', () => {
    it("a second runOnce while the first is in-flight returns skipped:'in-progress'", async () => {
      const built = build();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Hang the first cycle inside driveCycle by stalling getVault.
      built.vaultRegistry.getVault.mockImplementationOnce(async () => {
        await gate;
        return built.vault;
      });

      const first = built.orchestrator.runOnce('space-1', 'ws-1');
      // Let the first call enter the running set + acquire the lock.
      await Promise.resolve();
      await Promise.resolve();

      const second = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(second).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'in-progress',
      });

      release();
      await first;
    });
  });

  describe('redis leader lock', () => {
    it("returns skipped:'lock-held' and cleans up the mutex when the lock is not acquired", async () => {
      const built = build();
      // First acquire fails (not 'OK'); a later acquire succeeds.
      built.redis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValue('OK');

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'lock-held',
      });
      // The mutex must be clear: a subsequent call can acquire + run.
      const res2 = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res2.ran).toBe(true);
      expect(res2.skipped).toBeUndefined();
    });
  });

  describe('poisoned-space protection', () => {
    it('releases the lock and clears the mutex when the cycle throws, returning { error }', async () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      runCycleMock.mockRejectedValueOnce(new Error('boom'));

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res.ran).toBe(false);
      expect(res.error).toBe('boom');
      // CAS release was invoked (eval) and the space is no longer "running":
      expect(built.redis.eval).toHaveBeenCalledTimes(1);

      // A subsequent call can re-acquire (mutex cleared after the throw).
      runCycleMock.mockResolvedValue(OK_CYCLE);
      const res2 = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res2.ran).toBe(true);
    });
  });

  describe('cycle wiring', () => {
    it('drives runCycle with the space vault, the bound client, and settings', async () => {
      const built = build();
      await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(runCycleMock).toHaveBeenCalledTimes(1);
      const [deps] = runCycleMock.mock.calls[0];
      expect(deps.spaceId).toBe('space-1');
      expect(deps.vault).toBe(built.vault);
      expect(deps.client).toBe(built.client);
      expect(deps.settings.vaultPath).toBe('/vaults/space-1');
      // The bound datasource identity is the (workspace, service-user) pair,
      // plus the reconciling spaceId used by deletePage's cross-move guard.
      expect(built.dataSource.bind).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        userId: 'svc-user',
        spaceId: 'space-1',
      });
    });

    it('threads autoMergeConflicts:true from the space settings row into the engine settings', async () => {
      const built = build({ settingsRow: { autoMergeConflicts: true } });
      await built.orchestrator.runOnce('space-1', 'ws-1');
      const [deps] = runCycleMock.mock.calls[0];
      expect(deps.settings.autoMergeConflicts).toBe(true);
    });

    it('defaults autoMergeConflicts to false when the settings row is missing', async () => {
      const built = build({ settingsRow: undefined });
      await built.orchestrator.runOnce('space-1', 'ws-1');
      const [deps] = runCycleMock.mock.calls[0];
      expect(deps.settings.autoMergeConflicts).toBe(false);
    });

    it("escalates a divergent-`docmost` push refusal to WARN and surfaces the flag in the status", async () => {
      const built = build();
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      // The engine refused to fast-forward a divergent `docmost` mirror (§5).
      runCycleMock.mockResolvedValue({ ...OK_CYCLE, divergentDocmost: true });

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');

      // The flag is surfaced in the returned status (consumable by /status).
      expect(res.divergentDocmost).toBe(true);
      // And escalated from the engine's info `log` to a WARN naming the space.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('DIVERGENT'),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('space-1'));
    });

    it("does NOT warn when the cycle is clean (divergentDocmost falsy)", async () => {
      const built = build();
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      runCycleMock.mockResolvedValue(OK_CYCLE);

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(res.divergentDocmost).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('DIVERGENT'),
      );
    });

    it("surfaces the engine's skipped status (e.g. merge-in-progress) verbatim", async () => {
      const built = build();
      runCycleMock.mockResolvedValue({ ran: false, skipped: 'merge-in-progress' });

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'merge-in-progress',
      });
    });
  });

  describe('ingestExternalPush', () => {
    it('streams the receive-pack FIRST, then runs the Docmost cycle', async () => {
      const order: string[] = [];
      const built = build();
      runCycleMock.mockImplementation(async () => {
        order.push('cycle');
        return OK_CYCLE;
      });
      const runReceivePack = jest.fn(async () => {
        order.push('receive-pack');
      });

      await built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack);

      expect(runReceivePack).toHaveBeenCalledTimes(1);
      // The cycle only runs AFTER the push commits land on main.
      expect(order).toEqual(['receive-pack', 'cycle']);
    });

    // Explicit timeout: ingestExternalPush exhausts the full bounded
    // acquire-retry budget (GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS = 5_000ms) before it
    // gives up and throws, which races jest's DEFAULT 5_000ms test timeout — flaky
    // on a loaded/slow runner. Give it headroom so it deterministically observes
    // the eventual LockHeldError instead of timing out first.
    it('throws GitSyncLockHeldError and does NOT run the receive-pack when the lock is held', async () => {
      const built = build();
      built.redis.set.mockResolvedValue(null); // acquire fails → lock-held
      const runReceivePack = jest.fn(async () => undefined);

      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).rejects.toBeInstanceOf(GitSyncLockHeldError);

      // We must never write to the working tree concurrently with a cycle.
      expect(runReceivePack).not.toHaveBeenCalled();
      expect(runCycleMock).not.toHaveBeenCalled();
    }, 15_000);

    it('swallows a post-push cycle error (the push is durable; poll retries)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const built = build();
      // The cycle throws AFTER the receive-pack already succeeded.
      runCycleMock.mockRejectedValueOnce(new Error('cycle boom'));
      const runReceivePack = jest.fn(async () => undefined);

      // Does NOT throw — the durable push must not be reported as failed.
      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).resolves.toBeUndefined();
      expect(runReceivePack).toHaveBeenCalledTimes(1);
      // Lock was still released (CAS eval) despite the cycle error.
      expect(built.redis.eval).toHaveBeenCalled();
    });

    it('runs the receive-pack but SKIPS the cycle when no service user is configured', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const built = build({ serviceUserId: undefined });
      const runReceivePack = jest.fn(async () => undefined);

      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).resolves.toBeUndefined();
      // The push is durable on main; the immediate cycle is skipped, not failed.
      expect(runReceivePack).toHaveBeenCalledTimes(1);
      expect(runCycleMock).not.toHaveBeenCalled();
    });

    it('refuses (LockHeldError) and runs nothing when git-sync is globally disabled', async () => {
      const built = build({ enabled: false });
      const runReceivePack = jest.fn(async () => undefined);

      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).rejects.toBeInstanceOf(GitSyncLockHeldError);
      expect(runReceivePack).not.toHaveBeenCalled();
      expect(built.redis.set).not.toHaveBeenCalled();
    });
  });

  describe('remote template substitution', () => {
    it('substitutes {spaceId} into the gitRemote settings handed to the engine', async () => {
      const built = build({ remoteTemplate: 'git@h:vault-{spaceId}.git' });
      await built.orchestrator.runOnce('space-42', 'ws-1');
      const [deps] = runCycleMock.mock.calls[0];
      expect(deps.settings.gitRemote).toBe('git@h:vault-space-42.git');
    });
  });

  describe('serveReadAdvertisement (bug #3 — stable advertised HEAD)', () => {
    it('pins HEAD to main and serves under the space lock', async () => {
      const built = build();
      const serve = jest.fn(async () => undefined);

      await built.orchestrator.serveReadAdvertisement('space-1', serve);

      // The lock was taken (redis SET NX) and released (CAS eval).
      expect(built.redis.set).toHaveBeenCalledTimes(1);
      expect(built.redis.eval).toHaveBeenCalled();
      // HEAD pinned BEFORE serving, on the right vault.
      expect(built.vaultRegistry.getVault).toHaveBeenCalledWith('space-1');
      expect(built.vault.pinHeadToMain).toHaveBeenCalledTimes(1);
      expect(serve).toHaveBeenCalledTimes(1);
      const pinOrder = built.vault.pinHeadToMain.mock.invocationCallOrder[0];
      const serveOrder = serve.mock.invocationCallOrder[0];
      expect(pinOrder).toBeLessThan(serveOrder);
    });

    it('serves WITHOUT a pin/lock when git-sync is globally disabled', async () => {
      const built = build({ enabled: false });
      const serve = jest.fn(async () => undefined);

      await built.orchestrator.serveReadAdvertisement('space-1', serve);

      expect(serve).toHaveBeenCalledTimes(1);
      expect(built.redis.set).not.toHaveBeenCalled();
      expect(built.vault.pinHeadToMain).not.toHaveBeenCalled();
    });
  });

  describe('module lifecycle', () => {
    it('registers exactly one interval on init and tears it down idempotently on destroy', () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      built.orchestrator.onModuleInit();
      expect(built.scheduler.addInterval).toHaveBeenCalledTimes(1);
      const [name] = built.scheduler.addInterval.mock.calls[0];

      built.orchestrator.onModuleDestroy();
      expect(built.scheduler.deleteInterval).toHaveBeenCalledTimes(1);
      expect(built.scheduler.deleteInterval).toHaveBeenCalledWith(name);

      // A second destroy is a no-op (guard against double-delete).
      built.orchestrator.onModuleDestroy();
      expect(built.scheduler.deleteInterval).toHaveBeenCalledTimes(1);
    });

    it('registers nothing on init when git-sync is disabled', () => {
      const built = build({ enabled: false });
      built.orchestrator.onModuleInit();
      expect(built.scheduler.addInterval).not.toHaveBeenCalled();
    });
  });

  // The poll-safety backstop: each tick enumerates the STRICT opt-in spaces and
  // reconciles each one under its own lock. We drive the private `pollTick()`
  // directly and (separately) compile `enabledSpaces()` to assert its opt-in SQL.
  describe('pollTick + enabledSpaces (strict opt-in backstop)', () => {
    it('runs runOnce exactly once per enabled space, with the right (spaceId, workspaceId)', async () => {
      const built = build();
      // Isolate the tick wiring from the cycle machinery: stub the enumeration
      // and count runOnce (it never throws; here we don't exercise its body).
      const runOnce = jest
        .spyOn(built.orchestrator, 'runOnce')
        .mockResolvedValue({ spaceId: 'x', ran: true });
      jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockResolvedValue([
          { spaceId: 'space-1', workspaceId: 'ws-1' },
          { spaceId: 'space-2', workspaceId: 'ws-2' },
        ]);

      await (built.orchestrator as any).pollTick();

      expect(runOnce).toHaveBeenCalledTimes(2);
      // Per-space isolation: each space is reconciled with its OWN workspace id.
      expect(runOnce).toHaveBeenNthCalledWith(1, 'space-1', 'ws-1');
      expect(runOnce).toHaveBeenNthCalledWith(2, 'space-2', 'ws-2');
    });

    it('skips an overlapping tick while a previous pass is still in flight (re-entrancy guard)', async () => {
      const built = build();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Stall the first pass inside enabledSpaces so a second tick fires while it
      // is still running.
      const enabledSpy = jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockImplementation(async () => {
          await gate;
          return [{ spaceId: 'space-1', workspaceId: 'ws-1' }];
        });
      const runOnce = jest
        .spyOn(built.orchestrator, 'runOnce')
        .mockResolvedValue({ spaceId: 'space-1', ran: true });

      const first = (built.orchestrator as any).pollTick();
      await Promise.resolve(); // let the first pass set polling=true + await gate

      // A second tick during the first must be skipped: it never even enumerates.
      await (built.orchestrator as any).pollTick();
      expect(enabledSpy).toHaveBeenCalledTimes(1);

      release();
      await first;
      expect(runOnce).toHaveBeenCalledTimes(1);

      // After the first pass cleared the flag, a fresh tick runs normally.
      await (built.orchestrator as any).pollTick();
      expect(enabledSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT throw and runs nothing when the enabled-spaces query throws (try/catch backstop)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const built = build();
      const runOnce = jest.spyOn(built.orchestrator, 'runOnce');
      jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockRejectedValue(new Error('db down'));

      // A failed enumeration must never break the interval — pollTick swallows it.
      await expect(
        (built.orchestrator as any).pollTick(),
      ).resolves.toBeUndefined();
      expect(runOnce).not.toHaveBeenCalled();
    });

    it('early-returns (no enumeration, no runOnce) when git-sync is disabled', async () => {
      const built = build({ enabled: false });
      const enabled = jest.spyOn(built.orchestrator as any, 'enabledSpaces');
      const runOnce = jest.spyOn(built.orchestrator, 'runOnce');

      await (built.orchestrator as any).pollTick();

      // Gated on the master switch before any DB work.
      expect(enabled).not.toHaveBeenCalled();
      expect(runOnce).not.toHaveBeenCalled();
    });

    it('compiles the STRICT opt-in enumeration SQL (spaces, deletedAt is null, enabled flag)', async () => {
      // Inject a compile-only Kysely (DummyDriver) whose `log` hook captures the
      // exact SQL `enabledSpaces()` runs — no fake builder, the real query is
      // compiled. DummyDriver yields no rows; we only assert the SQL shape.
      const built = build();
      let captured: CompiledQuery | undefined;
      const compileDb = new Kysely<any>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (d) => new PostgresIntrospector(d),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
        log: (event) => {
          if (event.level === 'query') captured = event.query as CompiledQuery;
        },
      });
      // Swap the orchestrator's injected db for the compile-only instance.
      (built.orchestrator as any).db = compileDb;

      const rows = await (built.orchestrator as any).enabledSpaces();
      // DummyDriver returns no rows -> empty opt-in list (the no-space default).
      expect(rows).toEqual([]);

      expect(captured).toBeDefined();
      const sql = captured!.sql.replace(/\s+/g, ' ');
      expect(sql).toContain('from "spaces"');
      // deletedAt-is-null guard (live spaces only).
      expect(sql).toContain('"deletedAt" is null');
      // STRICT per-space opt-in: the raw jsonb flag predicate, verbatim.
      expect(sql).toContain(`settings->'gitSync'->>'enabled' = 'true'`);
    });
  });
});
