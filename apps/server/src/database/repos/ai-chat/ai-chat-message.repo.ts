import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
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

// Hard upper bound on the rows materialized by `findAllByChat`, which now feeds
// BOTH the Markdown export and the per-turn model history.
// A generous cap so a pathologically huge chat cannot load an unbounded result
// into memory; far above any realistic transcript length.
const FIND_ALL_BY_CHAT_LIMIT = 5000;

// Delta-poll overlap (#491): the poll query reaches this far BEHIND the client's
// echoed cursor, so a row that committed with an `updatedAt` marginally before the
// previous cursor was taken (on another autocommit connection) is still caught.
// Sized well above realistic single-row commit skew; the client merge is
// idempotent by id (mergeById), so the guaranteed repeats the overlap produces are
// harmless.
export const DELTA_POLL_OVERLAP_SECONDS = 5;

// Hard cap on rows one delta poll returns — a safety bound (a poll should carry a
// handful of just-changed rows, never a whole transcript). Ordered by (updatedAt,
// id) asc, so on the pathological overflow the OLDEST changes win and the newest
// are picked up by the next poll (its cursor did not advance past them).
export const DELTA_POLL_MAX_ROWS = 500;

@Injectable()
export class AiChatMessageRepo {
  private readonly logger = new Logger(AiChatMessageRepo.name);

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
  // (oldest -> newest), unpaginated. Two callers, both treating the DB as the
  // single source of truth and needing the whole transcript in one pass
  // (findByChat is cursor-paginated and would only return the first page):
  //   - the server-side Markdown export (#183);
  //   - the per-turn model history, rebuilt fresh on every turn so the model
  //     sees the full authoritative transcript.
  //
  // Hard-capped at FIND_ALL_BY_CHAT_LIMIT rows (a generous bound, far above any
  // realistic transcript) — a shared memory-safety backstop for BOTH paths so a
  // pathologically huge chat cannot materialize an unbounded result set in
  // memory. On overflow the NEWEST rows are kept and a warning is logged.
  async findAllByChat(
    chatId: string,
    workspaceId: string,
    // Injectable for tests so truncation can be exercised on a modest volume.
    limit: number = FIND_ALL_BY_CHAT_LIMIT,
  ): Promise<AiChatMessage[]> {
    // Fetch newest-first (+1 to DETECT truncation), so on overflow we keep the
    // NEWEST `limit` messages — the recent conversation matters most — rather
    // than silently dropping the tail (#183 review). Then reverse back to
    // chronological order (oldest -> newest) for rendering / model replay.
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();

    if (rows.length > limit) {
      rows.length = limit; // keep the newest `limit` (rows are newest-first here)
      this.logger.warn(
        `Chat ${chatId} truncated to the newest ${limit} messages ` +
          `(older messages omitted).`,
      );
    }
    return rows.reverse();
  }

