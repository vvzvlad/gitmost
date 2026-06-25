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

// Crash-recovery sweep recency threshold (#183 review): a 'streaming' row is
// only swept to 'aborted' once it has been UNTOUCHED for this long. A live turn
// bumps `updatedAt` on every step (well under this window), so its row never
// matches; only a turn whose process truly died (no step update for >threshold)
// is swept. Chosen safely ABOVE the longest realistic turn so a fresh replica's
// boot-sweep can never abort a turn another replica is actively streaming
// (multi-instance deploy).
const SWEEP_STREAMING_STALE_MS = 10 * 60 * 1000; // 10 minutes

// Hard upper bound on the rows materialized by `findAllByChat` (export path).
// A generous cap so a pathologically huge chat cannot load an unbounded result
// into memory; far above any realistic transcript length.
const FIND_ALL_BY_CHAT_LIMIT = 5000;

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
  //
  // Hard-capped at FIND_ALL_BY_CHAT_LIMIT rows (a generous bound, far above any
  // realistic transcript) so exporting a pathologically huge chat cannot
  // materialize an unbounded result set in memory.
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
      .limit(FIND_ALL_BY_CHAT_LIMIT)
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
    opts?: { onlyIfStreaming?: boolean; trx?: KyselyTransaction },
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    let query = db
      .updateTable('aiChatMessages')
      .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId);
    // Concurrency guard (#183 review): a per-step 'streaming' update must NEVER
    // overwrite a row the terminal callback already finalized. onStepFinish
    // fires the streaming update fire-and-forget, so its UPDATE can land AFTER
    // finalize on a DIFFERENT pool connection (commit order is not guaranteed).
    // Scoping the streaming update to rows STILL in 'streaming' makes a late
    // update a no-op once the row is completed/error/aborted — regardless of
    // commit order. The terminal finalize runs WITHOUT this guard so it always
    // wins.
    if (opts?.onlyIfStreaming) {
      query = query.where('status', '=', 'streaming');
    }
    return query.returning(this.baseFields).executeTakeFirst();
  }

  /**
   * Crash-recovery sweep (#183): flip every assistant row still left in the
   * 'streaming' state (a turn that died mid-write before reaching a terminal
   * status) to 'aborted'. Run once on server start. Returns the number of rows
   * swept so the caller can log it. Workspace-wide on purpose — a crash can have
   * dangling streaming rows across any workspace.
   *
   * Bounded by recency (#183 review): only rows UNTOUCHED for
   * SWEEP_STREAMING_STALE_MS are swept. A live turn bumps `updatedAt` on every
   * step, so an actively-streaming row never matches; this prevents a fresh
   * replica's boot-sweep from aborting a turn another replica is still streaming
   * in a multi-instance deploy.
   */
  async sweepStreaming(trx?: KyselyTransaction): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const staleBefore = new Date(Date.now() - SWEEP_STREAMING_STALE_MS);
    const rows = await db
      .updateTable('aiChatMessages')
      .set({ status: 'aborted', updatedAt: new Date() })
      .where('status', '=', 'streaming')
      .where('updatedAt', '<', staleBefore)
      .returning('id')
      .execute();
    return rows.length;
  }
}
