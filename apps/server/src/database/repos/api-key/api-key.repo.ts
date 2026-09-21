import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { DB, Users } from '@docmost/db/types/db';
import { dbOrTx } from '@docmost/db/utils';
import { ApiKey, InsertableApiKey } from '@docmost/db/types/entity.types';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { ExpressionBuilder } from 'kysely';

// Public-facing shape: the api_keys row plus a compact creator attribution used
// by the admin list (the workspace-wide view attributes each key to its author).
export type ApiKeyWithCreator = ApiKey & {
  creator: Pick<Users, 'id' | 'name' | 'email' | 'avatarUrl'> | null;
};

@Injectable()
export class ApiKeyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // Compact creator attribution embedded in the admin list rows. A nested
  // subquery (jsonObjectFrom) keeps it one round-trip; the token material is
  // never stored, so nothing sensitive is joined in.
  private withCreator(eb: ExpressionBuilder<DB, 'apiKeys'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'apiKeys.creatorId'),
    ).as('creator');
  }

  async findById(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ApiKey | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('apiKeys')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      // Convention (soft-delete): a revoked key is invisible to reads.
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async findByCreator(
    creatorId: string,
    workspaceId: string,
  ): Promise<ApiKeyWithCreator[]> {
    return this.db
      .selectFrom('apiKeys')
      .selectAll('apiKeys')
      .select((eb) => this.withCreator(eb))
      .where('creatorId', '=', creatorId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .execute() as unknown as Promise<ApiKeyWithCreator[]>;
  }

  async findAllInWorkspace(
    workspaceId: string,
  ): Promise<ApiKeyWithCreator[]> {
    return this.db
      .selectFrom('apiKeys')
      .selectAll('apiKeys')
      .select((eb) => this.withCreator(eb))
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .execute() as unknown as Promise<ApiKeyWithCreator[]>;
  }

  async insert(
    insertable: InsertableApiKey,
    trx?: KyselyTransaction,
  ): Promise<ApiKey> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('apiKeys')
      .values(insertable)
      .returningAll()
      .executeTakeFirst();
  }

  // Soft-delete = revoke. Terminal: the row stays for forensics but is invisible
  // to every read above, so validate() denies it immediately (no grace window).
  async softDelete(id: string, workspaceId: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  // Throttled best-effort forensics stamp. Not on the critical path: callers
  // fire-and-forget and swallow errors, so it never fails a request.
  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .execute();
  }
}
