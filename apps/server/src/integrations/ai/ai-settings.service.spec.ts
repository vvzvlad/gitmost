import { AiSettingsService, parsePositiveInt } from './ai-settings.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { AiProviderCredentialsRepo } from '@docmost/db/repos/ai-chat/ai-provider-credentials.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SecretBoxService } from '../crypto/secret-box';
import { EmbeddingReindexProgressService } from './embedding-reindex-progress.service';
import type { Queue } from 'bullmq';

/**
 * Round-trip coercion for numeric `::text` provider settings (e.g.
 * chatContextWindow). Values are stored as text and read back as strings, so
 * this guards the read path the DTO write-validation does not cover: a silent
 * loss of `Math.floor` or a `> 0` → `>= 0` drift would otherwise go unnoticed.
 */
describe('parsePositiveInt', () => {
  it('keeps a valid positive integer string', () => {
    expect(parsePositiveInt('200000')).toBe(200000);
  });

  it('floors a fractional string', () => {
    expect(parsePositiveInt('1.9')).toBe(1);
    expect(parsePositiveInt('1.0')).toBe(1);
  });

  it('returns undefined for zero', () => {
    expect(parsePositiveInt('0')).toBeUndefined();
  });

  it('returns undefined for a negative value', () => {
    expect(parsePositiveInt('-5')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parsePositiveInt('')).toBeUndefined();
  });

  it('returns undefined for a non-numeric string', () => {
    expect(parsePositiveInt('abc')).toBeUndefined();
  });

  it('returns undefined for undefined / null', () => {
    expect(parsePositiveInt(undefined)).toBeUndefined();
    expect(parsePositiveInt(null)).toBeUndefined();
  });

  it('accepts a real number too (not only ::text strings)', () => {
    expect(parsePositiveInt(42)).toBe(42);
  });
});

/**
 * getMasked must surface the LIVE reindex run progress while a reindex is active
 * (so the "Indexed X of Y" counter can climb 0 -> total), and fall back to the
 * steady-state DB coverage count (countIndexedPages / countEmbeddablePages) when
 * no reindex is running. This is the server side of the fix for the counter that
 * otherwise stays stuck at "478 of 478" the whole reindex.
 */
