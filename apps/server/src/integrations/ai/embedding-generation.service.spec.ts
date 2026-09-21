import {
  computeCoverage,
  EmbeddingGenerationService,
  StaleReindexTargetError,
} from './embedding-generation.service';
import { AiService } from './ai.service';
import { AiEmbeddingNotConfiguredException } from './ai-embedding-not-configured.exception';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';

/**
 * #599 — the embedding fingerprint lifecycle: coverage state (off/stale/full with
 * the gap-corrected denominator), the atomic pointer flip and its config-changed
 * guard, the generational GC cap, the same-dimension MODEL-change guard (D2) and
 * the per-workspace run lock (D4).
 *
 * The service only stores its deps in the constructor, so it is unit-built with
 * plain mocks — no Nest module graph, no DB (the run-lock tests stub the two raw
 * SQL round-trips).
 */

const WS = 'ws-1';

/**
 * A REAL Kysely wired to a recording in-memory driver, used by the run-lock tests.
 *
 * It is deliberately not a hand-rolled `{ connection, getExecutor }` object: a stub
 * that fakes `compileQuery` never compiles anything, so the assertions could only
 * COUNT statements — and a count is vacuous. Corrupt the key derivation, or replace
 * `pg_advisory_unlock` with `SELECT 1`, and a counting test stays green while the
 * lock silently leaks (or every workspace collides on one key).
 *
 * With the real PostgresQueryCompiler behind it, `executed` holds the actual
 * CompiledQuery — `sql` text + bound `parameters` — so the tests can assert the
 * statements the service really sends, including the derived lock key.
 */
function makeLockDb(locked: boolean, failUnlock = false) {
  const executed: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery: async <R>(
      compiled: CompiledQuery,
    ): Promise<QueryResult<R>> => {
      executed.push(compiled);
      if (failUnlock && /pg_advisory_unlock/.test(compiled.sql)) {
        throw new Error('connection reset while unlocking');
      }
      // The try-lock's result; the unlock's is ignored by the service.
      return { rows: [{ locked }] as unknown as R[] };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k: Kysely<unknown>) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db: db as unknown as KyselyDB, executed };
}

/** The instant a completed run started (drives the review-F2 `changedSince` split). */
const RUN_AT = new Date('2026-07-01T00:00:00.000Z');

