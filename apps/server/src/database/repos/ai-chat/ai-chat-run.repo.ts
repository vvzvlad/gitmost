import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  AiChatRun,
  InsertableAiChatRun,
} from '@docmost/db/types/entity.types';

// Statuses that count as "the run is still live" (an autonomous and a user run
// must never both be live on one chat — enforced by the partial unique index and
// checked here for friendly 409s before the insert races the constraint).
export const ACTIVE_RUN_STATUSES = ['pending', 'running'] as const;

// Crash-recovery sweep recency threshold (mirrors AiChatMessageRepo.sweepStreaming,
// #183): when a staleness window is supplied, a 'running'/'pending' run is only
// swept to 'aborted' once it has been UNTOUCHED for this long, so a sibling
// replica's boot-sweep can never abort a run another replica is actively
// executing. The runner bumps `updatedAt` on every step, so a live run never
// matches. PHASE 1 is single-process and the boot sweep passes NO window (every
// dangling run is settled unconditionally — see sweepRunning / F1). This constant
// is the window to reintroduce for the phase-2 multi-instance timer sweep.
export const SWEEP_RUN_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Repository for `ai_chat_runs` (#184 phase 1): the agent run as a first-class,
 * server-side lifecycle object detached from the HTTP request. The run row is the
 * point a client subscribes/reconnects to (by `id` or by chat); the assistant
 * message it links to (`assistantMessageId`) is the #183 projection of its output.
 */
@Injectable()
export class AiChatRunRepo {
  private readonly logger = new Logger(AiChatRunRepo.name);

  private baseFields: Array<keyof AiChatRun> = [
    'id',
    'chatId',
    'workspaceId',
    'createdBy',
    'assistantMessageId',
    'trigger',
    'status',
    'error',
    'stepCount',
    'stopRequestedAt',
    'startedAt',
    'finishedAt',
    'createdAt',
    'updatedAt',
  ];

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insert(
    insertable: InsertableAiChatRun,
    trx?: KyselyTransaction,
  ): Promise<AiChatRun> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiChatRuns')
      .values(insertable)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async findById(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AiChatRun | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('aiChatRuns')
      .select(this.baseFields)
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  /** The currently-active (pending|running) run for a chat, if any. At most one
   *  exists thanks to the partial unique index. */
  async findActiveByChat(
    chatId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AiChatRun | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('aiChatRuns')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('status', 'in', ACTIVE_RUN_STATUSES as unknown as string[])
      .executeTakeFirst();
  }

  /** The most-recent run for a chat (active or settled) — the reconnect target. */
  async findLatestByChat(
    chatId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AiChatRun | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('aiChatRuns')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Patch a run by id + workspace; always bumps `updatedAt`. Used for every
   * lifecycle transition (mark running, link the assistant message, bump
   * step_count, finalize succeeded/failed/aborted). Returns the updated row or
   * undefined when nothing matched (e.g. a foreign workspace).
   */
  async update(
    id: string,
    workspaceId: string,
    patch: Partial<{
      status: string;
      error: string | null;
      stepCount: number;
      assistantMessageId: string | null;
      stopRequestedAt: Date | null;
      startedAt: Date | null;
      finishedAt: Date | null;
    }>,
    trx?: KyselyTransaction,
  ): Promise<AiChatRun | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('aiChatRuns')
      // #491: DB-clock stamp (sql now()) so the run row shares the delta poll's
      // single now() cursor axis with the assistant message rows — a run-status
      // change (the run fact the delta carries) must never sit on a skewed app
      // clock relative to the message updatedAt cursor.
      .set({ ...(patch as Record<string, unknown>), updatedAt: sql`now()` })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * #487: CONDITIONAL terminal finalize — flip a run to a terminal status and
   * stamp `finished_at` ONLY while it is still active (pending|running), mirroring
   * the assistant message's `onlyIfStreaming` guard. A double-settle (a late or
   * second writer, a supersede applying a zombie's intended, a reconcile stamp)
   * matches NOTHING once the row is terminal and is a benign no-op — so a terminal
   * status can never be clobbered by a later writer (last-writer-wins is gone).
   *
   * Returns the updated row when it WAS active (this call wrote it), else
   * undefined (the row was already terminal — another writer won). The caller
   * distinguishes the two to resolve the correct settle outcome.
   */
  async finalizeIfActive(
    id: string,
    workspaceId: string,
    patch: { status: string; error: string | null },
    trx?: KyselyTransaction,
  ): Promise<AiChatRun | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('aiChatRuns')
      .set({
        status: patch.status,
        error: patch.error,
        // #491: DB-clock stamps (finished_at + updated_at) so the terminal run
        // fact lands on the delta poll's now() cursor axis.
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('status', 'in', ACTIVE_RUN_STATUSES as unknown as string[])
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * Mark an EXPLICIT stop request on an active run (distinct from a browser
   * disconnect, which never stops a run). Stamps `stop_requested_at` ONLY while
   * the run is still active, so a late stop on an already-settled run is a no-op.
   * Returns the row when a stop was recorded, else undefined (nothing active).
   */
  async markStopRequested(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AiChatRun | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('aiChatRuns')
      // #491: DB-clock stamps (see `update`).
      .set({ stopRequestedAt: sql`now()`, updatedAt: sql`now()` })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('status', 'in', ACTIVE_RUN_STATUSES as unknown as string[])
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * Crash-recovery sweep (mirrors AiChatMessageRepo.sweepStreaming): flip every
   * run still left pending/running — a run whose process died before reaching a
   * terminal status — to 'aborted', stamping `finished_at`. Returns the number
   * swept. Workspace-wide on purpose (a crash can dangle runs in any workspace).
   *
   * F1 (DECISION C): the BOOT sweep is UNCONDITIONAL — it passes no `staleMs`, so
   * EVERY dangling run is settled regardless of how recently it was touched. On a
   * fresh single-process boot any pending|running run is definitionally hung (no
   * runner is alive to own it), so a fast restart (deploy/OOM within minutes of
   * the last step) no longer leaves a run stuck 'running' forever — which would
   * make the one-active-run gate 409 every future turn in that chat.
   *
   * The optional `staleMs` window is reintroduced ONLY for the future phase-2
   * multi-instance timer sweep (see {@link SWEEP_RUN_STALE_MS}): there a booting
   * replica must NOT abort a run another replica is actively executing, so it
   * sweeps only runs UNTOUCHED past the window. Phase 1 is single-process, so the
   * boot path supplies no window.
   */
  /**
   * #487 reconcile clause (c): active (pending|running) runs UNTOUCHED past
   * `staleMs` — candidates for "no live runner" abort. Staleness is measured from
   * `updated_at` (the LAST-PROGRESS timestamp — recordStep bumps it), NOT
   * `started_at`, so a legitimate long-running marathon (11–25 min of steady
   * progress) is never a candidate. The caller filters these against its in-memory
   * `active` / zombie maps ("no entry" is the PRIMARY gate — a live entry is never
   * aborted) before settling any of them. Bounded.
   */
  async findStaleActive(
    staleMs: number,
    limit = 200,
    trx?: KyselyTransaction,
  ): Promise<Array<{ id: string; workspaceId: string; chatId: string }>> {
    const db = dbOrTx(this.db, trx);
    const staleBefore = new Date(Date.now() - staleMs);
    return db
      .selectFrom('aiChatRuns')
      .select(['id', 'workspaceId', 'chatId'])
      .where('status', 'in', ACTIVE_RUN_STATUSES as unknown as string[])
      .where('updatedAt', '<', staleBefore)
      .limit(limit)
      .execute();
  }

  async sweepRunning(
    opts: { staleMs?: number } = {},
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .updateTable('aiChatRuns')
      .set({
        status: 'aborted',
        // #491: DB-clock stamps (see `update`). The staleness WHERE below stays on
        // the app clock — a >minutes window makes the ms-scale skew irrelevant.
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
        error: sql`coalesce(error, ${'Run interrupted by a server restart.'})`,
      })
      .where('status', 'in', ACTIVE_RUN_STATUSES as unknown as string[]);
    // Multi-instance (phase 2) only: skip runs touched within the window so a
    // sibling replica's live run is never aborted. Omitted on the phase-1 boot
    // sweep -> unconditional.
    if (typeof opts.staleMs === 'number') {
      const staleBefore = new Date(Date.now() - opts.staleMs);
      query = query.where('updatedAt', '<', staleBefore);
    }
    const rows = await query.returning('id').execute();
    return rows.length;
  }
}
