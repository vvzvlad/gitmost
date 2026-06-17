import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { AiProviderCredentials } from '@docmost/db/types/entity.types';

/**
 * Repository for per-workspace AI provider credentials.
 *
 * SECURITY (D9/§8.1): rows hold encrypted provider API keys. This table must
 * NEVER be added to workspace `baseFields` or returned by any workspace
 * endpoint. `api_key_enc` should only be read by the AI driver layer.
 */
@Injectable()
export class AiProviderCredentialsRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async find(
    workspaceId: string,
    driver: string,
  ): Promise<AiProviderCredentials | undefined> {
    return this.db
      .selectFrom('aiProviderCredentials')
      .selectAll('aiProviderCredentials')
      .where('workspaceId', '=', workspaceId)
      .where('driver', '=', driver)
      .executeTakeFirst();
  }

  async upsert(
    workspaceId: string,
    driver: string,
    apiKeyEnc: string,
    trx?: KyselyTransaction,
  ): Promise<AiProviderCredentials> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiProviderCredentials')
      .values({ workspaceId, driver, apiKeyEnc })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'driver']).doUpdateSet({
          apiKeyEnc,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirst();
  }

  async clearKey(
    workspaceId: string,
    driver: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiProviderCredentials')
      .set({ apiKeyEnc: null, updatedAt: new Date() })
      .where('workspaceId', '=', workspaceId)
      .where('driver', '=', driver)
      .execute();
  }

  // Upsert the embedding-specific encrypted key. If no row exists yet this
  // inserts one with `apiKeyEnc` left null (the column is nullable). On conflict
  // only `embeddingApiKeyEnc` / `updatedAt` are touched, so the chat key is kept.
  async upsertEmbeddingKey(
    workspaceId: string,
    driver: string,
    embeddingApiKeyEnc: string,
    trx?: KyselyTransaction,
  ): Promise<AiProviderCredentials> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiProviderCredentials')
      .values({ workspaceId, driver, embeddingApiKeyEnc })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'driver']).doUpdateSet({
          embeddingApiKeyEnc,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirst();
  }

  // Clear only the embedding-specific key; the chat key (`apiKeyEnc`) is kept.
  async clearEmbeddingKey(
    workspaceId: string,
    driver: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiProviderCredentials')
      .set({ embeddingApiKeyEnc: null, updatedAt: new Date() })
      .where('workspaceId', '=', workspaceId)
      .where('driver', '=', driver)
      .execute();
  }
}
