import { EmbeddingIndexerService } from './embedding-indexer.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AiService } from '../../../integrations/ai/ai.service';

/**
 * Unit tests for EmbeddingIndexerService.reindexWorkspace's batch control flow.
 *
 * The constructor body only stores its deps, so the service can be unit-built
 * with lightweight mocks — no Nest module graph. We stub only the methods that
 * reindexWorkspace actually touches:
 *   - aiService.getEmbeddingModel -> a model string so the up-front configured
 *     check passes,
 *   - pageRepo.getIdsByWorkspace -> three page ids,
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
      getIdsByWorkspace: jest.fn().mockResolvedValue(['p1', 'p2', 'p3']),
    };
    const pageEmbeddingRepo = {};
    const aiService = {
      getEmbeddingModel: jest.fn().mockResolvedValue('some-model'),
    };
    const db = {};

    const service = new EmbeddingIndexerService(
      pageRepo as unknown as PageRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      aiService as unknown as AiService,
      db as unknown as KyselyDB,
    );
    return { service, pageRepo, aiService };
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