function makeService(opts?: {
  active?: string | null;
  activeModel?: string | null;
  coverageTotal?: number | null;
  coverageEmbeddable?: number | null;
  coverageAt?: Date | null;
  configFingerprint?: string | null; // null => no provider configured
  configModel?: string;
  indexed?: number;
  embeddable?: number;
  // #599 review F2 — the LIVE counts over the pages the completed run never
  // measured (created/edited since coverageAt), and how many of those the active
  // generation already covers.
  changedSince?: number;
  indexedChangedSince?: number;
  lockAvailable?: boolean;
  failUnlock?: boolean;
}) {
  const stored = {
    activeFingerprint: opts?.active ?? null,
    activeModel: opts?.activeModel ?? null,
    coverageTotal: opts?.coverageTotal ?? null,
    coverageEmbeddable: opts?.coverageEmbeddable ?? null,
    coverageAt: opts?.coverageAt ?? null,
  };

  const aiService = {
    resolveEmbeddingProvider: jest.fn(async () => {
      if (opts?.configFingerprint === null) {
        throw new AiEmbeddingNotConfiguredException();
      }
      return {
        model: 'm',
        modelId: opts?.configModel ?? 'model-1',
        queryPrefix: '',
        docPrefix: '',
        fingerprint: opts?.configFingerprint ?? 'fp-A',
      };
    }),
    embedQuery: jest.fn(async () => ({
      vector: [0.1, 0.2],
      fingerprint: opts?.configFingerprint ?? 'fp-A',
      modelId: opts?.configModel ?? 'model-1',
    })),
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

  const pageEmbeddingRepo = {
    // The 3rd arg is the review-F2 `changedSince` cutoff: with it, the repo counts
    // only the pages TOUCHED since the run that ARE covered by the generation.
    countPagesByFingerprint: jest.fn(
      async (_ws: string, _fp: string, changedSince?: Date) =>
        changedSince ? (opts?.indexedChangedSince ?? 0) : (opts?.indexed ?? 0),
    ),
    deleteOtherGenerations: jest.fn(async () => 0),
  };

  const pageRepo = {
    countEmbeddablePages: jest.fn(async () => opts?.embeddable ?? 0),
    countEmbeddablePagesChangedSince: jest.fn(
      async () => opts?.changedSince ?? 0,
    ),
  };

  const { db, executed } = makeLockDb(
    opts?.lockAvailable ?? true,
    opts?.failUnlock ?? false,
  );

  const service = new EmbeddingGenerationService(
    aiService as unknown as AiService,
    workspaceRepo as unknown as WorkspaceRepo,
    pageEmbeddingRepo as unknown as PageEmbeddingRepo,
    pageRepo as unknown as PageRepo,
    db,
  );
  return {
    service,
    aiService,
    workspaceRepo,
    pageEmbeddingRepo,
    pageRepo,
    stored,
    executed,
  };
}

beforeEach(() => {
  // Coverage is TTL-cached per process; disable it so each test's counts are read
  // fresh (the cache itself is asserted in its own test).
  process.env.SEARCH_COVERAGE_TTL_MS = '0';
});
afterEach(() => {
  delete process.env.SEARCH_COVERAGE_TTL_MS;
});

describe('computeCoverage (#599) — the gap-corrected denominator', () => {
  it('bootstraps on the raw embeddable count when no run has completed (legacy NULL-fp instance) => stale', () => {
    // 100 embeddable pages, every row still legacy (fingerprint NULL) => the
    // ACTIVE fingerprint matches nothing. This is the #599 zero-recall hole.
    const cov = computeCoverage({
      indexed: 0,
      embeddable: 100,
      completedTotal: null,
      completedEmbeddable: null,
    });
    expect(cov).toEqual({ indexed: 0, total: 100, state: 'stale' });
  });

  it('subtracts the CHUNK-LESS gap the run measured, so text-less pages never pin it at stale', () => {
    // The run saw 100 embeddable pages but only 98 produced a chunk (2 are
    // math-only / image-only). With the raw embeddable denominator this workspace
    // could NEVER reach `full` — the trap the issue calls out.
    const cov = computeCoverage({
      indexed: 98,
      embeddable: 100,
      completedTotal: 98,
      completedEmbeddable: 100,
    });
    expect(cov).toEqual({ indexed: 98, total: 98, state: 'full' });
  });

  it('#599 R4 — never reports indexed > total (the frozen gap can out-live the pages it measured)', () => {
    // The completed run measured a gap of 6 (10 embeddable, 4 produced a chunk).
    // Then the admin DELETES those 6 chunk-less pages: `embeddable` is live and drops
    // to 4, but the recorded gap is FROZEN at 6, so the raw formula prints
    // total = max(0, 4 - 6) = 0 against indexed = 4 — an absurd "indexed 4 / total 0"
    // in the UI. The denominator is clamped to the numerator instead.
    const cov = computeCoverage({
      indexed: 4,
      embeddable: 4,
      completedTotal: 4,
      completedEmbeddable: 10,
    });
    expect(cov).toEqual({ indexed: 4, total: 4, state: 'full' });
    expect(cov.total).toBeGreaterThanOrEqual(cov.indexed);
  });

  it('#599 R4 — clamps on the bootstrap path too (indexed can exceed a shrunken live count)', () => {
    const cov = computeCoverage({
      indexed: 7,
      embeddable: 4,
      completedTotal: null,
      completedEmbeddable: null,
    });
    expect(cov).toEqual({ indexed: 7, total: 7, state: 'full' });
  });

  it('an ABORTED first run does NOT report full (3 of 100 pages indexed)', () => {
    // No completed run => bootstrap denominator.
    const cov = computeCoverage({
      indexed: 3,
      embeddable: 100,
      completedTotal: null,
      completedEmbeddable: null,
    });
    expect(cov).toEqual({ indexed: 3, total: 100, state: 'stale' });
  });

  // --- D3: the denominator must FOLLOW the corpus ----------------------------

  it('D3 — goes STALE when pages are ADDED after the run (a frozen total never could)', () => {
    // The run indexed 100 of 100; then 1000 pages were created and never embedded.
    // A denominator frozen at the run's produced count would still say `full` while
    // 91% of the corpus has no vectors at all.
    const cov = computeCoverage({
      indexed: 100,
      embeddable: 1100,
      completedTotal: 100,
      completedEmbeddable: 100,
    });
    expect(cov).toEqual({ indexed: 100, total: 1100, state: 'stale' });
  });

  it('D3 — converges back to full as the added pages get embedded', () => {
    const cov = computeCoverage({
      indexed: 1100,
      embeddable: 1100,
      completedTotal: 100,
      completedEmbeddable: 100,
    });
    expect(cov.state).toBe('full');
  });

  it('D3 — follows pages that are DELETED (no perpetual stale)', () => {
    // A run recorded 98 produced of 100 embeddable (gap 2); then 10 indexed pages
    // were trashed: both counts drop (they exclude deleted pages).
    const cov = computeCoverage({
      indexed: 88,
      embeddable: 90,
      completedTotal: 98,
      completedEmbeddable: 100,
    });
    expect(cov).toEqual({ indexed: 88, total: 88, state: 'full' });
  });

  it('reports stale when the embeddings were purged but pages remain', () => {
    const cov = computeCoverage({
      indexed: 0,
      embeddable: 100,
      completedTotal: 98,
      completedEmbeddable: 100,
    });
    expect(cov).toEqual({ indexed: 0, total: 98, state: 'stale' });
  });

  // --- D5: a run that genuinely produced nothing is FULL, not stale-forever ---

  it('D5 — a completed run that produced NO chunk at all is full, not stale forever', () => {
    // The workspace's only embeddable page is image-only: it yields 0 chunks. The
    // run completed and measured exactly that (produced 0 of 1 embeddable), so the
    // denominator is 0 — there is nothing the index COULD hold.
    const cov = computeCoverage({
      indexed: 0,
      embeddable: 1,
      completedTotal: 0,
      completedEmbeddable: 1,
    });
    expect(cov).toEqual({ indexed: 0, total: 0, state: 'full' });
  });

  it('D5 — a run over ZERO embeddable pages still goes stale once pages appear', () => {
    // completedTotal 0 / completedEmbeddable 0 = "the workspace was empty at run
    // time" — the gap is 0, so pages added later DO raise the denominator.
    const cov = computeCoverage({
      indexed: 0,
      embeddable: 10,
      completedTotal: 0,
      completedEmbeddable: 0,
    });
    expect(cov).toEqual({ indexed: 0, total: 10, state: 'stale' });
  });

  it('an empty workspace is trivially full (nothing to index)', () => {
    expect(
      computeCoverage({
        indexed: 0,
        embeddable: 0,
        completedTotal: null,
        completedEmbeddable: null,
      }),
    ).toEqual({ indexed: 0, total: 0, state: 'full' });
  });

  it('a record written before the gap key existed degrades to gap 0 (never a false full)', () => {
    const cov = computeCoverage({
      indexed: 98,
      embeddable: 100,
      completedTotal: 98,
      completedEmbeddable: null,
    });
    // Conservative: reports `stale` (a reindex re-measures the gap and self-heals).
    expect(cov).toEqual({ indexed: 98, total: 100, state: 'stale' });
  });

  // --- review F2: the frozen gap may only be spent on the pages it MEASURED -----

  /**
   * The reviewer's counterexample. Run: 10 embeddable, 6 produced a chunk -> gap 4.
   * The 4 chunk-less pages are then DELETED (embeddable 6) and 3 REAL pages are
   * created (embeddable 9) that no one has embedded yet.
   *
   * The frozen gap of 4 used to be subtracted from the LIVE count — `total =
   * max(0, 9 - 4) = 5`, clamped up to `indexed` 6 — so the state read `full` while
   * three pages held no vectors at all: the indicator lied in exactly the direction
   * the whole PR exists to prevent, and the settings panel showed a green "Indexed
   * 6 of 6".
   *
   * NOTE the 4 numbers of the old signature CANNOT decide this case: they are
   * identical to the legitimately-full corpus in the next test. What breaks the tie
   * is `changedSince` — the 3 pages are NEW, so the run's gap (measured over pages
   * that no longer exist) cannot excuse them.
   *
   * NON-VACUITY: drop the `changedSince` split (spend the gap over the whole live
   * count, i.e. the pre-fix `total = max(0, embeddable - gap)`) and this reddens —
   * it goes back to reporting `full`.
   */
  it('review F2 — a shrunken corpus cannot leave stale slack: 3 un-embedded new pages => stale', () => {
    const cov = computeCoverage({
      indexed: 6,
      embeddable: 9,
      completedTotal: 6,
      completedEmbeddable: 10,
      // The 3 new pages were created after the run and hold no rows.
      changedSince: 3,
      indexedChangedSince: 0,
    });
    expect(cov).toEqual({ indexed: 6, total: 9, state: 'stale' });
  });

  it('review F2 — the twin corpus (a chunk-less page merely DELETED) stays honestly full', () => {
    // Same run (10 embeddable / 6 produced), but here ONE chunk-less page was
    // deleted and nothing was added: 6 producers + 3 surviving chunk-less pages.
    // Numerically identical to the case above on the old 4-input signature
    // (indexed 6, embeddable 9, completed 6/10) — yet the truth is the opposite.
    // `changedSince: 0` (nothing was created/edited since the run) is what says so,
    // and the run's measured gap still legitimately excuses the 3 chunk-less pages.
    const cov = computeCoverage({
      indexed: 6,
      embeddable: 9,
      completedTotal: 6,
      completedEmbeddable: 10,
      changedSince: 0,
      indexedChangedSince: 0,
    });
    expect(cov).toEqual({ indexed: 6, total: 6, state: 'full' });
  });

  it('review F2 — converges back to full once the event indexer embeds the new pages', () => {
    // The same 3 new pages, now carrying rows of the active generation: they are in
    // the changed bucket AND in the numerator, so they cancel out.
    const cov = computeCoverage({
      indexed: 9,
      embeddable: 9,
      completedTotal: 6,
      completedEmbeddable: 10,
      changedSince: 3,
      indexedChangedSince: 3,
    });
    expect(cov).toEqual({ indexed: 9, total: 9, state: 'full' });
  });

  it('review F2 — a MOVED (touched but still indexed) page does not inflate the denominator', () => {
    // A page move bumps `updated_at` without touching content or vectors: it lands
    // in the changed bucket but keeps its rows, so it must not read as un-covered.
    // (This is why the numerator is split too, not just the denominator.)
    const cov = computeCoverage({
      indexed: 98,
      embeddable: 100,
      completedTotal: 98,
      completedEmbeddable: 100,
      changedSince: 5,
      indexedChangedSince: 5,
    });
    expect(cov).toEqual({ indexed: 98, total: 98, state: 'full' });
  });

  it('review F2 — the gap still excuses chunk-less pages that are UNTOUCHED (no D5 regression)', () => {
    // 2 chunk-less pages from the run survive untouched while 4 new pages were added
    // and embedded: the gap is spent on the old bucket only, and the state stays full.
    const cov = computeCoverage({
      indexed: 102,
      embeddable: 104,
      completedTotal: 98,
      completedEmbeddable: 100,
      changedSince: 4,
      indexedChangedSince: 4,
    });
    expect(cov).toEqual({ indexed: 102, total: 102, state: 'full' });
  });

  it('review F2 — an un-indexed OLD page beyond the measured gap is still reported (no blanket excuse)', () => {
    // The run measured a gap of 2, but 10 old pages now hold no rows (someone purged
    // rows out-of-band). The gap excuses 2 of them; the other 8 keep the state stale.
    const cov = computeCoverage({
      indexed: 90,
      embeddable: 100,
      completedTotal: 98,
      completedEmbeddable: 100,
      changedSince: 0,
      indexedChangedSince: 0,
    });
    expect(cov).toEqual({ indexed: 90, total: 98, state: 'stale' });
  });

  it('review F2 — the denominator is never below the numerator, whatever the live counts say', () => {
    // Deliberately inconsistent inputs (the counts are separate COUNTs taken a
    // moment apart, and `changedSince` could momentarily exceed `embeddable`).
    const cov = computeCoverage({
      indexed: 7,
      embeddable: 4,
      completedTotal: 4,
      completedEmbeddable: 10,
      changedSince: 99,
      indexedChangedSince: 99,
    });
    expect(cov.total).toBeGreaterThanOrEqual(cov.indexed);
    expect(cov.state).toBe('full');
  });
});

describe('EmbeddingGenerationService.getCoverage', () => {
  it('ignores a coverage total recorded for a DIFFERENT generation (bootstrap instead)', async () => {
    // Pointer names fp-OLD with total 98; asking about fp-NEW must not reuse it.
    const { service } = makeService({
      active: 'fp-OLD',
      coverageTotal: 98,
      coverageEmbeddable: 100,
      indexed: 10,
      embeddable: 100,
    });
    const cov = await service.getCoverage(WS, 'fp-NEW');
    expect(cov).toEqual({ indexed: 10, total: 100, state: 'stale' });
  });

  it('D3 — reports stale after pages are added to a fully indexed workspace', async () => {
    const { service } = makeService({
      active: 'fp-A',
      coverageTotal: 100,
      coverageEmbeddable: 100,
      indexed: 100,
      embeddable: 1100, // 1000 pages created since the run
    });
    await expect(service.getCoverage(WS, 'fp-A')).resolves.toEqual({
      indexed: 100,
      total: 1100,
      state: 'stale',
    });
  });

  it('review F2 — reports STALE for the reviewer corpus (chunk-less pages deleted, real pages added)', async () => {
    // End-to-end through the service: the stored record has the run's gap (6 of 10
    // produced) AND its timestamp, and the live counts say 9 embeddable / 6 indexed
    // with 3 of them created since the run and holding no rows. The frozen gap must
    // not excuse those 3.
    const { service, pageRepo, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      coverageTotal: 6,
      coverageEmbeddable: 10,
      coverageAt: RUN_AT,
      indexed: 6,
      embeddable: 9,
      changedSince: 3,
      indexedChangedSince: 0,
    });

    await expect(service.getCoverage(WS, 'fp-A')).resolves.toEqual({
      indexed: 6,
      total: 9,
      state: 'stale',
    });

    // The changed-bucket counts are really taken against the recorded run instant
    // (a wrong/absent cutoff would silently make every page look "old" again).
    expect(pageRepo.countEmbeddablePagesChangedSince).toHaveBeenCalledWith(
      WS,
      RUN_AT,
    );
    expect(pageEmbeddingRepo.countPagesByFingerprint).toHaveBeenCalledWith(
      WS,
      'fp-A',
      RUN_AT,
    );
  });

  it('review F2 — a record with no coverageAt (pre-key flip) skips the extra counts and keeps the old rule', async () => {
    const { service, pageRepo } = makeService({
      active: 'fp-A',
      coverageTotal: 98,
      coverageEmbeddable: 100,
      coverageAt: null, // flipped by a build that predates the key
      indexed: 98,
      embeddable: 100,
    });

    await expect(service.getCoverage(WS, 'fp-A')).resolves.toEqual({
      indexed: 98,
      total: 98,
      state: 'full',
    });
    // No timestamp -> no cutoff to count against -> the two extra COUNTs are skipped.
    expect(pageRepo.countEmbeddablePagesChangedSince).not.toHaveBeenCalled();
  });

  it('caches per (workspace, fingerprint) for the TTL', async () => {
    process.env.SEARCH_COVERAGE_TTL_MS = '60000';
    const { service, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      coverageTotal: 5,
      coverageEmbeddable: 5,
      indexed: 5,
      embeddable: 5,
    });
    await service.getCoverage(WS, 'fp-A');
    await service.getCoverage(WS, 'fp-A');
    expect(pageEmbeddingRepo.countPagesByFingerprint).toHaveBeenCalledTimes(1);

    // A flip/GC invalidates it.
    service.invalidateCoverage(WS);
    await service.getCoverage(WS, 'fp-A');
    expect(pageEmbeddingRepo.countPagesByFingerprint).toHaveBeenCalledTimes(2);
  });
});

