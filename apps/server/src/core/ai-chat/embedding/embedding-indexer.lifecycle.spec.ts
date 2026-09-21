import {
  EmbeddingIndexerService,
  PartialReindexError,
} from './embedding-indexer.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AiService } from '../../../integrations/ai/ai.service';
import {
  EmbeddingGenerationService,
  StaleReindexTargetError,
} from '../../../integrations/ai/embedding-generation.service';
import { EmbeddingReindexProgressService } from '../../../integrations/ai/embedding-reindex-progress.service';
import { workspaceReindexJobOptions } from '../../../integrations/queue/constants/queue.constants';

/**
 * #599 — the reindex run as the unit that owns a fingerprint TRANSITION:
 *
 *   GC(keep = active + target)  ->  write every page under the TARGET  ->
 *   atomic flip onto the target (guarded)  ->  GC(keep = target)
 *
 * Covered here (unit-level, plain mocks — no Nest graph, no DB):
 *   - the start GC keeps at most 2 generations (acceptance 5);
 *   - a swap run writes TARGET rows while the ACTIVE ones keep serving, and the
 *     per-page replace deletes only the target generation (acceptance 3);
 *   - a fatal provider abort never reaches the flip, and a re-run is idempotent
 *     (acceptance 4);
 *   - the coverage total handed to the flip counts only pages that really
 *     produced a chunk (the denominator, acceptance 1/2).
 */

const WS = 'ws-1';

