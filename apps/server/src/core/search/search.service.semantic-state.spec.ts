import { SearchService } from './search.service';
import { AiEmbeddingNotConfiguredException } from '../../integrations/ai/ai-embedding-not-configured.exception';

/**
 * #599 — the `semantic` block of the search response: the COVERAGE STATE.
 *
 *   off   — no provider (reason 'no-provider'), the kill-switch, or a degrade.
 *   stale — the vector arm ran, but the ACTIVE generation does not cover the
 *           workspace (legacy/half-indexed rows) or a fingerprint swap is in
 *           flight (the config changed; the OLD generation is what is served).
 *   full  — the active generation covers every page that produces a chunk.
 *
 * The service is unit-built with stub deps (the pattern the other search specs
 * use). The DB is stubbed at `runRankedQuery` level by making the raw-SQL
 * execution return no rows, so the request short-circuits to the empty-items
 * response — which still carries the `semantic` block under test.
 */

const WS = 'ws-1';

function makeService(opts: {
  // null => no provider (AiEmbeddingNotConfiguredException)
  generation: {
    active: string;
    target: string;
    swapping: boolean;
    // #599 D2: the served generation's rows come from a DIFFERENT model than the
    // one embedding the query -> the vector arm must not be raised at all.
    modelChanged?: boolean;
    activeModel?: string | null;
    targetModel?: string;
  } | null;
  coverage?: { indexed: number; total: number; state: 'full' | 'stale' };
  coverageThrows?: boolean;
}) {
  // Raw `sql`.execute(db) — the ranked-ids query. No rows: the search returns an
  // empty item list, but the semantic block is still assembled.
  const db: any = {
    executeQuery: jest.fn().mockResolvedValue({ rows: [] }),
    getExecutor: () => ({
      executeQuery: jest.fn().mockResolvedValue({ rows: [] }),
      compileQuery: jest.fn(),
      provideConnection: async (cb: any) =>
        cb({ executeQuery: async () => ({ rows: [] }) }),
    }),
    transaction: () => ({ execute: (cb: any) => cb({}) }),
  };

  const pageRepo = { getPageAndDescendants: jest.fn() };
  const shareRepo = {};
  const spaceMemberRepo = {
    getUserSpaceIds: jest.fn().mockResolvedValue(['space-1']),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest
      .fn()
      .mockImplementation(
        async ({ pageIds }: { pageIds: string[] }) => pageIds,
      ),
  };
  const pageEmbeddingRepo = {
    vectorCandidateArm: jest.fn(() => ({ __vectorArm: true })),
  };

  const embeddingGeneration = {
    embedQueryForActiveGeneration: jest.fn(async () => {
      if (!opts.generation) throw new AiEmbeddingNotConfiguredException();
      return {
        vector: [0.1, 0.2, 0.3],
        fingerprint: opts.generation.active,
        generation: {
          modelChanged: false,
          activeModel: 'e5-base',
          targetModel: 'e5-base',
          ...opts.generation,
        },
      };
    }),
    getCoverage: jest.fn(async () => {
      if (opts.coverageThrows) throw new Error('count failed');
      return opts.coverage ?? { indexed: 0, total: 0, state: 'full' as const };
    }),
  };

  const service = new SearchService(
    db,
    pageRepo as any,
    shareRepo as any,
    spaceMemberRepo as any,
    pagePermissionRepo as any,
    pageEmbeddingRepo as any,
    embeddingGeneration as any,
  );

  // Stub the ranked-ids SQL execution: these tests are about the semantic block,
  // not about ranking. No candidate ids => the early empty-items return.
  jest.spyOn(service as any, 'runRankedQuery').mockResolvedValue([]);

  return { service, embeddingGeneration, pageEmbeddingRepo };
}

const run = (service: SearchService) =>
  service.searchPage({ query: 'кофе' } as any, {
    userId: 'user-1',
    workspaceId: WS,
  });

afterEach(() => {
  delete process.env.SEARCH_SEMANTIC;
});

