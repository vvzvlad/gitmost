import {
  EmbeddingIndexerService,
  PartialReindexError,
} from './embedding-indexer.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AiService } from '../../../integrations/ai/ai.service';
import { EmbeddingGenerationService } from '../../../integrations/ai/embedding-generation.service';
import { EmbeddingReindexProgressService } from '../../../integrations/ai/embedding-reindex-progress.service';

/**
 * #599: the fingerprint-lifecycle collaborator. These specs cover the BATCH
 * control flow / the per-page write, so the lifecycle is stubbed at its no-swap
 * steady state (active === target). The lifecycle itself (start GC, atomic flip +
 * its config-changed guard, post-flip GC, abort => no flip, fp-scoped delete) is
 * covered in embedding-indexer.lifecycle.spec.ts.
 */
function makeGenerationStub(fingerprint = 'fp-test') {
  return {
    generationForTarget: jest.fn().mockResolvedValue({
      active: fingerprint,
      target: fingerprint,
      swapping: false,
      modelChanged: false,
      activeModel: 'some-model',
      targetModel: 'some-model',
    }),
    gcGenerations: jest.fn().mockResolvedValue(0),
    completeRun: jest.fn().mockResolvedValue(true),
    // #599 D4: the run lock. The stub is a pass-through single-flight — these specs
    // cover the batch control flow, not the lock protocol (that lives in
    // embedding-generation.service.spec.ts).
    runExclusive: jest.fn(async (_ws: string, fn: () => Promise<void>) => {
      await fn();
      return true;
    }),
  };
}
import { AiEmbeddingNotConfiguredException } from '../../../integrations/ai/ai-embedding-not-configured.exception';

/**
 * Unit tests for EmbeddingIndexerService.reindexWorkspace's batch control flow.
 *
 * The constructor body only stores its deps, so the service can be unit-built
 * with lightweight mocks — no Nest module graph. We stub only the methods that
 * reindexWorkspace actually touches:
 *   - aiService.getEmbeddingModel -> a model string so the up-front configured
 *     check passes,
 *   - pageRepo.getEmbeddablePageIds -> three page ids (the embeddable set the
 *     reindex iterates),
 *   - service.reindexPage -> spied per test to drive the per-page outcome.
 *
 * The point under test is the catch block: a FATAL provider error (auth/billing)
 * must abort the whole batch (re-throw, stop iterating), while a non-fatal error
 * keeps per-page isolation (failed++, continue to the next page).
 */
describe('EmbeddingIndexerService.reindexWorkspace fail-fast', () => {
  const WORKSPACE_ID = 'ws-1';

  function makeService() {
    const pageRepo = {
      getEmbeddablePageIds: jest.fn().mockResolvedValue(['p1', 'p2', 'p3']),
    };
    const pageEmbeddingRepo = {};
    const aiService = {
      getEmbeddingModel: jest.fn().mockResolvedValue('some-model'),
      // #530: reindexWorkspace's pre-check now resolves the provider (workspace
      // or global). Resolve it so the batch control flow under test proceeds.
      resolveEmbeddingProvider: jest.fn().mockResolvedValue({
        model: 'some-model',
        modelId: 'some-model',
        queryPrefix: '',
        docPrefix: '',
        fingerprint: 'fp-test',
      }),
    };
    // Progress is a best-effort cosmetic store; mock its async methods so the
    // batch control flow can be tested without Redis.
    const reindexProgress = {
      start: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
    };
    const db = {};

    const generation = makeGenerationStub('fp-test');
    const service = new EmbeddingIndexerService(
      pageRepo as unknown as PageRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      aiService as unknown as AiService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
      generation as unknown as EmbeddingGenerationService,
      db as unknown as KyselyDB,
    );
    return { service, pageRepo, aiService, reindexProgress };
  }

  it('aborts after the first page on a FATAL (401) provider error', async () => {
    const { service } = makeService();
    // A 401 "User not found" recurs identically on every page -> must abort.
    const reindexPage = jest
      .spyOn(service, 'reindexPage')
      .mockRejectedValue({ statusCode: 401, message: 'User not found' });

    await expect(service.reindexWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      statusCode: 401,
    });
    // Aborted on the first page: pages 2 and 3 were never attempted.
    expect(reindexPage).toHaveBeenCalledTimes(1);
  });

  it('keeps per-page isolation on a non-fatal error (plain Error, no statusCode)', async () => {
    const { service } = makeService();
    // No statusCode -> non-fatal -> isolate per page and continue.
    const reindexPage = jest
      .spyOn(service, 'reindexPage')
      .mockRejectedValue(new Error('boom'));

    // The BATCH is not aborted (that is the isolation): all three pages are still
    // attempted. It does end in a PartialReindexError though — #599 R2: a run with
    // failed pages must FAIL the job so BullMQ retries it, instead of completing
    // "successfully" and leaving the workspace stuck in the swap window forever.
    await expect(service.reindexWorkspace(WORKSPACE_ID)).rejects.toBeInstanceOf(
      PartialReindexError,
    );
    // All three pages were attempted despite the failures.
    expect(reindexPage).toHaveBeenCalledTimes(3);
  });

  it('processes every page on the all-success path', async () => {
    const { service } = makeService();
    const reindexPage = jest
      .spyOn(service, 'reindexPage')
      // #599: reindexPage now returns the number of chunk rows it wrote.
      .mockResolvedValue(1);

    await expect(
      service.reindexWorkspace(WORKSPACE_ID),
    ).resolves.toBeUndefined();
    expect(reindexPage).toHaveBeenCalledTimes(3);
  });
});