function makeService(opts: {
  active: string;
  target: string;
  pageIds?: string[];
}) {
  const pageIds = opts.pageIds ?? ['p1', 'p2', 'p3'];

  const pageRepo = {
    getEmbeddablePageIds: jest.fn().mockResolvedValue(pageIds),
  };
  const pageEmbeddingRepo = {
    deleteByPage: jest.fn().mockResolvedValue(undefined),
    insertChunks: jest.fn().mockResolvedValue(undefined),
  };
  const aiService = {
    resolveEmbeddingProvider: jest.fn().mockResolvedValue({
      model: { modelId: 'e5-small' },
      modelId: 'e5-small',
      queryPrefix: 'query: ',
      docPrefix: 'passage: ',
      fingerprint: opts.target,
    }),
    embedWithModel: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  };
  const reindexProgress = {
    start: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  // #599 D4: a REAL single-flight stand-in for the per-workspace advisory lock, so
  // the "two overlapping runs" test exercises the indexer's own wiring (the lock's
  // SQL protocol itself is unit-tested in embedding-generation.service.spec.ts).
  let lockHeld = false;
  const generation = {
    generationForTarget: jest.fn().mockResolvedValue({
      active: opts.active,
      target: opts.target,
      swapping: opts.active !== opts.target,
      modelChanged: false,
      activeModel: 'e5-small',
      targetModel: 'e5-small',
    }),
    gcGenerations: jest.fn().mockResolvedValue(0),
    completeRun: jest.fn().mockResolvedValue(true),
    runExclusive: jest.fn(async (_ws: string, fn: () => Promise<void>) => {
      if (lockHeld) return false;
      lockHeld = true;
      try {
        await fn();
      } finally {
        lockHeld = false;
      }
      return true;
    }),
  };
  const db = { transaction: () => ({ execute: (cb: any) => cb({}) }) };

  const service = new EmbeddingIndexerService(
    pageRepo as unknown as PageRepo,
    pageEmbeddingRepo as unknown as PageEmbeddingRepo,
    aiService as unknown as AiService,
    reindexProgress as unknown as EmbeddingReindexProgressService,
    generation as unknown as EmbeddingGenerationService,
    db as unknown as KyselyDB,
  );
  return { service, pageRepo, pageEmbeddingRepo, aiService, generation };
}

/** A page whose plain text yields exactly one chunk. */
function page(id: string) {
  return {
    id,
    workspaceId: WS,
    spaceId: 'space-1',
    title: 'T',
    content: null,
    textContent: 'текст страницы',
    deletedAt: null,
  };
}

describe('reindexWorkspace — generational GC + atomic flip (#599)', () => {
  it('GCs at the START keeping ONLY the active + target generations (cap 2)', async () => {
    const { service, generation } = makeService({
      active: 'fp-A',
      target: 'fp-B',
    });
    jest.spyOn(service, 'reindexPage').mockResolvedValue(1);

    await service.reindexWorkspace(WS);

    expect(generation.gcGenerations).toHaveBeenCalledWith(WS, ['fp-A', 'fp-B']);
    // Exactly 2 generations survive the start GC — everything else (older
    // generations, legacy NULL-fingerprint rows, a superseded partial target) is
    // reclaimed.
    const keep = generation.gcGenerations.mock.calls[0][1];
    expect(keep).toHaveLength(2);
  });

  it('keeps ONE generation on the no-swap path (active === target)', async () => {
    const { service, generation } = makeService({
      active: 'fp-A',
      target: 'fp-A',
    });
    jest.spyOn(service, 'reindexPage').mockResolvedValue(1);

    await service.reindexWorkspace(WS);
    expect(generation.gcGenerations).toHaveBeenCalledWith(WS, ['fp-A']);
  });

  it('flips onto the TARGET after a complete run, with the PRODUCED-chunk denominator', async () => {
    const { service, generation } = makeService({
      active: 'fp-A',
      target: 'fp-B',
      pageIds: ['p1', 'p2', 'p3'],
    });
    // p2 produces no chunk (a math-only page): it must NOT count towards the
    // coverage denominator, or the state would be pinned at `stale` forever.
    jest
      .spyOn(service, 'reindexPage')
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(5);

    await service.reindexWorkspace(WS);

    expect(generation.completeRun).toHaveBeenCalledWith({
      workspaceId: WS,
      target: 'fp-B',
      targetModel: 'e5-small',
      coverageTotal: 2,
      // The run considered 3 pages embeddable; only 2 produced a chunk. The GAP
      // (3 - 2) is what keeps a chunk-less page from pinning coverage at `stale`.
      coverageEmbeddable: 3,
      // #599 review F2 — the run's START instant rides along, so the coverage rule
      // can tell the pages this run measured from the ones that appeared later.
      coverageAt: expect.any(Date),
    });
  });

  it('passes the ACTIVE pointer to every page so the per-page replace can scope its delete', async () => {
    const { service } = makeService({ active: 'fp-A', target: 'fp-B' });
    const reindexPage = jest.spyOn(service, 'reindexPage').mockResolvedValue(1);

    await service.reindexWorkspace(WS);

    expect(reindexPage).toHaveBeenCalledTimes(3);
    for (const call of reindexPage.mock.calls) {
      expect(call[1]).toBe('fp-A');
    }
  });

  it('a FATAL provider abort NEVER flips the pointer, and a re-run is idempotent', async () => {
    const { service, generation } = makeService({
      active: 'fp-A',
      target: 'fp-B',
    });
    jest
      .spyOn(service, 'reindexPage')
      .mockRejectedValue({ statusCode: 401, message: 'User not found' });

    await expect(service.reindexWorkspace(WS)).rejects.toMatchObject({
      statusCode: 401,
    });

    // The flip lives AFTER the loop: an abort throws straight past it. The active
    // pointer still names fp-A, so search keeps serving the OLD generation and the
    // partial fp-B rows are simply invisible.
    expect(generation.completeRun).not.toHaveBeenCalled();
    // ...but the start GC already ran (it is idempotent).
    expect(generation.gcGenerations).toHaveBeenCalledTimes(1);

    // Re-run: the same start GC runs again (no-op when nothing to reclaim; it is
    // what cleans a partial generation whose target has since been superseded),
    // and the run can complete and flip normally.
    jest.spyOn(service, 'reindexPage').mockResolvedValue(1);
    await service.reindexWorkspace(WS);
    expect(generation.gcGenerations).toHaveBeenCalledTimes(2);
    expect(generation.completeRun).toHaveBeenCalledWith({
      workspaceId: WS,
      target: 'fp-B',
      targetModel: 'e5-small',
      coverageTotal: 3,
      coverageEmbeddable: 3,
      coverageAt: expect.any(Date),
    });
  });

  it('does not flip when the workspace has no embeddings provider (early return)', async () => {
    const { service, generation, aiService } = makeService({
      active: 'fp-A',
      target: 'fp-B',
    });
    const { AiEmbeddingNotConfiguredException } =
      await import('../../../integrations/ai/ai-embedding-not-configured.exception');
    aiService.resolveEmbeddingProvider.mockRejectedValue(
      new AiEmbeddingNotConfiguredException(),
    );

    await expect(service.reindexWorkspace(WS)).resolves.toBeUndefined();
    expect(generation.gcGenerations).not.toHaveBeenCalled();
    expect(generation.completeRun).not.toHaveBeenCalled();
  });
});

/**
 * #599 D1 — a run with NON-FATAL per-page failures is NOT a full reindex.
 *
 * Per-page isolation (a TEI timeout, a 429/500, a mixed-dimension page) keeps the
 * batch going, but it leaves HOLES in the target generation. Flipping onto it would
 * (a) let the post-flip GC destroy the old generation — including the ONLY surviving
 * rows of the failed pages, which then fall out of semantics permanently — and (b)
 * report `full` coverage over a corpus that silently lost those pages.
 */
describe('reindexWorkspace — a PARTIAL run never flips, and is RETRIED (#599 D1 + R2)', () => {
  it('does NOT flip the pointer and does NOT GC the old generation when a page failed', async () => {
    const { service, generation } = makeService({
      active: 'fp-A',
      target: 'fp-B',
      pageIds: ['p1', 'p2', 'p3'],
    });
    // p2 times out against the TEI sidecar (non-fatal: the batch continues).
    jest
      .spyOn(service, 'reindexPage')
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('embedding request timed out'))
      .mockResolvedValueOnce(1);

    await expect(service.reindexWorkspace(WS)).rejects.toBeInstanceOf(
      PartialReindexError,
    );

    // NON-VACUITY: remove the `if (failed > 0) throw` guard and this fails —
    // completeRun would flip onto the HOLED fp-B generation with coverageTotal 2,
    // and its post-flip GC (keep=[fp-B]) would delete p2's only rows (fp-A).
    expect(generation.completeRun).not.toHaveBeenCalled();
    // The only GC that ran is the START one, which keeps BOTH generations — the old
    // one keeps serving search, complete and intact.
    expect(generation.gcGenerations).toHaveBeenCalledTimes(1);
    expect(generation.gcGenerations).toHaveBeenCalledWith(WS, ['fp-A', 'fp-B']);
  });

  it('#599 R2 — a partial run THROWS (so BullMQ retries it) instead of completing "successfully"', async () => {
    const { service } = makeService({
      active: 'fp-A',
      target: 'fp-B',
      pageIds: ['p1', 'p2', 'p3', 'p4'],
    });
    jest
      .spyOn(service, 'reindexPage')
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('embedding request timed out'))
      .mockRejectedValueOnce(new Error('429 rate limited'))
      .mockResolvedValueOnce(1);

    // NON-VACUITY: this is the whole fix. Returning quietly (the old behavior) let
    // the job COMPLETE, so nothing ever re-ran it: ONE transient TEI timeout parked
    // the workspace in the swap window PERMANENTLY (~2x rows on an un-indexed vector
    // column, `semantic.state: stale`, lexical-only after a model change). The throw
    // is what makes BullMQ retry the (idempotent) run.
    const err = await service.reindexWorkspace(WS).catch((e) => e);
    expect(err).toBeInstanceOf(PartialReindexError);
    expect(err).toMatchObject({ workspaceId: WS, failed: 2, total: 4 });
  });

  it('the retry is idempotent: once every page succeeds, the flip happens', async () => {
    const { service, generation } = makeService({
      active: 'fp-A',
      target: 'fp-B',
      pageIds: ['p1', 'p2', 'p3'],
    });
    jest
      .spyOn(service, 'reindexPage')
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('embedding request timed out'))
      .mockResolvedValueOnce(1);
    await expect(service.reindexWorkspace(WS)).rejects.toBeInstanceOf(
      PartialReindexError,
    );
    expect(generation.completeRun).not.toHaveBeenCalled();

    // The retry (BullMQ re-runs the SAME job after its backoff) rewrites every page
    // under the same target fingerprint — the per-page replace is fingerprint-scoped,
    // so re-writing an already-written page is a no-op replace, not a duplicate — and
    // now the run is complete -> flip. The start GC still keeps [active, target], so
    // the retry never destroys the generation that is serving search.
    jest.spyOn(service, 'reindexPage').mockResolvedValue(1);
    await expect(service.reindexWorkspace(WS)).resolves.toBeUndefined();

    expect(generation.gcGenerations).toHaveBeenNthCalledWith(2, WS, [
      'fp-A',
      'fp-B',
    ]);
    expect(generation.completeRun).toHaveBeenCalledWith({
      workspaceId: WS,
      target: 'fp-B',
      targetModel: 'e5-small',
      coverageTotal: 3,
      coverageEmbeddable: 3,
      coverageAt: expect.any(Date),
    });
  });
});

