import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  AiChatMessage,
  InsertableAiChatMessage,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';

@Injectable()
export class AiChatMessageRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // The `tsv` column is a trigger-maintained tsvector used only for
  // full-text search. It must never be selected so it cannot leak into
  // HTTP responses or the chat history fed to the language model.
  private baseFields: Array<keyof AiChatMessage> = [
    'id',
    'chatId',
    'workspaceId',
    'userId',
    'role',
    'content',
    'toolCalls',
    'metadata',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ];

  async findByChat(
    chatId: string,
    workspaceId: string,
    pagination?: PaginationOptions,
  ) {
    const query = this.db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    // Default page size when no pagination options are supplied.
    const perPage = pagination?.limit ?? 50;

    return executeWithCursorPagination(query, {
      perPage,
      cursor: pagination?.cursor,
      beforeCursor: pagination?.beforeCursor,
      fields: [
        { expression: 'createdAt', direction: 'asc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });
  }

  // Load the most RECENT `limit` messages for a chat and return them in
  // ascending chronological order (oldest -> newest), as the model expects.
  // `findByChat` returns the FIRST page ASC (the OLDEST messages), which loses
  // recent turns once a chat grows beyond a page; this rebuilds the model
  // history from the tail instead. Plain query (no cursor pagination).
  async findRecent(
    chatId: string,
    workspaceId: string,
    limit: number,
  ): Promise<AiChatMessage[]> {
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    // Selected newest-first for the limit; reverse to oldest-first for the model.
    return rows.reverse();
  }

  async insert(
    insertable: InsertableAiChatMessage,
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiChatMessages')
      .values(insertable)
      .returning(this.baseFields)
      .executeTakeFirst();
  }
}
