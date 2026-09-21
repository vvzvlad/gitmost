import { Job } from 'bullmq';
import { EmbeddingProcessor } from './embedding.processor';
import { EmbeddingIndexerService } from './embedding-indexer.service';
import { PartialReindexError } from './embedding-indexer.service';
import { QueueJob } from '../../../integrations/queue/constants';

/**
 * #599 (R2) — the AI_QUEUE consumer's ERROR CONTRACT.
 *
 * The workspace-wide reindex and the per-page jobs need OPPOSITE handling, and the
 * bug this pins was that both were swallowed:
 *
 *   - a per-PAGE job keeps per-item isolation (one bad page must not drop the
 *     others, and a provider error must not crash the worker);
 *   - the WORKSPACE reindex must PROPAGATE, so BullMQ fails the job and retries it
 *     with backoff. A run that ends with failed pages does not flip the active
 *     generation, so swallowing the error completed the job "successfully" and
 *     nothing ever re-ran it: the workspace stayed in the swap window — ~2x pgvector
 *     rows on an un-indexed column, `semantic.state: stale`, lexical-only search
 *     after a model change — permanently, from ONE transient TEI timeout.
 */

function makeProcessor(indexer: Partial<EmbeddingIndexerService>) {
  return new EmbeddingProcessor(indexer as EmbeddingIndexerService);
}

function job(name: QueueJob, data: unknown, attemptsMade = 0): Job {
  return {
    name,
    data,
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job;
}

describe('EmbeddingProcessor — the retry contract (#599 R2)', () => {
  it('RETHROWS a partial workspace reindex so BullMQ retries the job', async () => {
    const err = new PartialReindexError('ws-1', 2, 100);
    const indexer = {
      reindexWorkspace: jest.fn().mockRejectedValue(err),
    };
    const processor = makeProcessor(indexer);

    // NON-VACUITY: with the old `catch { log }` the job COMPLETED and the workspace
    // never got another run. Swallowing here silently re-opens that hole.
    await expect(
      processor.process(
        job(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, { workspaceId: 'ws-1' }),
      ),
    ).rejects.toBe(err);
    expect(indexer.reindexWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('RETHROWS any other workspace-reindex failure too (a fatal provider abort)', async () => {
    const indexer = {
      reindexWorkspace: jest
        .fn()
        .mockRejectedValue({ statusCode: 401, message: 'invalid api key' }),
    };
    const processor = makeProcessor(indexer);

    // A bad key is retried a bounded number of times and then the job stays failed
    // (removeOnFail) — visible, instead of a "successful" job over a workspace whose
    // index was never rebuilt.
    await expect(
      processor.process(
        job(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, { workspaceId: 'ws-1' }, 2),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('COMPLETES the job when the reindex run succeeds (or skips: another run holds the lock)', async () => {
    const indexer = {
      reindexWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const processor = makeProcessor(indexer);

    await expect(
      processor.process(
        job(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, { workspaceId: 'ws-1' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('KEEPS per-page isolation: a failing page never fails the job (nor drops its siblings)', async () => {
    const indexer = {
      reindexPage: jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('embedding timed out'))
        .mockResolvedValueOnce(1),
    };
    const processor = makeProcessor(indexer);

    await expect(
      processor.process(
        job(QueueJob.PAGE_CONTENT_UPDATED, {
          workspaceId: 'ws-1',
          pageIds: ['p1', 'p2', 'p3'],
        }),
      ),
    ).resolves.toBeUndefined();
    // All three attempted despite the middle one failing.
    expect(indexer.reindexPage).toHaveBeenCalledTimes(3);
  });
});