/**
 * #599 D4 — two runs of the SAME workspace must never overlap. The BullMQ jobId
 * dedupe does not cover a stalled job re-dispatched to a second worker; a Postgres
 * advisory lock held for the whole run does.
 */
describe('reindexWorkspace — the per-workspace run lock (#599 D4)', () => {
  it('a second concurrent run does NOTHING (no start GC, no flip) while the first holds the lock', async () => {
    const { service, generation } = makeService({
      active: 'fp-A',
      target: 'fp-B',
      pageIds: ['p1'],
    });

    // Hold run A inside its page loop until we release it.
    let releaseRunA: () => void = () => undefined;
    const runAReachedThePage = new Promise<void>((resolveReached) => {
      jest.spyOn(service, 'reindexPage').mockImplementation(async () => {
        resolveReached();
        await new Promise<void>((r) => (releaseRunA = r));
        return 1;
      });
    });

    const runA = service.reindexWorkspace(WS);
    await runAReachedThePage;

    // Run B arrives while A is still in flight (a re-dispatched stalled job).
    await service.reindexWorkspace(WS);

    // NON-VACUITY: without the lock, B's start GC (keep=[active, target]) would run
    // a SECOND time here — and in the fp1->fp2->fp1 rollback scenario it would DELETE
    // A's half-built generation, after which A's flip publishes a holed generation.
    expect(generation.runExclusive).toHaveBeenCalledTimes(2);
    expect(generation.gcGenerations).toHaveBeenCalledTimes(1);

    releaseRunA();
    await runA;

    // A (the lock holder) completed normally and flipped exactly once.
    expect(generation.completeRun).toHaveBeenCalledTimes(1);
  });
});