/**
 * Live reindex-progress reporting: reindexWorkspace must publish a per-workspace
 * progress record (total at start, done incremented per processed page) and ALWAYS
 * clear it in a finally — including on a fatal abort and an unconfigured early
 * return — so the settings status can show the counter climb without ever getting
 * stuck in a "reindexing" state.
 */
describe('EmbeddingIndexerService.reindexWorkspace progress', () => {
  const WORKSPACE_ID = 'ws-1';

  function makeService(pageIds: string[] = ['p1', 'p2', 'p3']) {
    const pageRepo = {
      getEmbeddablePageIds: jest.fn().mockResolvedValue(pageIds),
    };
    const pageEmbeddingRepo = {};
    const aiService = {
      getEmbeddingModel: jest.fn().mockResolvedValue('some-model'),
      // #530: reindexWorkspace's pre-check now resolves the provider (workspace
      // or global). Resolve it so the batch control flow under test proceeds.
      resolveEmbeddingProvider: jest.fn().mockResolvedValue({
        model: 'some-model',
        modelId: 'some-model',
        queryPrefix: '',
        docPrefix: '',
        fingerprint: 'fp-test',
      }),
    };
    const reindexProgress = {
      start: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
    };
    const db = {};
    const generation = makeGenerationStub('fp-test');
    const service = new EmbeddingIndexerService(
      pageRepo as unknown as PageRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      aiService as unknown as AiService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
      generation as unknown as EmbeddingGenerationService,
      db as unknown as KyselyDB,
    );
    return { service, pageRepo, aiService, reindexProgress };
  }

  it('sets total at start, increments done per page, and clears in finally', async () => {
    const { service, reindexProgress } = makeService(['p1', 'p2', 'p3']);
    jest.spyOn(service, 'reindexPage').mockResolvedValue(1);

    await service.reindexWorkspace(WORKSPACE_ID);

    expect(reindexProgress.start).toHaveBeenCalledWith(WORKSPACE_ID, 3);
    // One increment per processed page.
    expect(reindexProgress.increment).toHaveBeenCalledTimes(3);
    expect(reindexProgress.increment).toHaveBeenCalledWith(WORKSPACE_ID);
    // Cleared exactly once on completion.
    expect(reindexProgress.clear).toHaveBeenCalledTimes(1);
    expect(reindexProgress.clear).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('counts a handled (non-fatal) per-page failure as processed', async () => {
    const { service, reindexProgress } = makeService(['p1', 'p2', 'p3']);
    // No statusCode -> non-fatal -> isolate and continue; each counts as done.
    jest.spyOn(service, 'reindexPage').mockRejectedValue(new Error('boom'));

    // Ends in a partial-run failure (#599 R2 — retried by BullMQ), but the progress
    // record is still advanced per page and cleared in the finally.
    await expect(service.reindexWorkspace(WORKSPACE_ID)).rejects.toBeInstanceOf(
      PartialReindexError,
    );

    expect(reindexProgress.increment).toHaveBeenCalledTimes(3);
    expect(reindexProgress.clear).toHaveBeenCalledTimes(1);
  });

  it('clears progress in finally even when a FATAL provider error aborts the batch', async () => {
    const { service, reindexProgress } = makeService(['p1', 'p2', 'p3']);
    // A 401 aborts on the first page (re-thrown) — the finally must still clear.
    jest
      .spyOn(service, 'reindexPage')
      .mockRejectedValue({ statusCode: 401, message: 'User not found' });

    await expect(service.reindexWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      statusCode: 401,
    });

    expect(reindexProgress.start).toHaveBeenCalledWith(WORKSPACE_ID, 3);
    // Aborted page is NOT counted as processed.
    expect(reindexProgress.increment).not.toHaveBeenCalled();
    // But progress is still cleared so the run never gets stuck.
    expect(reindexProgress.clear).toHaveBeenCalledTimes(1);
  });

  it('clears the enqueue-seeded progress on an unconfigured early return', async () => {
    const { service, aiService, reindexProgress } = makeService();
    // Embeddings not configured: reindexWorkspace returns early WITHOUT starting
    // a fresh record, but the finally must still clear the enqueue-time seed.
    aiService.resolveEmbeddingProvider = jest
      .fn()
      .mockRejectedValue(new AiEmbeddingNotConfiguredException());

    await expect(
      service.reindexWorkspace(WORKSPACE_ID),
    ).resolves.toBeUndefined();

    expect(reindexProgress.start).not.toHaveBeenCalled();
    expect(reindexProgress.clear).toHaveBeenCalledTimes(1);
    expect(reindexProgress.clear).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

/**
 * #530 PR-1: reindexPage must (a) prepend the provider's DOC prefix to each chunk
 * BEFORE embedding (so stored vectors live in the same prefixed space as a
 * prefixed query), and (b) stamp the ACTIVE fingerprint on every inserted row (so
 * search only fuses same-generation vectors). Uses lightweight mocks; the tx is
 * stubbed to run its callback inline.
 */
describe('EmbeddingIndexerService.reindexPage doc-prefix + fingerprint (#530)', () => {
  const WORKSPACE_ID = 'ws-1';
  const SPACE_ID = 'space-1';
  const PAGE_ID = 'page-1';

  function makeService(docPrefix: string) {
    const pageRepo = {
      findById: jest.fn().mockResolvedValue({
        id: PAGE_ID,
        workspaceId: WORKSPACE_ID,
        spaceId: SPACE_ID,
        title: 'Заголовок',
        // No ProseMirror content -> the plain-text fallback path (single chunk).
        content: null,
        textContent: 'простой текст страницы',
        deletedAt: null,
      }),
    };
    const insertChunks = jest.fn().mockResolvedValue(undefined);
    const pageEmbeddingRepo = {
      deleteByPage: jest.fn().mockResolvedValue(undefined),
      insertChunks,
    };
    const embedWithModel = jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
    const aiService = {
      resolveEmbeddingProvider: jest.fn().mockResolvedValue({
        model: { modelId: 'e5-small' },
        // #599: the resolved provider now reports the bare model id directly (the
        // indexer stamps it per row and the flip records it with the pointer).
        modelId: 'e5-small',
        queryPrefix: 'query: ',
        docPrefix,
        fingerprint: 'fp-gen-1',
      }),
      embedWithModel,
    };
    const reindexProgress = {};
    // Stub the tx so executeTx runs its callback inline against a fake trx.
    const db = {
      transaction: () => ({ execute: (cb: any) => cb({}) }),
    };
    const generation = makeGenerationStub('fp-gen-1');
    const service = new EmbeddingIndexerService(
      pageRepo as unknown as PageRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      aiService as unknown as AiService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
      generation as unknown as EmbeddingGenerationService,
      db as unknown as KyselyDB,
    );
    return { service, embedWithModel, insertChunks };
  }

  it('prepends the doc prefix to each chunk and stamps the fingerprint on rows', async () => {
    const { service, embedWithModel, insertChunks } = makeService('passage: ');
    await service.reindexPage(PAGE_ID);

    // Embedded values are DOC-prefixed; the model is the resolved provider model.
    expect(embedWithModel).toHaveBeenCalledTimes(1);
    const [modelArg, wsArg, valuesArg] = embedWithModel.mock.calls[0];
    expect(modelArg).toEqual({ modelId: 'e5-small' });
    expect(wsArg).toBe(WORKSPACE_ID);
    expect(valuesArg).toEqual(['passage: простой текст страницы']);

    // Inserted rows carry the active fingerprint and the ORIGINAL (un-prefixed)
    // content (the prefix is an embedding-space artifact, not stored text).
    expect(insertChunks).toHaveBeenCalledTimes(1);
    const rows = insertChunks.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].fingerprint).toBe('fp-gen-1');
    expect(rows[0].content).toBe('простой текст страницы');
    expect(rows[0].modelName).toBe('e5-small');
  });

  it('does not prefix when the provider has an empty doc prefix', async () => {
    const { service, embedWithModel } = makeService('');
    await service.reindexPage(PAGE_ID);
    const [, , valuesArg] = embedWithModel.mock.calls[0];
    expect(valuesArg).toEqual(['простой текст страницы']);
  });
});
