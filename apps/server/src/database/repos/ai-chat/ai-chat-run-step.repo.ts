import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { AiChatRunStep } from '@docmost/db/types/entity.types';

/**
 * Append-only per-step persistence for an assistant turn (#492). Each finished
 * agent step's UI `parts` (its text part + a `tool-*` part per call, WITH the
 * tool output) is INSERTed as its own lightweight row the moment the step ends —
 * instead of REWRITING the assistant row's growing `metadata.parts` jsonb on every
 * `onStepFinish` (a Postgres jsonb UPDATE rewrites the whole TOASTed row version
 * under MVCC, so that was O(n²) WAL/dead-tuple churn per turn).
 *
 * The full `metadata.parts` on the message row is assembled ONCE at finalize;
 * mid-run, a resuming client's seed is rebuilt from these rows in `stepIndex`
 * order (see `assembleStepParts` / the reconstruct seam in ai-chat.service.ts).
 * Every method is workspace-scoped as defense-in-depth.
 */
@Injectable()
export class AiChatRunStepRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * Append one finished step's parts. Idempotent: a retried persist of the SAME
   * (message, stepIndex) is a no-op via ON CONFLICT DO NOTHING — the per-step
   * writes are fired fire-and-forget + serialized, and a duplicate must never
   * throw into the stream or double the parts. Returns whether a NEW row landed
   * (false = the step was already persisted).
   */
  async insertStep(
    messageId: string,
    workspaceId: string,
    stepIndex: number,
    parts: unknown,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const db = dbOrTx(this.db, trx);
    const inserted = await db
      .insertInto('aiChatRunSteps')
      .values({
        messageId,
        workspaceId,
        stepIndex,
        // jsonb column: cast through never (same pattern as the message repo).
        parts: parts as never,
      })
      .onConflict((oc) => oc.columns(['messageId', 'stepIndex']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** All persisted steps for ONE assistant message, in step order. */
  async findByMessage(
    messageId: string,
    workspaceId: string,
  ): Promise<AiChatRunStep[]> {
    return this.db
      .selectFrom('aiChatRunSteps')
      .selectAll('aiChatRunSteps')
      .where('messageId', '=', messageId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('stepIndex', 'asc')
      .execute();
  }

  /**
   * All persisted steps for a SET of assistant messages, grouped by messageId
   * (each group in step order). One query for the batch — the hydration seam
   * (getMessages / delta / export) calls this only for the rows that actually
   * need reconstruction (an active new-style row whose `metadata.parts` is still
   * empty), which is usually none, so this is skipped on the common path.
   */
  async findByMessageIds(
    messageIds: string[],
    workspaceId: string,
  ): Promise<Map<string, AiChatRunStep[]>> {
    const byMessage = new Map<string, AiChatRunStep[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = await this.db
      .selectFrom('aiChatRunSteps')
      .selectAll('aiChatRunSteps')
      .where('messageId', 'in', messageIds)
      .where('workspaceId', '=', workspaceId)
      .orderBy('stepIndex', 'asc')
      .execute();
    for (const row of rows) {
      const list = byMessage.get(row.messageId);
      if (list) list.push(row);
      else byMessage.set(row.messageId, [row]);
    }
    return byMessage;
  }
}