describe('reindexPage — fingerprint-scoped replace (#599 acceptance 3)', () => {
  it('deletes ONLY the target generation while a swap is in flight (an edit never drops the page from search)', async () => {
    const { service, pageRepo, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      target: 'fp-B',
    });
    (pageRepo as any).findById = jest.fn().mockResolvedValue(page('p1'));

    // The event-driven path (a page edited during the reindex) does not know the
    // active pointer: it resolves it itself.
    await service.reindexPage('p1');

    expect(pageEmbeddingRepo.deleteByPage).toHaveBeenCalledWith(
      'p1',
      WS,
      expect.anything(),
      ['fp-B'],
    );
    // The new rows carry the TARGET fingerprint; the page's fp-A rows are intact
    // and still served until the flip.
    const rows = pageEmbeddingRepo.insertChunks.mock.calls[0][0];
    expect(rows[0].fingerprint).toBe('fp-B');
  });

  it('purges EVERY generation of the page outside a swap (active === target)', async () => {
    const { service, pageRepo, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      target: 'fp-A',
    });
    (pageRepo as any).findById = jest.fn().mockResolvedValue(page('p1'));

    await service.reindexPage('p1');

    // No fingerprint scope -> the replace also reclaims the page's legacy
    // NULL-fingerprint rows (the per-page half of the generational GC).
    expect(pageEmbeddingRepo.deleteByPage).toHaveBeenCalledWith(
      'p1',
      WS,
      expect.anything(),
      undefined,
    );
  });

  it('purges EVERY generation when the page was deleted (never scoped)', async () => {
    const { service, pageRepo, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      target: 'fp-B',
    });
    (pageRepo as any).findById = jest
      .fn()
      .mockResolvedValue({ ...page('p1'), deletedAt: new Date() });

    await expect(service.reindexPage('p1')).resolves.toBe(0);

    // A deleted page must vanish from EVERY generation, including the one being
    // served — a scoped delete here would keep serving a trashed page.
    expect(pageEmbeddingRepo.deleteByPage).toHaveBeenCalledWith('p1', WS);
  });

  it('returns the number of chunk rows written (the coverage denominator signal)', async () => {
    const { service, pageRepo } = makeService({
      active: 'fp-A',
      target: 'fp-A',
    });
    (pageRepo as any).findById = jest.fn().mockResolvedValue(page('p1'));
    await expect(service.reindexPage('p1')).resolves.toBe(1);
  });

  it('returns 0 for an empty page (no chunk produced -> not in the denominator)', async () => {
    const { service, pageRepo } = makeService({
      active: 'fp-A',
      target: 'fp-A',
    });
    (pageRepo as any).findById = jest
      .fn()
      .mockResolvedValue({ ...page('p1'), textContent: '   ', content: null });

    await expect(service.reindexPage('p1')).resolves.toBe(0);
  });
});

