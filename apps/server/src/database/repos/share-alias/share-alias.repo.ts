import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  InsertableShareAlias,
  ShareAlias,
} from '@docmost/db/types/entity.types';

/**
 * Repository for vanity share aliases (`/l/:alias`). An alias is a long-lived,
 * workspace-scoped pointer to a page; retargeting is a single UPDATE of
 * `page_id`. All lookups are workspace-scoped so a name in one workspace can
 * never resolve a page in another.
 */
@Injectable()
export class ShareAliasRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private baseFields: Array<keyof ShareAlias> = [
    'id',
    'workspaceId',
    'alias',
    'pageId',
    'creatorId',
    'createdAt',
    'updatedAt',
  ];

  /** Resolve a (normalized) alias within a workspace, or undefined. */
  async findByAliasAndWorkspace(
    alias: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ShareAlias | undefined> {
    return dbOrTx(this.db, trx)
      .selectFrom('shareAliases')
      .select(this.baseFields)
      .where('alias', '=', alias)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  /** The alias currently pointing at a page (for the share modal). */
  async findByPageId(
    pageId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ShareAlias | undefined> {
    return dbOrTx(this.db, trx)
      .selectFrom('shareAliases')
      .select(this.baseFields)
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async findById(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ShareAlias | undefined> {
    return dbOrTx(this.db, trx)
      .selectFrom('shareAliases')
      .select(this.baseFields)
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async insert(
    insertable: InsertableShareAlias,
    trx?: KyselyTransaction,
  ): Promise<ShareAlias> {
    return dbOrTx(this.db, trx)
      .insertInto('shareAliases')
      .values(insertable)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /** Retarget an existing alias to a new page (the "swap" operation). */
  async updatePageId(
    id: string,
    pageId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ShareAlias> {
    return dbOrTx(this.db, trx)
      .updateTable('shareAliases')
      .set({ pageId, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async delete(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .deleteFrom('shareAliases')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }
}