describe('SearchService semantic coverage state (#599)', () => {
  it('state=full when the active generation covers every page that produces a chunk', async () => {
    const { service, pageEmbeddingRepo } = makeService({
      generation: { active: 'fp-A', target: 'fp-A', swapping: false },
      coverage: { indexed: 98, total: 98, state: 'full' },
    });

    const res = await run(service);

    expect(res.semantic).toEqual({
      state: 'full',
      available: true,
      indexed: 98,
      total: 98,
    });
    // The vector arm is filtered by the ACTIVE fingerprint.
    expect(pageEmbeddingRepo.vectorCandidateArm).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'fp-A' }),
    );
  });

  it('state=stale (reason stale) on a legacy NULL-fingerprint instance: 0 of 100 pages carry the active fp', async () => {
    const { service } = makeService({
      generation: { active: 'fp-A', target: 'fp-A', swapping: false },
      coverage: { indexed: 0, total: 100, state: 'stale' },
    });

    const res = await run(service);

    expect(res.semantic).toEqual({
      state: 'stale',
      available: true,
      reason: 'stale',
      indexed: 0,
      total: 100,
    });
  });

  it('state=stale during a SWAP even though the active generation is fully covered', async () => {
    // The config moved to fp-B; the target reindex is in flight. fp-A (the served
    // generation) is 100% covered, but the workspace semantics no longer reflect
    // the configured model — the client must see `stale`, and the OLD generation
    // must keep being served (fingerprint = fp-A).
    const { service, pageEmbeddingRepo } = makeService({
      generation: { active: 'fp-A', target: 'fp-B', swapping: true },
      coverage: { indexed: 98, total: 98, state: 'full' },
    });

    const res = await run(service);

    expect(res.semantic).toMatchObject({
      state: 'stale',
      available: true,
      reason: 'stale',
    });
    expect(pageEmbeddingRepo.vectorCandidateArm).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'fp-A' }),
    );
  });

  it('state=off with reason no-provider when no embedding provider resolves', async () => {
    const { service, pageEmbeddingRepo } = makeService({ generation: null });

    const res = await run(service);

    expect(res.semantic).toEqual({
      state: 'off',
      available: false,
      reason: 'no-provider',
    });
    // No coverage numbers when nothing ran, and no vector arm at all.
    expect(pageEmbeddingRepo.vectorCandidateArm).not.toHaveBeenCalled();
  });

  it('state=off when the SEARCH_SEMANTIC kill-switch is set (never even resolves a generation)', async () => {
    process.env.SEARCH_SEMANTIC = 'off';
    const { service, embeddingGeneration } = makeService({
      generation: { active: 'fp-A', target: 'fp-A', swapping: false },
      coverage: { indexed: 1, total: 1, state: 'full' },
    });

    const res = await run(service);

    expect(res.semantic).toEqual({ state: 'off', available: false });
    expect(
      embeddingGeneration.embedQueryForActiveGeneration,
    ).not.toHaveBeenCalled();
  });

  // --- #599 D2: the same-dimension MODEL change ------------------------------

  it('D2 — a MODEL change at the SAME dimension does NOT raise the vector arm (lexical only)', async () => {
    // e5-base (768) -> bge-base (768). The `model_dimensions = queryDim` filter is
    // blind to this: it would happily cosine the bge query vector against the e5
    // rows, and RRF would then hoist those arbitrarily ranked pages above genuine
    // lexical hits — strictly worse than no vector arm at all.
    const { service, pageEmbeddingRepo, embeddingGeneration } = makeService({
      generation: {
        active: 'fp-A',
        target: 'fp-B',
        swapping: true,
        modelChanged: true,
        activeModel: 'intfloat/multilingual-e5-base',
        targetModel: 'BAAI/bge-base-en',
      },
      coverage: { indexed: 98, total: 98, state: 'full' },
    });

    const res = await run(service);

    // NON-VACUITY: revert the `generation.modelChanged` branch in SearchService and
    // this fails — the arm is built and the cross-space cosine is fused into RRF.
    expect(pageEmbeddingRepo.vectorCandidateArm).not.toHaveBeenCalled();
    expect(res.semantic).toEqual({
      state: 'stale',
      available: false,
      reason: 'stale',
    });
    // Coverage of a generation nothing was served from is meaningless -> not queried.
    expect(embeddingGeneration.getCoverage).not.toHaveBeenCalled();
  });

  it('D2 — a same-MODEL fingerprint change (revision/prefix) STILL serves the old generation', async () => {
    const { service, pageEmbeddingRepo } = makeService({
      generation: {
        active: 'fp-A',
        target: 'fp-B',
        swapping: true,
        modelChanged: false,
        activeModel: 'intfloat/multilingual-e5-base',
        targetModel: 'intfloat/multilingual-e5-base',
      },
      coverage: { indexed: 98, total: 98, state: 'full' },
    });

    const res = await run(service);

    // Same weights => same embedding space: the old generation stays comparable and
    // MUST keep serving, or a routine revision bump would blank out semantic search
    // for the whole reindex window.
    expect(pageEmbeddingRepo.vectorCandidateArm).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'fp-A' }),
    );
    expect(res.semantic).toMatchObject({ state: 'stale', available: true });
  });

  it('a failing coverage COUNT keeps the arm but reports UNKNOWN coverage as stale, never full (R3)', async () => {
    const { service, pageEmbeddingRepo } = makeService({
      generation: { active: 'fp-A', target: 'fp-A', swapping: false },
      coverageThrows: true,
    });

    const res = await run(service);

    // Coverage is cosmetic: the arm still ran, so `available` stays true (no false
    // `off`, no `degraded`). But `full` means "the active generation covers every
    // page" — with the COUNT failed we cannot prove that, and on a legacy workspace
    // with 0 indexed pages `full` would be an outright lie. Unknown -> `stale`.
    expect(res.semantic).toMatchObject({
      state: 'stale',
      available: true,
      reason: 'stale',
    });
    expect(res.semantic?.indexed).toBeUndefined();
    expect(res.semantic?.total).toBeUndefined();
    expect(pageEmbeddingRepo.vectorCandidateArm).toHaveBeenCalled();
  });
});