/**
 * #599 (review F1) — A CONFIG CHANGE DURING A SUCCESSFUL RUN MUST NOT LOSE THE NEW
 * GENERATION.
 *
 * The chain that used to lose it, end to end:
 *
 *   1. a reindex run X is in flight, building generation fp-1;
 *   2. the admin picks another model -> the config resolves to fp-2, and
 *      AiSettingsService.reindex() fires: `aiQueue.remove(jobId)` is a NO-OP on an
 *      ACTIVE job, and `aiQueue.add(jobId)` is then DE-DUPLICATED against X. So the
 *      config change enqueues NOTHING;
 *   3. X finishes fp-1 with zero failures, and completeRun correctly refuses to flip
 *      (its target is stale);
 *   4. X is dropped by removeOnComplete.
 *
 * End state: config = fp-2, pointer still on fp-1, ZERO rows for fp-2, no job in the
 * queue, and no cron/reconciler anywhere that re-triggers a reindex on
 * `config != active`. On a MODEL change (the normal dropdown case) `modelChanged`
 * keeps the vector arm down forever: semantic search is permanently lexical-only,
 * while the settings panel shows a green "Indexed N of N, reindexing: false" — the
 * pointer really IS on a complete generation. Invisible.
 *
 * The fix: completeRun THROWS StaleReindexTargetError instead of returning quietly,
 * so the job FAILS and BullMQ retries it — and the retry re-resolves the provider,
 * picks up fp-2, builds it and flips onto it.
 *
 * These tests wire the REAL EmbeddingGenerationService (real completeRun, real
 * generationForTarget, real flip against a stateful workspace-settings double) to
 * the REAL indexer, and drive them through a retry loop that mirrors BullMQ's
 * `attempts` — the actual policy from workspaceReindexJobOptions, so the test cannot
 * pass on a retry budget the queue does not really grant.
 */
