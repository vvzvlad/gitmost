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

  /**
   * The alias currently pointing at a page (for the share modal). The service
   * enforces a single alias row per page, but legacy rows (pre-invariant) may
   * still exist until self-healed; the explicit ORDER BY makes the "current"
   * choice DETERMINISTIC (newest wins — i.e. the most recently created address,
   * which is the one the user last asked for) instead of an arbitrary Postgres
   * heap order.
   */
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
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
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

  /**
   * Rename an existing alias row in place (the vanity-slug edit, e.g.
   * `te` -> `ted`). Keeps the row's id/page_id/creator so the page's single
   * alias pointer is preserved — only the human-readable name changes.
   */
  async updateAlias(
    id: string,
    alias: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ShareAlias> {
    return dbOrTx(this.db, trx)
      .updateTable('shareAliases')
      .set({ alias, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * Self-heal helper: drop every OTHER alias row still pointing at a page,
   * keeping only `keepId`. Enforces the "exactly one custom address per page"
   * invariant after a rename/retarget and reaps any legacy duplicates.
   */
  async deleteOthersForPage(
    pageId: string,
    keepId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .deleteFrom('shareAliases')
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('id', '!=', keepId)
      .execute();
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
