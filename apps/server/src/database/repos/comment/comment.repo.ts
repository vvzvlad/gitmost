import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  Comment,
  InsertableComment,
  UpdatableComment,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { ExpressionBuilder } from 'kysely';
import { DB } from '@docmost/db/types/db';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { resolveAgentProvenance } from '../agent-provenance';

/**
 * Role-resolution subquery for a comment's bound AI chat (#300). Joins
 * comments.aiChatId -> ai_chats.role_id -> ai_agent_roles and selects the role's
 * name + emoji. NO enabled/deletedAt filter: historical agent content must keep
 * its signature even after the role is later disabled or soft-deleted — the same
 * "resolve by id, ignore live/enabled" rule as AiAgentRoleRepo.findById (NOT
 * findLiveEnabled). Exported so a unit test can assert the join binds only
 * id<->roleId and never filters on enabled/deletedAt.
 */
export function commentAgentRoleQuery(eb: ExpressionBuilder<DB, 'comments'>) {
  return eb
    .selectFrom('aiChats')
    .innerJoin('aiAgentRoles', 'aiAgentRoles.id', 'aiChats.roleId')
    .select(['aiAgentRoles.name', 'aiAgentRoles.emoji'])
    .whereRef('aiChats.id', '=', 'comments.aiChatId');
}

/**
 * External-MCP key-name subquery for a comment (#559). Resolves
 * comments.createdApiKeyId -> api_keys.name so a comment authored by an external
 * MCP agent is displayed with the human-assigned key name (the persona). NO
 * deletedAt filter — mirroring the agent-role join above: the historical
 * signature must SURVIVE a key REVOKE (soft-delete). A hard-delete of the key
 * (owner/workspace gone → api_keys cascades) nulls created_api_key_id via the
 * FK's onDelete('set null'), so the comment then resolves to the fallback name.
 * Exported so a unit test can assert the join never filters on deletedAt.
 */
export function commentApiKeyNameQuery(eb: ExpressionBuilder<DB, 'comments'>) {
  return eb
    .selectFrom('apiKeys')
    .select(['apiKeys.name'])
    .whereRef('apiKeys.id', '=', 'comments.createdApiKeyId');
}