describe('reindexWorkspace — a config change DURING the run (#599 review F1)', () => {
  /** The live provider config; mutating it IS the admin changing the model. */
  type Config = { fingerprint: string; modelId: string };

  function makeRealStack(opts: {
    storedActive: string | null;
    storedModel: string | null;
    config: Config;
    pageIds?: string[];
    /**
     * Called after each page is indexed, with the page just written — the hook a
     * test uses to move the config MID-RUN. Keyed on the page id (not a running
     * counter) so it fires on the same page of EVERY run, which is what a config
     * that "keeps moving" needs.
     */
    onPageIndexed?: (pageId: string) => void;
  }) {
    const pageIds = opts.pageIds ?? ['p1', 'p2', 'p3'];
    const config = { ...opts.config };

    // The workspace settings, as a stateful double: the flip really writes here and
    // the next run really reads it back (that round trip is the point).
    const stored = {
      activeFingerprint: opts.storedActive,
      activeModel: opts.storedModel,
      coverageTotal: null as number | null,
      coverageEmbeddable: null as number | null,
      coverageAt: null as Date | null,
    };

    const workspaceRepo = {
      getEmbeddingGeneration: jest.fn(async () => ({ ...stored })),
      setEmbeddingGeneration: jest.fn(
        async (
          _ws: string,
          gen: {
            activeFingerprint: string;
            activeModel: string;
            coverageTotal: number;
            coverageEmbeddable: number;
            coverageAt: Date;
          },
        ) => {
          stored.activeFingerprint = gen.activeFingerprint;
          stored.activeModel = gen.activeModel;
          stored.coverageTotal = gen.coverageTotal;
          stored.coverageEmbeddable = gen.coverageEmbeddable;
          stored.coverageAt = gen.coverageAt;
        },
      ),
    };

    // Rows actually written, keyed by fingerprint -> the pages carrying them. This
    // is what proves the NEW generation gets BUILT, not merely pointed at.
    const rowsByFingerprint = new Map<string, Set<string>>();
    const pageEmbeddingRepo = {
      deleteOtherGenerations: jest.fn(async (_ws: string, keep: string[]) => {
        for (const fp of [...rowsByFingerprint.keys()]) {
          if (!keep.includes(fp)) rowsByFingerprint.delete(fp);
        }
        return 0;
      }),
      countPagesByFingerprint: jest.fn(
        async (_ws: string, fp: string) => rowsByFingerprint.get(fp)?.size ?? 0,
      ),
      deleteByPage: jest.fn(async () => undefined),
      insertChunks: jest.fn(
        async (rows: { pageId: string; fingerprint: string }[]) => {
          for (const row of rows) {
            const set =
              rowsByFingerprint.get(row.fingerprint) ?? new Set<string>();
            set.add(row.pageId);
            rowsByFingerprint.set(row.fingerprint, set);
          }
        },
      ),
    };

    const pageRepo = {
      getEmbeddablePageIds: jest.fn(async () => [...pageIds]),
      countEmbeddablePages: jest.fn(async () => pageIds.length),
      countEmbeddablePagesChangedSince: jest.fn(async () => 0),
    };

    const aiService = {
      // Resolved fresh on EVERY call — exactly like the real one, which is what
      // lets a mid-run config change be observed by completeRun's re-resolve.
      resolveEmbeddingProvider: jest.fn(async () => ({
        model: { modelId: config.modelId },
        modelId: config.modelId,
        queryPrefix: 'query: ',
        docPrefix: 'passage: ',
        fingerprint: config.fingerprint,
      })),
      embedWithModel: jest.fn(async () => [[0.1, 0.2, 0.3]]),
    };

    const reindexProgress = {
      start: jest.fn(async () => undefined),
      increment: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
    };

    const db = { transaction: () => ({ execute: (cb: any) => cb({}) }) };

    const generation = new EmbeddingGenerationService(
      aiService as any,
      workspaceRepo as any,
      pageEmbeddingRepo as any,
      pageRepo as any,
      db as any,
    );
    // The per-workspace advisory lock is exercised by its own SQL-level tests; here
    // it would only need a live Postgres. Run the body straight through.
    jest
      .spyOn(generation, 'runExclusive')
      .mockImplementation(async (_ws: string, fn: () => Promise<void>) => {
        await fn();
        return true;
      });

    const service = new EmbeddingIndexerService(
      pageRepo as any,
      pageEmbeddingRepo as any,
      aiService as any,
      reindexProgress as any,
      generation,
      db as any,
    );

    // A real-ish per-page indexer: it writes rows under the LIVE config fingerprint
    // (as reindexPage does) and lets the test move the config mid-run.
    jest.spyOn(service, 'reindexPage').mockImplementation(async (pageId) => {
      await pageEmbeddingRepo.insertChunks([
        { pageId, fingerprint: config.fingerprint },
      ]);
      opts.onPageIndexed?.(pageId);
      return 1;
    });

    return { service, generation, config, stored, rowsByFingerprint, pageRepo };
  }

  /**
   * BullMQ, faithfully enough: run the job; on failure retry it until the REAL
   * `attempts` budget from workspaceReindexJobOptions is exhausted. The retry runs
   * the SAME job — which is the whole point, since a fresh `add()` would be deduped.
   */
  async function runJobWithRetries(
    run: () => Promise<void>,
  ): Promise<{ attempts: number; lastError: unknown }> {
    const { attempts } = workspaceReindexJobOptions(WS);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await run();
        return { attempts: attempt, lastError: null };
      } catch (err) {
        lastError = err;
      }
    }
    return { attempts, lastError };
  }

  it('the retried job REBUILDS and FLIPS onto the new target (the generation is not lost)', async () => {
    const stack = makeRealStack({
      storedActive: 'fp-0',
      storedModel: 'e5-small',
      config: { fingerprint: 'fp-1', modelId: 'e5-small' },
      onPageIndexed: (pageId) => {
        // The admin switches the model to bge WHILE the run is on its 2nd page.
        if (pageId === 'p2' && stack.config.fingerprint === 'fp-1') {
          stack.config.fingerprint = 'fp-2';
          stack.config.modelId = 'bge-base';
        }
      },
    });

    const { attempts, lastError } = await runJobWithRetries(() =>
      stack.service.reindexWorkspace(WS),
    );

    // Attempt 1 built fp-1, found the config on fp-2, and FAILED (not "succeeded
    // quietly"). Attempt 2 re-resolved the provider, built fp-2 and flipped.
    expect(attempts).toBe(2);
    expect(lastError).toBeNull();

    // THE ASSERTION THAT MATTERS: the new target is really BUILT (every page) and
    // really SERVED (the pointer names it, with the new model recorded).
    expect(stack.stored.activeFingerprint).toBe('fp-2');
    expect(stack.stored.activeModel).toBe('bge-base');
    expect(stack.rowsByFingerprint.get('fp-2')?.size).toBe(3);

    // NON-VACUITY: make completeRun's config-drift branch `return false` again (the
    // pre-fix behaviour) and this whole test reds — attempt 1 "succeeds", the loop
    // stops at attempts === 1, the pointer stays on fp-0 and fp-2 holds no rows at
    // all: config fp-2, pointer fp-0, nothing building it, forever.
    const genForNewConfig = await stack.generation.resolveGeneration(WS);
    expect(genForNewConfig).toMatchObject({
      active: 'fp-2',
      target: 'fp-2',
      swapping: false,
      // The vector arm can be raised again: the served rows and the query now come
      // from the SAME model. Before the fix this stayed modelChanged: true forever.
      modelChanged: false,
    });
  });

  it('the superseded generation is reclaimed and the old one kept serving until the flip', async () => {
    const stack = makeRealStack({
      storedActive: 'fp-0',
      storedModel: 'e5-small',
      config: { fingerprint: 'fp-1', modelId: 'e5-small' },
      onPageIndexed: (pageId) => {
        if (pageId === 'p2' && stack.config.fingerprint === 'fp-1') {
          stack.config.fingerprint = 'fp-2';
          stack.config.modelId = 'bge-base';
        }
      },
    });

    await runJobWithRetries(() => stack.service.reindexWorkspace(WS));

    // After the successful flip onto fp-2, the post-flip GC keeps ONLY fp-2: the
    // abandoned fp-1 rows the failed attempt wrote are reclaimed, and so is fp-0.
    expect([...stack.rowsByFingerprint.keys()]).toEqual(['fp-2']);
  });

  it('a config that keeps moving cannot loop forever: attempts are BOUNDED and the old generation still serves', async () => {
    let generationCounter = 1;
    const stack = makeRealStack({
      storedActive: 'fp-0',
      storedModel: 'e5-small',
      config: { fingerprint: 'fp-1', modelId: 'm-1' },
      onPageIndexed: (pageId) => {
        // The config moves on EVERY run (mid-run, on the same page each time), so no
        // run can ever catch up with it.
        if (pageId === 'p2') {
          generationCounter++;
          stack.config.fingerprint = `fp-${generationCounter}`;
          stack.config.modelId = `m-${generationCounter}`;
        }
      },
    });

    const { attempts, lastError } = await runJobWithRetries(() =>
      stack.service.reindexWorkspace(WS),
    );

    // Bounded by the queue's real budget — it does not spin.
    expect(attempts).toBe(workspaceReindexJobOptions(WS).attempts);
    expect(lastError).toBeInstanceOf(StaleReindexTargetError);

    // And the fallout is SAFE: the pointer never moved onto a stale generation, so
    // the OLD, complete generation is still what search serves.
    expect(stack.stored.activeFingerprint).toBe('fp-0');
  });
});