describe('AiSettingsService.getMasked reindex progress', () => {
  const WORKSPACE_ID = 'ws-1';

  function makeService(activeFingerprint: string | null = null) {
    // No driver configured -> the credentials lookup is skipped, keeping the
    // setup minimal; we only care about the indexed/total numbers here.
    const workspaceRepo = {
      findById: jest.fn().mockResolvedValue({ settings: {} }),
      // #599: the ACTIVE generation pointer — the steady-state numerator is scoped
      // to it (see the R8a tests below).
      getEmbeddingGeneration: jest.fn().mockResolvedValue({
        activeFingerprint,
        activeModel: null,
        coverageTotal: null,
        coverageEmbeddable: null,
      }),
    };
    const aiAgentRoleRepo = {};
    const aiProviderCredentialsRepo = { find: jest.fn() };
    const pageEmbeddingRepo = {
      countIndexedPages: jest.fn().mockResolvedValue(478),
      // Only the ACTIVE generation's pages: mid-swap this is far below the
      // generation-blind count above.
      countPagesByFingerprint: jest.fn().mockResolvedValue(120),
    };
    const pageRepo = {
      countEmbeddablePages: jest.fn().mockResolvedValue(478),
    };
    const secretBox = {};
    const reindexProgress = {
      get: jest.fn().mockResolvedValue(null),
    };
    const aiQueue = {};

    const service = new AiSettingsService(
      workspaceRepo as unknown as WorkspaceRepo,
      aiAgentRoleRepo as unknown as AiAgentRoleRepo,
      aiProviderCredentialsRepo as unknown as AiProviderCredentialsRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      pageRepo as unknown as PageRepo,
      secretBox as unknown as SecretBoxService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
      aiQueue as unknown as Queue,
    );
    return { service, reindexProgress, pageEmbeddingRepo };
  }

  it('reports the live run numbers when a reindex progress record is active', async () => {
    const { service, reindexProgress } = makeService();
    // Use a progress.total (500) DISTINCT from the DB count (478) so the test
    // actually pins the progress.total branch rather than coincidentally
    // matching the DB fallback. With fix #1 the two sources agree in practice,
    // but getMasked must still return progress.total when a record is active.
    const startedAt = Date.now();
    reindexProgress.get.mockResolvedValue({
      total: 500,
      done: 120,
      startedAt,
      runId: 'run-abc',
    });

    const masked = await service.getMasked(WORKSPACE_ID);

    expect(masked.indexedPages).toBe(120); // progress.done, not DB 478
    expect(masked.totalPages).toBe(500); // progress.total, not DB 478
    expect(masked.reindexing).toBe(true);
    // The status payload must carry the run identity so the client can key its
    // poll on it (a changed runId => a NEW run).
    expect(masked.runId).toBe('run-abc');
    expect(masked.reindexStartedAt).toBe(startedAt);
  });

  it('falls back to countIndexedPages when no reindex is active AND no generation pointer exists', async () => {
    const { service, reindexProgress } = makeService(null);
    reindexProgress.get.mockResolvedValue(null);

    const masked = await service.getMasked(WORKSPACE_ID);

    // Legacy / fresh workspace: no active fingerprint to scope to, so the
    // generation-blind count is the only meaningful number (pre-#599 behavior).
    expect(masked.indexedPages).toBe(478);
    expect(masked.totalPages).toBe(478);
    expect(masked.reindexing).toBe(false);
    // No active run -> no run identity surfaced (the client keeps its prior
    // steady-state behaviour).
    expect(masked.runId).toBeUndefined();
    expect(masked.reindexStartedAt).toBeUndefined();
  });

  it('#599 R8a — counts only the ACTIVE generation, so the panel cannot claim "478 of 478" mid-swap', async () => {
    const { service, reindexProgress, pageEmbeddingRepo } = makeService('fp-A');
    reindexProgress.get.mockResolvedValue(null);

    const masked = await service.getMasked(WORKSPACE_ID);

    // NON-VACUITY: countIndexedPages() is generation-blind — during a model swap the
    // half-built TARGET generation's rows counted toward it, so the admin panel
    // showed a complete "Indexed 478 of 478" bar while the search API reported
    // `semantic.state: stale` for the same workspace. The numerator now tracks the
    // generation that is actually SERVED.
    expect(pageEmbeddingRepo.countPagesByFingerprint).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'fp-A',
    );
    expect(pageEmbeddingRepo.countIndexedPages).not.toHaveBeenCalled();
    expect(masked.indexedPages).toBe(120);
    expect(masked.totalPages).toBe(478);
  });
});

/**
 * reindex() must seed a live progress record (done=0) BEFORE enqueueing so the
 * first status poll shows 0 — but ONLY when no run is already active, since
 * aiQueue.add() de-duplicates a running reindex and a re-seed would reset the
 * visible counter to 0 while the live worker keeps incrementing from its real
 * position.
 */