describe('EmbeddingGenerationService.resolveGeneration', () => {
  it('falls back to the config fingerprint when the pointer was never flipped (no swap)', async () => {
    const { service } = makeService({
      active: null,
      configFingerprint: 'fp-A',
    });
    await expect(service.resolveGeneration(WS)).resolves.toMatchObject({
      active: 'fp-A',
      target: 'fp-A',
      swapping: false,
      modelChanged: false,
    });
  });

  it('reports a SWAP while the config has moved on from the active pointer', async () => {
    const { service } = makeService({
      active: 'fp-A',
      activeModel: 'model-1',
      configFingerprint: 'fp-B',
      configModel: 'model-1', // a revision/prefix change: SAME model
    });
    await expect(service.resolveGeneration(WS)).resolves.toMatchObject({
      active: 'fp-A',
      target: 'fp-B',
      swapping: true,
      modelChanged: false,
    });
  });

  it('serves the OLD generation to readers during a SAME-MODEL swap (revision/prefix change)', async () => {
    const { service } = makeService({
      active: 'fp-A',
      activeModel: 'e5-base',
      configFingerprint: 'fp-B',
      configModel: 'e5-base',
    });
    const res = await service.embedQueryForActiveGeneration(WS, 'кофе');
    // The vector is embedded with the NEW config, but the rows to filter are the
    // OLD generation's — same weights, same space, so recall stays alive across the
    // swap window.
    expect(res.fingerprint).toBe('fp-A');
    expect(res.generation).toMatchObject({
      active: 'fp-A',
      target: 'fp-B',
      swapping: true,
      modelChanged: false,
    });
  });

  // --- D2: the same-dimension MODEL change ----------------------------------

  it('D2 — a MODEL change flags modelChanged so no reader cosines across two spaces', async () => {
    // e5-base -> bge-base, both 768-dim: the dimension filter cannot see it. The two
    // encoders were trained independently, so their spaces are related by an
    // arbitrary rotation and `q(bge) . d(e5)` is noise.
    const { service } = makeService({
      active: 'fp-A',
      activeModel: 'intfloat/multilingual-e5-base',
      configFingerprint: 'fp-B',
      configModel: 'BAAI/bge-base-en',
    });

    const res = await service.embedQueryForActiveGeneration(WS, 'кофе');

    // NON-VACUITY: with `modelChanged` hard-wired to false (the pre-fix behaviour)
    // this fails, and the search/RAG readers happily raise the vector arm over the
    // old generation's rows.
    expect(res.generation.modelChanged).toBe(true);
    expect(res.generation.activeModel).toBe('intfloat/multilingual-e5-base');
    expect(res.generation.targetModel).toBe('BAAI/bge-base-en');
  });

  it('D2 — an UNKNOWN active model during a swap is treated as changed (conservative)', async () => {
    const { service } = makeService({
      active: 'fp-A',
      activeModel: null, // flipped by a build that predates the activeModel key
      configFingerprint: 'fp-B',
      configModel: 'e5-base',
    });
    const gen = await service.resolveGeneration(WS);
    expect(gen.modelChanged).toBe(true);
  });

  it('D2 — no swap in flight => never modelChanged (same fingerprint implies same model)', async () => {
    const { service } = makeService({
      active: 'fp-A',
      activeModel: null,
      configFingerprint: 'fp-A',
      configModel: 'e5-base',
    });
    const gen = await service.resolveGeneration(WS);
    expect(gen).toMatchObject({ swapping: false, modelChanged: false });
  });
});

