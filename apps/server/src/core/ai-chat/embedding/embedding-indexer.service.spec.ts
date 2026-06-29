import { EmbeddingIndexerService } from './embedding-indexer.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AiService } from '../../../integrations/ai/ai.service';
import { EmbeddingReindexProgressService } from '../../../integrations/ai/embedding-reindex-progress.service';
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

    const service = new EmbeddingIndexerService(
      pageRepo as unknown as PageRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      aiService as unknown as AiService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
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

    // Resolves (does not throw) even though every page failed.
    await expect(service.reindexWorkspace(WORKSPACE_ID)).resolves.toBeUndefined();
    // All three pages were attempted despite the failures.
    expect(reindexPage).toHaveBeenCalledTimes(3);
  });

  it('processes every page on the all-success path', async () => {
    const { service } = makeService();
    const reindexPage = jest
      .spyOn(service, 'reindexPage')
      .mockResolvedValue(undefined);

    await expect(service.reindexWorkspace(WORKSPACE_ID)).resolves.toBeUndefined();
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
    };
    const reindexProgress = {
      start: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
    };
    const db = {};
    const service = new EmbeddingIndexerService(
      pageRepo as unknown as PageRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      aiService as unknown as AiService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
      db as unknown as KyselyDB,
    );
    return { service, pageRepo, aiService, reindexProgress };
  }

  it('sets total at start, increments done per page, and clears in finally', async () => {
    const { service, reindexProgress } = makeService(['p1', 'p2', 'p3']);
    jest.spyOn(service, 'reindexPage').mockResolvedValue(undefined);

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

    await service.reindexWorkspace(WORKSPACE_ID);

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
    aiService.getEmbeddingModel = jest
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