  /** Fetch a single message by id + workspace (e.g. a run's projection row for
   *  the #184 reconnect read). Returns undefined when nothing matches. */
  async findById(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /**
   * Delta read (#491) for the degraded poll: the chat's messages whose row
   * changed AFTER the client's `cursor`, plus a FRESH cursor taken from the DB
   * clock. Replaces the old "refetch ALL infinite-query pages every 2.5s with
   * full parts" poll — the client seeds once (findByChat) and thereafter pulls
   * only the deltas and merges them by id (mergeById).
   *
   * Cursor: a DB-clock timestamp (now()) the client echoes back each poll. All
   * delta-relevant writes stamp `updatedAt` with now() (see `update` /
   * `finalizeOwner`), so this is a SINGLE monotonic axis. The query overlaps the
   * cursor by DELTA_POLL_OVERLAP_SECONDS to catch a row committed with an
   * `updatedAt` marginally BEFORE the previous cursor was taken on another
   * connection (single-row autocommit UPDATEs; no long transactions). The overlap
   * GUARANTEES occasional REPEATS, so the client merge MUST be idempotent by id.
   *
   * `cursor === null` (first poll after the full seed) returns NO rows — there is
   * nothing "new" relative to a just-loaded seed — only the fresh cursor to start
   * the delta chain. The fresh cursor is read AFTER the rows, so it is >= every
   * returned row's `updatedAt` (they were read strictly earlier) — a row that
   * commits between the rows-read and the cursor-read is at most
   * DELTA_POLL_OVERLAP_SECONDS behind the returned cursor, so the next poll's
   * overlap window always re-includes it (no miss).
   */
  async findByChatUpdatedAfter(
    chatId: string,
    workspaceId: string,
    cursor: string | null,
  ): Promise<{ rows: AiChatMessage[]; cursor: string }> {
    if (cursor === null) {
      const nowRow = await sql<{ now: Date }>`select now() as now`.execute(
        this.db,
      );
      return { rows: [], cursor: nowRow.rows[0].now.toISOString() };
    }
    // Overlap the client cursor by DELTA_POLL_OVERLAP_SECONDS, computed in SQL off
    // the echoed cursor so the whole comparison stays on the DB clock.
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where(
        'updatedAt',
        '>',
        sql<Date>`${cursor}::timestamptz - make_interval(secs => ${DELTA_POLL_OVERLAP_SECONDS})`,
      )
      .orderBy('updatedAt', 'asc')
      .orderBy('id', 'asc')
      .limit(DELTA_POLL_MAX_ROWS)
      .execute();
    // When the page filled (pathological overflow), DO NOT advance the cursor to
    // now(): that would skip the changed rows past the cap that this poll did not
    // return. Resume from the last returned row's updatedAt instead (the next
    // poll's overlap re-includes ties by id). In the normal case the fresh DB-clock
    // now() is the cursor.
    if (rows.length === DELTA_POLL_MAX_ROWS) {
      return {
        rows,
        cursor: rows[rows.length - 1].updatedAt.toISOString(),
      };
    }
    const nowRow = await sql<{ now: Date }>`select now() as now`.execute(this.db);
    return { rows, cursor: nowRow.rows[0].now.toISOString() };
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
      // #491: stamp `updatedAt` from the DB clock (sql now()), NOT the app clock
      // (new Date()). The delta-poll cursor (findByChatUpdatedAfter) is a single
      // DB-clock axis; a per-step 'streaming' UPDATE stamped with the app clock
      // would be a SECOND, skewed clock source and could leave a row's updatedAt
      // just under a cursor taken from now() on another connection — an
      // independent source of delta MISSES. All delta-relevant writes use now().
      .set({ ...(patch as Record<string, unknown>), updatedAt: sql`now()` })
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
   * #487 OWNER terminal write — the streamText terminal callback's finalize. Like
   * `update` but CONDITIONAL on `status='streaming' OR metadata.finalizeFailed`:
   * the owner writes its real content EITHER when the row is still streaming (the
   * normal case) OR when a reconcile stamp already flipped it to a terminal status
   * but marked `finalizeFailed:true` — the owner's real content OVERWRITES that
   * placeholder stamp (owner-write priority, #487). A row that is properly terminal
   * (no finalizeFailed) is left untouched (undefined) — idempotent. The `patch`
   * carries the real metadata WITHOUT finalizeFailed, so a successful write CLEARS
   * the flag. Returns the updated row, or undefined when nothing matched.
   */
  async finalizeOwner(
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
      // #491: DB-clock stamp (see `update`) — this terminal write flips the row's
      // status, which the delta poll must observe on the shared now() cursor axis.
      .set({ ...(patch as Record<string, unknown>), updatedAt: sql`now()` })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'streaming'),
          eb(sql<string>`(metadata->>'finalizeFailed')`, '=', 'true'),
        ]),
      )
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * #487 RECONCILE status-only stamp — settle a stuck 'streaming' row to a
   * terminal status WITHOUT the owner's real content (which lived only in the
   * dead process's memory — a documented loss). CONDITIONAL on `status='streaming'`
   * (never touches an already-terminal row) AND it MERGES `finalizeFailed:true`
   * into metadata (preserving the partial `parts` already persisted) so a LATER
   * owner-write (finalizeOwner) can still OVERWRITE this placeholder with real
   * content, and so `isInterruptResume` can EXCLUDE this row (a reconcile stamp is
   * not a genuine user interruption). Returns the updated row, or undefined.
   */
  async stampTerminalIfStreaming(
    id: string,
    workspaceId: string,
    status: 'aborted' | 'error' | 'completed',
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('aiChatMessages')
      .set({
        status,
        metadata: sql`coalesce(metadata, '{}'::jsonb) || jsonb_build_object('finalizeFailed', true)`,
        // #491: DB-clock stamp (see `update`) so a reconcile status flip lands on
        // the same now() cursor axis the delta poll reads.
        updatedAt: sql`now()`,
      })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('status', '=', 'streaming')
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * #487 reconcile clause (b): streaming assistant rows whose linked RUN has
   * already reached a terminal status — an asymmetry ("run settled / message
   * streaming forever") the periodic reconcile heals by stamping the message.
   * Returns the message id + its run's terminal status, bounded.
   */
  async findStreamingWithTerminalRun(
    limit = 200,
    // #487: scope to ONE chat for the opportunistic per-turn reconcile (removes
    // reconcile latency from the user-visible path); omit for the periodic sweep.
    chat?: { chatId: string; workspaceId: string },
  ): Promise<
    Array<{ messageId: string; workspaceId: string; runStatus: string }>
  > {
    let query = this.db
      .selectFrom('aiChatMessages as m')
      .innerJoin('aiChatRuns as r', 'r.assistantMessageId', 'm.id')
      .select([
        'm.id as messageId',
        'm.workspaceId as workspaceId',
        'r.status as runStatus',
      ])
      .where('m.status', '=', 'streaming')
      .where('r.status', 'in', ['succeeded', 'failed', 'aborted']);
    if (chat) {
      query = query
        .where('m.chatId', '=', chat.chatId)
        .where('m.workspaceId', '=', chat.workspaceId);
    }
    return query.limit(limit).execute();
  }

  /**
   * #487 reconcile clause (d) — historical-row safety: streaming rows older than
   * `staleMs` whose chat has NO active run row (double-gated). Settle them to
   * 'aborted' + finalizeFailed (so a late owner-write could still overwrite).
   * Returns the count. Used ONLY by the periodic reconcile, never at boot.
   */
  async sweepStreamingWithoutActiveRun(
    staleMs: number,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const staleBefore = new Date(Date.now() - staleMs);
    const rows = await db
      .updateTable('aiChatMessages as m')
      .set({
        status: 'aborted',
        metadata: sql`coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object('finalizeFailed', true)`,
        // #491: DB-clock stamp (see `update`). The staleness WHERE below stays on
        // the app clock — a >minutes window makes the ms-scale skew irrelevant.
        updatedAt: sql`now()`,
      })
      .where('m.status', '=', 'streaming')
      .where('m.updatedAt', '<', staleBefore)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('aiChatRuns as r')
              .select('r.id')
              .whereRef('r.chatId', '=', 'm.chatId')
              .where('r.status', 'in', ['pending', 'running']),
          ),
        ),
      )
      .returning('m.id')
      .execute();
    return rows.length;
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
   *
   * #487: the sweep now ALSO marks `finalizeFailed:true` so a late owner-write can
   * overwrite this placeholder with real content (owner-write priority).
   */
  async sweepStreaming(trx?: KyselyTransaction): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const staleBefore = new Date(Date.now() - SWEEP_STREAMING_STALE_MS);
    const rows = await db
      .updateTable('aiChatMessages')
      .set({
        status: 'aborted',
        metadata: sql`coalesce(metadata, '{}'::jsonb) || jsonb_build_object('finalizeFailed', true)`,
        // #491: DB-clock stamp (see `update`). Staleness WHERE stays app-clock.
        updatedAt: sql`now()`,
      })
      .where('status', '=', 'streaming')
      .where('updatedAt', '<', staleBefore)
      .returning('id')
      .execute();
    return rows.length;
  }
}