describe('EmbeddingGenerationService.completeRun — the ATOMIC flip + its guard', () => {
  const run = (
    target: string,
    coverageTotal = 98,
    coverageEmbeddable = 100,
  ) => ({
    workspaceId: WS,
    target,
    targetModel: 'model-1',
    coverageTotal,
    coverageEmbeddable,
    coverageAt: RUN_AT,
  });

  it('flips the pointer and records model + denominators + coverageAt in ONE settings write', async () => {
    const { service, workspaceRepo, stored } = makeService({
      active: 'fp-A',
      configFingerprint: 'fp-B',
    });

    await expect(service.completeRun(run('fp-B'))).resolves.toBe(true);

    expect(workspaceRepo.setEmbeddingGeneration).toHaveBeenCalledTimes(1);
    expect(workspaceRepo.setEmbeddingGeneration).toHaveBeenCalledWith(WS, {
      activeFingerprint: 'fp-B',
      activeModel: 'model-1',
      coverageTotal: 98,
      coverageEmbeddable: 100,
      coverageAt: RUN_AT,
    });
    expect(stored).toEqual({
      activeFingerprint: 'fp-B',
      activeModel: 'model-1',
      coverageTotal: 98,
      coverageEmbeddable: 100,
      coverageAt: RUN_AT,
    });
  });

  /**
   * #599 review F1 — the config moved on WHILE this run was building fp-B, so the
   * pointer must not be flipped onto it. The old behaviour returned false, the job
   * COMPLETED successfully and was dropped by removeOnComplete — and because the
   * config change's own `aiQueue.add()` had been de-duplicated against this very
   * job, NOTHING was left to build fp-C: no rows, no job, no reconciler. On a model
   * change that meant permanently lexical-only search behind a green "Indexed N of
   * N" panel.
   *
   * The flip is still refused; the difference is that the run now FAILS, so BullMQ
   * retries it and the retry rebuilds the current target.
   */
  it('review F1 — THROWS a retryable error when the config changed DURING the run (never a silent skip)', async () => {
    const { service, workspaceRepo, stored } = makeService({
      active: 'fp-A',
      configFingerprint: 'fp-C',
    });

    // NON-VACUITY (the guard): drop the `configFingerprint !== target` check and
    // the pointer is flipped onto fp-B — a generation nobody maintains.
    await expect(service.completeRun(run('fp-B'))).rejects.toBeInstanceOf(
      StaleReindexTargetError,
    );
    expect(workspaceRepo.setEmbeddingGeneration).not.toHaveBeenCalled();
    expect(stored.activeFingerprint).toBe('fp-A');
  });

  it('review F1 — the thrown error names the built target and the current config', async () => {
    const { service } = makeService({
      active: 'fp-A',
      configFingerprint: 'fp-C',
    });

    // NON-VACUITY (the RE-TRIGGER): revert the throw to `return false` and this
    // reddens — which is the whole bug, because a successful return is precisely
    // what let the job complete and vanish without anyone building fp-C.
    await expect(service.completeRun(run('fp-B'))).rejects.toMatchObject({
      name: 'StaleReindexTargetError',
      workspaceId: WS,
      target: 'fp-B',
      configFingerprint: 'fp-C',
    });
  });

  it('review F1 — the stale run never GCs (its rows are left for the retry to reclaim)', async () => {
    const { service, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      configFingerprint: 'fp-C',
    });

    await expect(service.completeRun(run('fp-B'))).rejects.toBeInstanceOf(
      StaleReindexTargetError,
    );
    // A post-flip GC here (keep = [fp-B]) would destroy fp-A — the generation still
    // serving search — on behalf of a generation that was never published.
    expect(pageEmbeddingRepo.deleteOtherGenerations).not.toHaveBeenCalled();
  });

  it('does NOT flip (and never GCs) when the provider disappeared mid-run', async () => {
    const { service, workspaceRepo, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      configFingerprint: null,
    });

    // No provider = there is no target generation to build, so there is nothing for
    // a retry to do either: this one stays a quiet, successful no-op (unlike a
    // config DRIFT, which must be retried).
    await expect(service.completeRun(run('fp-B', 1, 1))).resolves.toBe(false);
    expect(workspaceRepo.setEmbeddingGeneration).not.toHaveBeenCalled();
    expect(pageEmbeddingRepo.deleteOtherGenerations).not.toHaveBeenCalled();
  });

  it('GCs the superseded generation only AFTER a successful flip (cap 1 generation)', async () => {
    const { service, pageEmbeddingRepo } = makeService({
      active: 'fp-A',
      configFingerprint: 'fp-B',
    });

    await service.completeRun(run('fp-B', 3, 3));

    expect(pageEmbeddingRepo.deleteOtherGenerations).toHaveBeenCalledWith(WS, [
      'fp-B',
    ]);
  });

  it('records the coverage total on the no-swap path too (first run of a fresh instance)', async () => {
    // active === target: nothing to flip, but the denominator MUST be recorded —
    // it is what turns `stale` into `full`.
    const { service, workspaceRepo } = makeService({
      active: null,
      configFingerprint: 'fp-A',
    });
    await expect(service.completeRun(run('fp-A', 42, 45))).resolves.toBe(true);
    expect(workspaceRepo.setEmbeddingGeneration).toHaveBeenCalledWith(WS, {
      activeFingerprint: 'fp-A',
      activeModel: 'model-1',
      coverageTotal: 42,
      coverageEmbeddable: 45,
      coverageAt: RUN_AT,
    });
  });
});