describe('AiSettingsService.reindex progress seed', () => {
  const WORKSPACE_ID = 'ws-1';

  function makeService() {
    const order: string[] = [];
    const aiQueue = {
      remove: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockImplementation(async () => {
        order.push('add');
      }),
    };
    const pageRepo = {
      countEmbeddablePages: jest.fn().mockResolvedValue(478),
    };
    const reindexProgress = {
      // Default: no active run -> seed should happen.
      get: jest.fn().mockResolvedValue(null),
      start: jest.fn().mockImplementation(async () => {
        order.push('start');
      }),
      clear: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AiSettingsService(
      {} as unknown as WorkspaceRepo,
      {} as unknown as AiAgentRoleRepo,
      {} as unknown as AiProviderCredentialsRepo,
      {} as unknown as PageEmbeddingRepo,
      pageRepo as unknown as PageRepo,
      {} as unknown as SecretBoxService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
      aiQueue as unknown as Queue,
    );
    return { service, aiQueue, pageRepo, reindexProgress, order };
  }

  it('seeds progress (workspace, count) BEFORE enqueue when no run is active', async () => {
    const { service, aiQueue, reindexProgress, order } = makeService();

    await service.reindex(WORKSPACE_ID);

    // The pre-seed carries the real page count AND a SHORT ttl (3rd arg) so a
    // de-duplicated enqueue against a just-finishing job can't leave a phantom
    // "reindexing: 0 of N" stuck for the full record TTL (F10).
    expect(reindexProgress.start).toHaveBeenCalledWith(
      WORKSPACE_ID,
      478,
      expect.any(Number),
    );
    const ttl = reindexProgress.start.mock.calls[0][2];
    // Short pre-seed TTL, distinct from the full 1h (3600s) record TTL, but
    // pinned to the client poll cap (120s) so a still-pending run can't expire
    // into a false "done" while the client is still polling (F11).
    expect(ttl).toBe(120);
    expect(aiQueue.add).toHaveBeenCalledTimes(1);
    // Seed must precede the enqueue so the first poll already reports done=0.
    expect(order).toEqual(['start', 'add']);

    // #599 R2 — the reindex job MUST carry a retry policy. The AI_QUEUE default is
    // `attempts: 1`, and a run left partial by a transient embedding failure does
    // not flip the active generation: with a single attempt the workspace would sit
    // in the swap window (2x rows, `stale`, lexical-only after a model change)
    // forever. The stable jobId is what de-duplicates the manual button, the
    // AI-Search toggle and the automatic fingerprint-change reindex.
    expect(aiQueue.add).toHaveBeenCalledWith(
      expect.anything(),
      { workspaceId: WORKSPACE_ID },
      expect.objectContaining({
        jobId: `ai-reindex-${WORKSPACE_ID}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }),
    );
  });

  it('does NOT re-seed when a run is already active (mid-run re-trigger)', async () => {
    const { service, aiQueue, reindexProgress } = makeService();
    // An active record exists -> a second click must not reset the counter.
    reindexProgress.get.mockResolvedValue({
      total: 478,
      done: 120,
      startedAt: Date.now(),
    });

    await service.reindex(WORKSPACE_ID);

    expect(reindexProgress.start).not.toHaveBeenCalled();
    // The enqueue still runs (and de-duplicates against the active job).
    expect(aiQueue.add).toHaveBeenCalledTimes(1);
  });

  it('clears the seed it just wrote and re-throws when enqueue fails', async () => {
    const { service, aiQueue, reindexProgress } = makeService();
    // This call seeds (get() is null) but the enqueue then blows up
    // (Redis hiccup/shutdown) -> the worker never runs and never clear()s, so
    // reindex() must roll back its own seed to avoid a 1h stuck "reindexing".
    const boom = new Error('redis down');
    aiQueue.add.mockRejectedValue(boom);

    await expect(service.reindex(WORKSPACE_ID)).rejects.toBe(boom);

    expect(reindexProgress.start).toHaveBeenCalledWith(
      WORKSPACE_ID,
      478,
      expect.any(Number),
    );
    expect(reindexProgress.clear).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('does NOT clear a concurrent active run when enqueue fails (no seed)', async () => {
    const { service, aiQueue, reindexProgress } = makeService();
    // A run is already active, so THIS call does not seed; if the enqueue then
    // fails it must NOT wipe the live worker's record.
    reindexProgress.get.mockResolvedValue({
      total: 478,
      done: 120,
      startedAt: Date.now(),
    });
    const boom = new Error('redis down');
    aiQueue.add.mockRejectedValue(boom);

    await expect(service.reindex(WORKSPACE_ID)).rejects.toBe(boom);

    expect(reindexProgress.start).not.toHaveBeenCalled();
    expect(reindexProgress.clear).not.toHaveBeenCalled();
  });
});
