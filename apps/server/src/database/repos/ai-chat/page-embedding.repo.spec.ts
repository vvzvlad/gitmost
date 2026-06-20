import { PageEmbeddingRepo } from './page-embedding.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * Unit test for the pure access-scoping branch of searchByEmbedding: when the
 * caller has NO accessible spaces (`spaceIds` empty), the method must early-
 * return [] WITHOUT touching the database. We inject a db whose query builder
 * throws if invoked, so any DB access fails the test.
 *
 * NOTE: the dimension-mixing case (filter by model_dimensions) needs a live
 * pgvector-enabled Postgres and is intentionally NOT covered here — it requires
 * a real DB and is out of scope for this pure unit test.
 */
describe('PageEmbeddingRepo.searchByEmbedding', () => {
  it('early-returns [] for empty spaceIds without any DB call', async () => {
    const throwingDb = {
      selectFrom: () => {
        throw new Error('DB should not be queried for empty spaceIds');
      },
    } as unknown as KyselyDB;

    const repo = new PageEmbeddingRepo(throwingDb);
    const result = await repo.searchByEmbedding('ws-1', [0.1, 0.2, 0.3], [], 10);
    expect(result).toEqual([]);
  });
});
