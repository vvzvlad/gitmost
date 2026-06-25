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
    'status',
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

  // Load ALL (non-deleted) messages of a chat in ascending chronological order
  // (oldest -> newest), unpaginated. Used by the server-side Markdown export
  // (#183), where the DB is the single source of truth and the whole transcript
  // must be rendered in one pass (findByChat is cursor-paginated and would only
  // return the first page).
  async findAllByChat(
    chatId: string,
    workspaceId: string,
  ): Promise<AiChatMessage[]> {
    return this.db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
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

  /**
   * Update a single message in place by id + workspace (#183 step-granular
   * durability). The assistant row is created UPFRONT (status 'streaming') and
   * patched as each step completes, then finalized once on the terminal status.
   * `updatedAt` is always bumped. Returns the updated row (baseFields) or
   * undefined when no row matched (e.g. a foreign workspace / deleted row).
   */
  async update(
    id: string,
    workspaceId: string,
    patch: Partial<{
      content: string | null;
      toolCalls: unknown;
      metadata: unknown;
      status: string | null;
    }>,
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('aiChatMessages')
      .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * Crash-recovery sweep (#183): flip every assistant row still left in the
   * 'streaming' state (a turn that died mid-write before reaching a terminal
   * status) to 'aborted'. Run once on server start. Returns the number of rows
   * swept so the caller can log it. Workspace-wide on purpose — a crash can have
   * dangling streaming rows across any workspace.
   */
  async sweepStreaming(trx?: KyselyTransaction): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const rows = await db
      .updateTable('aiChatMessages')
      .set({ status: 'aborted', updatedAt: new Date() })
      .where('status', '=', 'streaming')
      .returning('id')
      .execute();
    return rows.length;
  }
}