describe('EmbeddingGenerationService.gcGenerations', () => {
  it('keeps at most the 2 live generations (active + target)', async () => {
    const { service, pageEmbeddingRepo } = makeService();
    await service.gcGenerations(WS, ['fp-A', 'fp-B']);
    expect(pageEmbeddingRepo.deleteOtherGenerations).toHaveBeenCalledWith(WS, [
      'fp-A',
      'fp-B',
    ]);
  });
});

describe('EmbeddingGenerationService.runExclusive — the per-workspace run lock (#599 D4)', () => {
  // The exact SQL the service must send. Asserting the TEXT (not just the count of
  // statements) is what makes these tests non-vacuous: swap pg_advisory_unlock for a
  // no-op, or break the md5/substr/bit(64) key derivation so every workspace hashes
  // to the same key, and these assertions go red.
  const TRY_LOCK_SQL =
    "select pg_try_advisory_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint) as locked";
  const UNLOCK_SQL =
    "select pg_advisory_unlock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)";

  const normalize = (text: string) =>
    text.replace(/\s+/g, ' ').trim().toLowerCase();

  it('acquires the lock with a workspace-derived key, runs the body, then RELEASES it', async () => {
    const { service, executed } = makeService({ lockAvailable: true });
    const body = jest.fn().mockResolvedValue(undefined);

    await expect(service.runExclusive(WS, body)).resolves.toBe(true);
    expect(body).toHaveBeenCalledTimes(1);

    // Two statements on the SAME pinned connection: pg_try_advisory_lock, then
    // pg_advisory_unlock (a session-level lock must be released explicitly, or the
    // pooled connection returns to the pool still holding it and every future
    // reindex of this workspace skips itself as "already running", forever).
    expect(executed).toHaveLength(2);
    expect(normalize(executed[0].sql)).toBe(TRY_LOCK_SQL);
    expect(normalize(executed[1].sql)).toBe(UNLOCK_SQL);

    // The KEY is derived from the workspace id (bound as a parameter, not
    // interpolated — no injection surface), and both statements use the SAME key:
    // locking one key and unlocking another would leak the lock silently.
    expect(executed[0].parameters).toEqual([WS]);
    expect(executed[1].parameters).toEqual([WS]);
  });

  it('derives a DIFFERENT key per workspace (unrelated workspaces never serialise on one lock)', async () => {
    const a = makeService({ lockAvailable: true });
    const b = makeService({ lockAvailable: true });

    await a.service.runExclusive('ws-a', async () => undefined);
    await b.service.runExclusive('ws-b', async () => undefined);

    // Same SQL shape, different bound key input -> different md5 -> different
    // advisory-lock key. (A derivation that ignored the workspace id — a constant
    // key — would make every workspace in the deployment reindex one at a time.)
    expect(a.executed[0].parameters).toEqual(['ws-a']);
    expect(b.executed[0].parameters).toEqual(['ws-b']);
    expect(normalize(a.executed[0].sql)).toBe(normalize(b.executed[0].sql));
  });

  it('SKIPS the body when another run already holds the lock (a re-dispatched stalled job)', async () => {
    const { service, executed } = makeService({ lockAvailable: false });
    const body = jest.fn().mockResolvedValue(undefined);

    // NON-VACUITY: without the lock the body would run concurrently with the run
    // that holds it — its start GC would delete the other run's half-built target
    // generation, and a config rollback would then let the loser flip onto a HOLED
    // generation and GC the one still serving search.
    await expect(service.runExclusive(WS, body)).resolves.toBe(false);
    expect(body).not.toHaveBeenCalled();
    // Only the failed try-lock ran: we hold nothing, so we must NOT unlock — an
    // unconditional unlock here would release the WINNER's lock.
    expect(executed).toHaveLength(1);
    expect(normalize(executed[0].sql)).toBe(TRY_LOCK_SQL);
  });

  it('releases the lock even when the body THROWS (a fatal provider abort / a partial run)', async () => {
    const { service, executed } = makeService({ lockAvailable: true });
    const body = jest.fn().mockRejectedValue(new Error('fatal provider error'));

    await expect(service.runExclusive(WS, body)).rejects.toThrow(
      'fatal provider error',
    );
    // try-lock + unlock: a leaked session lock would block every future reindex of
    // this workspace on that pooled connection.
    expect(executed).toHaveLength(2);
    expect(normalize(executed[1].sql)).toBe(UNLOCK_SQL);
  });

  it("#599 R6 — a FAILING unlock never masks the body's error", async () => {
    const { service } = makeService({ lockAvailable: true, failUnlock: true });
    const body = jest
      .fn()
      .mockRejectedValue(new Error('fatal provider error: invalid api key'));

    // The unlock throws too (connection reset). An unguarded `await` in the finally
    // would REPLACE the run's real error with the unlock's, destroying the
    // diagnosis (and the retry semantics of a PartialReindexError).
    await expect(service.runExclusive(WS, body)).rejects.toThrow(
      'fatal provider error: invalid api key',
    );
  });

  it('#599 R6 — a FAILING unlock does not turn a SUCCESSFUL run into a failure', async () => {
    const { service } = makeService({ lockAvailable: true, failUnlock: true });
    const body = jest.fn().mockResolvedValue(undefined);

    // The run completed (the pointer already flipped); the unlock failing afterwards
    // is a logged operational problem, not a reason to fail the job and retry a full
    // reindex of the workspace.
    await expect(service.runExclusive(WS, body)).resolves.toBe(true);
    expect(body).toHaveBeenCalledTimes(1);
  });
});