@Injectable()
export class CommentRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // todo, add workspaceId
  async findById(
    commentId: string,
    opts?: { includeCreator: boolean; includeResolvedBy: boolean },
  ): Promise<Comment> {
    const comment = await this.db
      .selectFrom('comments')
      .selectAll('comments')
      .$if(opts?.includeCreator, (qb) => qb.select(this.withCreator))
      .$if(opts?.includeResolvedBy, (qb) => qb.select(this.withResolvedBy))
      // #300: enrich the single-row read with the agent-role subquery so the
      // {agent,launcher} avatar stack is attached here too — the live websocket
      // broadcasts (commentCreated/Updated/Resolved) return a comment loaded via
      // findById, and must carry the SAME provenance as the list query
      // findPageComments. Without this a freshly created / edited / resolved
      // agent comment arrives un-enriched and the client's
      // `createdSource === 'agent' && agent` gate drops the stack until a full
      // refetch. Gated on includeCreator (mirroring findPageComments, which
      // always selects the creator): the internal-chat launcher IS the creator,
      // so the resolver needs it, and every broadcast caller passes
      // includeCreator: true. Non-includeCreator callers keep the plain shape.
      .$if(opts?.includeCreator, (qb) => qb.select(this.withAgentRole))
      // #559 — resolve the external-MCP persona name alongside the agent role,
      // on the SAME gate, so a broadcast api-key comment carries the key name.
      .$if(opts?.includeCreator, (qb) => qb.select(this.withApiKeyName))
      .where('id', '=', commentId)
      .executeTakeFirst();

    // Guard a missing row (don't destructure undefined in attachCommentAgent)
    // and leave non-enriched callers' shape untouched.
    if (!comment || !opts?.includeCreator) return comment;
    return attachCommentAgent(comment) as Comment;
  }

  async findPageComments(pageId: string, pagination: PaginationOptions) {
    const query = this.db
      .selectFrom('comments')
      .selectAll('comments')
      .select((eb) => this.withCreator(eb))
      .select((eb) => this.withResolvedBy(eb))
      .select((eb) => this.withAgentRole(eb))
      .select((eb) => this.withApiKeyName(eb))
      .where('pageId', '=', pageId);

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [{ expression: 'id', direction: 'asc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });

    return { ...result, items: result.items.map(attachCommentAgent) };
  }

  async updateComment(
    updatableComment: UpdatableComment,
    commentId: string,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('comments')
      .set(updatableComment)
      .where('id', '=', commentId)
      .execute();
  }

  async insertComment(
    insertableComment: InsertableComment,
    trx?: KyselyTransaction,
  ): Promise<Comment> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('comments')
      .values(insertableComment)
      .returningAll()
      .executeTakeFirst();
  }

  withCreator(eb: ExpressionBuilder<DB, 'comments'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'comments.creatorId'),
    ).as('creator');
  }

  /** Select the comment's resolved chat role (name + emoji) as `agentRole`, or
   *  null when the comment has no internal chat / the chat has no role (#300). */
  withAgentRole(eb: ExpressionBuilder<DB, 'comments'>) {
    return jsonObjectFrom(commentAgentRoleQuery(eb)).as('agentRole');
  }

  /** #559 — select the external-MCP key's name (name-only object, or null when
   *  the comment has no api_key / the key was hard-deleted) as `apiKey`. */
  withApiKeyName(eb: ExpressionBuilder<DB, 'comments'>) {
    return jsonObjectFrom(commentApiKeyNameQuery(eb)).as('apiKey');
  }

  withResolvedBy(eb: ExpressionBuilder<DB, 'comments'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'comments.resolvedById'),
    ).as('resolvedBy');
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.db.deleteFrom('comments').where('id', '=', commentId).execute();
  }

  /**
   * Delete an ephemeral suggestion row ONLY if it is still childless, returning
   * the number of rows removed (0 or 1). Closes the data-loss race in
   * dismiss/apply (#338 F4): the service reads `hasChildren`, then removes the
   * anchor mark (a collab round-trip of tens-to-hundreds of ms), then calls this.
   * `comments.parent_comment_id` is ON DELETE CASCADE, so a reply landing in that
   * window would be cascade-destroyed by a blind delete.
   *
   * A single anti-join `DELETE … WHERE NOT EXISTS(child)` is NOT sufficient under
   * READ COMMITTED: if a reply INSERT (holding FOR KEY SHARE on the parent, not
   * yet committed) interleaves, the DELETE's snapshot does not see the
   * uncommitted child, so `NOT EXISTS` is true and the parent qualifies; the
   * DELETE then blocks on the child's key-share lock, and when it wakes the row
   * was only LOCKED (not modified), so EvalPlanQual does NOT re-evaluate the
   * predicate → the parent is deleted and the just-committed reply cascades away.
   *
   * So we do a lock-then-recheck in ONE transaction:
   *  1. `SELECT id … FOR UPDATE` on the parent. FOR UPDATE conflicts with the
   *     FOR KEY SHARE a concurrent reply INSERT takes on its parent (FK), so a
   *     reply in the window serializes against us: it either commits before we
   *     acquire the lock, or it must wait until this tx ends.
   *  2. Re-read childlessness with a FRESH statement in the SAME tx. Under RC a
   *     new statement gets a new snapshot, so a reply that committed while we
   *     waited on the lock is now visible.
   *  3. Delete only if still childless (return 1); otherwise return 0 so the
   *     caller resolves the thread instead. The FOR UPDATE lock is held to
   *     end-of-tx, so no new reply can insert between the re-check and the delete.
   */
  async deleteCommentIfChildless(commentId: string): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const parent = await trx
        .selectFrom('comments')
        .select('id')
        .where('id', '=', commentId)
        .forUpdate()
        .executeTakeFirst();

      // Already gone (e.g. a racing delete won) → nothing to remove.
      if (!parent) return 0;

      const child = await trx
        .selectFrom('comments')
        .select('id')
        .where('parentCommentId', '=', commentId)
        .limit(1)
        .executeTakeFirst();

      // A reply exists (possibly one that just committed) → do NOT hard-delete;
      // the cascade would destroy it. Caller falls back to resolving the thread.
      if (child) return 0;

      await trx.deleteFrom('comments').where('id', '=', commentId).execute();
      return 1;
    });
  }

  async hasChildren(commentId: string): Promise<boolean> {
    const result = await this.db
      .selectFrom('comments')
      .select((eb) => eb.fn.count('id').as('count'))
      .where('parentCommentId', '=', commentId)
      .executeTakeFirst();

    return Number(result?.count) > 0;
  }

  async hasChildrenFromOtherUsers(
    commentId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.db
      .selectFrom('comments')
      .select((eb) => eb.fn.count('id').as('count'))
      .where('parentCommentId', '=', commentId)
      .where('creatorId', '!=', userId)
      .executeTakeFirst();

    return Number(result?.count) > 0;
  }
}

/**
 * Attach the normalized agent/launcher provenance (#300) to a comment row and
 * strip the internal `agentRole` join column. Non-agent rows pass through
 * unchanged (neither field added — the client keeps the plain human avatar). The
 * human author (`creator`) is the launcher for an internal chat, or the agent
 * itself for external MCP; the resolver encodes both cases.
 */
function attachCommentAgent<
  R extends {
    createdSource?: string | null;
    aiChatId?: string | null;
    createdApiKeyId?: string | null;
    creator?: { name: string; avatarUrl?: string | null } | null;
    agentRole?: { name: string; emoji?: string | null } | null;
    apiKey?: { name: string | null } | null;
  },
>(row: R) {
  // Strip the join-only `apiKey` object (its name feeds the resolver); keep the
  // raw `createdApiKeyId` column on the row (like aiChatId).
  const { agentRole, apiKey, ...rest } = row;
  const provenance = resolveAgentProvenance({
    isAgent: row.createdSource === 'agent',
    aiChatId: row.aiChatId,
    api_key_id: row.createdApiKeyId,
    apiKeyName: apiKey?.name,
    creator: row.creator,
    agentRole,
  });
  return provenance
    ? { ...rest, agent: provenance.agent, launcher: provenance.launcher }
    : rest;
}
