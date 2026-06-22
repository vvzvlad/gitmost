import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  AiChat,
  InsertableAiChat,
  UpdatableAiChat,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';

@Injectable()
export class AiChatRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(id: string, workspaceId: string): Promise<AiChat | undefined> {
    return this.db
      .selectFrom('aiChats')
      .selectAll('aiChats')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async findByCreator(
    creatorId: string,
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    // Left-join the bound role for the badge (emoji + name). Joined, not
    // denormalized — the chat list is not a hot path. A soft-deleted role
    // resolves to NULL so the badge disappears, matching the stream's behavior.
    // A DISABLED role (enabled=false) is likewise excluded: resolveRoleForRequest
    // downgrades such a chat to the universal assistant, so the badge must not
    // advertise a role that is not actually applied.
    const query = this.db
      .selectFrom('aiChats')
      .leftJoin('aiAgentRoles', (join) =>
        join
          .onRef('aiAgentRoles.id', '=', 'aiChats.roleId')
          .on('aiAgentRoles.deletedAt', 'is', null)
          .on('aiAgentRoles.enabled', '=', true),
      )
      // Left-join the origin page for its title (provenance shown in the list).
      // Scoped to the chat's workspace as defense-in-depth so a page id can only
      // ever surface a same-workspace title. No deletedAt filter: a soft-deleted
      // page keeps showing its historical title; a hard-deleted page already
      // nulls aiChats.pageId via the FK.
      .leftJoin('pages', (join) =>
        join
          .onRef('pages.id', '=', 'aiChats.pageId')
          .onRef('pages.workspaceId', '=', 'aiChats.workspaceId'),
      )
      .selectAll('aiChats')
      .select([
        'aiAgentRoles.name as roleName',
        'aiAgentRoles.emoji as roleEmoji',
        'pages.title as pageTitle',
      ])
      .where('aiChats.creatorId', '=', creatorId)
      .where('aiChats.workspaceId', '=', workspaceId)
      .where('aiChats.deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        // Qualify to aiChats — the join introduces an aiAgentRoles.createdAt/id
        // that would otherwise make the ORDER BY / cursor comparison ambiguous.
        { expression: 'aiChats.createdAt', direction: 'desc' },
        { expression: 'aiChats.id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });
  }

  async insert(
    insertable: InsertableAiChat,
    trx?: KyselyTransaction,
  ): Promise<AiChat> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiChats')
      .values(insertable)
      .returningAll()
      .executeTakeFirst();
  }

  async update(
    id: string,
    updatable: UpdatableAiChat,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiChats')
      .set({ ...updatable, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async softDelete(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiChats')
      .set({ deletedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }
}
