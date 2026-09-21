import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  InsertablePageHistory,
  Page,
  PageHistory,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { ExpressionBuilder, sql } from 'kysely';
import { DB } from '@docmost/db/types/db';
import { resolveAgentProvenance } from '../agent-provenance';
import { PageHistoryKind } from '../../../collaboration/constants';

/**
 * Role-resolution subquery for a page-history row's bound AI chat (#300). Joins
 * pageHistory.lastUpdatedAiChatId -> ai_chats.role_id -> ai_agent_roles and
 * selects the role's name + emoji. NO enabled/deletedAt filter: historical agent
 * content must keep its signature even after the role is disabled or soft-deleted
 * (same rule as AiAgentRoleRepo.findById, NOT findLiveEnabled). Exported so a
 * unit test can assert the join never filters on enabled/deletedAt.
 */
export function pageHistoryAgentRoleQuery(
  eb: ExpressionBuilder<DB, 'pageHistory'>,
) {
  return eb
    .selectFrom('aiChats')
    .innerJoin('aiAgentRoles', 'aiAgentRoles.id', 'aiChats.roleId')
    .select(['aiAgentRoles.name', 'aiAgentRoles.emoji'])
    .whereRef('aiChats.id', '=', 'pageHistory.lastUpdatedAiChatId');
}

/**
 * External-MCP key-name subquery for a page-history row (#559). Resolves
 * pageHistory.lastUpdatedApiKeyId -> api_keys.name so an edit made by an external
 * MCP agent is displayed with the human-assigned key name (the persona). NO
 * deletedAt filter — exactly mirroring the agent-role join above: the historical
 * signature must SURVIVE a key REVOKE (soft-delete). A hard-delete of the key
 * (owner/workspace gone → api_keys cascades) nulls last_updated_api_key_id via the
 * FK's onDelete('set null'), so the row then resolves to the fallback name.
 * Exported so a unit test can assert the join never filters on deletedAt.
 */
export function pageHistoryApiKeyNameQuery(
  eb: ExpressionBuilder<DB, 'pageHistory'>,
) {
  return eb
    .selectFrom('apiKeys')
    .select(['apiKeys.name'])
    .whereRef('apiKeys.id', '=', 'pageHistory.lastUpdatedApiKeyId');
}

@Injectable()
export class PageHistoryRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private baseFields: Array<keyof PageHistory> = [
    'id',
    'pageId',
    'slugId',
    'title',
    'icon',
    'coverPhoto',
    'lastUpdatedById',
    'lastUpdatedSource',
    'lastUpdatedAiChatId',
    'lastUpdatedApiKeyId',
    // #370 — intentionality tier ('manual' | 'agent' | 'idle' | 'boundary');
    // null on legacy rows (= autosave). Selected so callers can read/promote it.
    'kind',
    'contributorIds',
    'spaceId',
    'workspaceId',
    'createdAt',
  ];

  async findById(
    pageHistoryId: string,
    opts?: {
      includeContent?: boolean;
      trx?: KyselyTransaction;
    },
  ): Promise<PageHistory> {
    const db = dbOrTx(this.db, opts?.trx);

    return await db
      .selectFrom('pageHistory')
      .select(this.baseFields)
      .$if(opts?.includeContent, (qb) => qb.select('content'))
      .select((eb) => this.withLastUpdatedBy(eb))
      .select((eb) => this.withContributors(eb))
      .where('id', '=', pageHistoryId)
      .executeTakeFirst();
  }

  async insertPageHistory(
    insertablePageHistory: InsertablePageHistory,
    trx?: KyselyTransaction,
  ): Promise<PageHistory> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('pageHistory')
      .values(insertablePageHistory)
      .returningAll()
      .executeTakeFirst();
  }

  async saveHistory(
    page: Page,
    opts?: {
      contributorIds?: string[];
      // #370 — intentionality tier for this snapshot. Omitted → null (legacy
      // autosave semantics). Callers derive it server-side, never from a client.
      kind?: PageHistoryKind;
      trx?: KyselyTransaction;
    },
  ): Promise<PageHistory> {
    return await this.insertPageHistory(
      {
        pageId: page.id,
        slugId: page.slugId,
        title: page.title,
        content: page.content,
        icon: page.icon,
        coverPhoto: page.coverPhoto,
        lastUpdatedById: page.lastUpdatedById ?? page.creatorId,
        // Copy the provenance marker off the page row, as for lastUpdatedById.
        lastUpdatedSource: page.lastUpdatedSource,
        lastUpdatedAiChatId: page.lastUpdatedAiChatId,
        // #559 — copy the external-MCP api_key id so the snapshot keeps the
        // "External MCP" persona (mirrors lastUpdatedAiChatId above).
        lastUpdatedApiKeyId: page.lastUpdatedApiKeyId,
        kind: opts?.kind ?? null,
        contributorIds: opts?.contributorIds,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
      },
      opts?.trx,
    );
  }

  /**
   * #370 — promote an existing snapshot's intentionality tier in place. Used by
   * the manual-save "promote-not-dup" path: when the latest history row already
   * holds the exact content being versioned, we upgrade its `kind` instead of
   * duplicating a heavy content row.
   */
  async updateHistoryKind(
    pageHistoryId: string,
    kind: PageHistoryKind,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('pageHistory')
      .set({ kind })
      .where('id', '=', pageHistoryId)
      .execute();
  }

  async findPageHistoryByPageId(pageId: string, pagination: PaginationOptions) {
    const query = this.db
      .selectFrom('pageHistory')
      .select(this.baseFields)
      .select((eb) => this.withLastUpdatedBy(eb))
      .select((eb) => this.withContributors(eb))
      .select((eb) => this.withAgentRole(eb))
      .select((eb) => this.withApiKeyName(eb))
      .where('pageId', '=', pageId);

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });

    return { ...result, items: result.items.map(attachPageHistoryAgent) };
  }

  /**
   * #395 — cheap projection of a page's FULL history timeline for the work-time
   * estimate: only the columns the sessionizer needs, no heavy `content`, sorted
   * oldest→newest. The secondary `id` tie-break keeps rows sharing a `createdAt`
   * (e.g. a synchronous pre-agent boundary row + the immediate agent snapshot)
   * in a deterministic order.
   */
  async findTimelineByPageId(
    pageId: string,
    trx?: KyselyTransaction,
  ): Promise<
    Array<
      Pick<
        PageHistory,
        | 'createdAt'
        | 'lastUpdatedById'
        | 'lastUpdatedSource'
        | 'lastUpdatedAiChatId'
        | 'kind'
      >
    >
  > {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('pageHistory')
      .select([
        'createdAt',
        'lastUpdatedById',
        'lastUpdatedSource',
        'lastUpdatedAiChatId',
        'kind',
      ])
      .where('pageId', '=', pageId)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  async findPageLastHistory(
    pageId: string,
    opts?: {
      includeContent?: boolean;
      trx?: KyselyTransaction;
    },
  ) {
    const db = dbOrTx(this.db, opts?.trx);

    return await db
      .selectFrom('pageHistory')
      .select(this.baseFields)
      .$if(opts?.includeContent, (qb) => qb.select('content'))
      .where('pageId', '=', pageId)
      .limit(1)
      // Secondary `id` tie-break: two snapshots for the same page can share a
      // createdAt (e.g. the synchronous pre-agent boundary row and the
      // immediate agent snapshot), so order by id to keep "last history"
      // deterministic and consistent with findPageHistoryByPageId (id desc).
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  /**
   * #370 Stage B — resolve the latest snapshot of a page at a given
   * intentionality tier. Used by the "approved" share mode to serve the last
   * manually-saved version (`kind='manual'`) to public readers instead of the
   * live draft. Modeled on `findPageLastHistory` with an added `kind` filter and
   * the same deterministic `(createdAt desc, id desc)` tie-break, so two rows
   * sharing a createdAt still resolve to a single stable "latest".
   */
  async findLatestByPageIdAndKind(
    pageId: string,
    kind: PageHistoryKind,
    opts?: {
      includeContent?: boolean;
      trx?: KyselyTransaction;
    },
  ) {
    const db = dbOrTx(this.db, opts?.trx);

    return await db
      .selectFrom('pageHistory')
      .select(this.baseFields)
      .$if(opts?.includeContent, (qb) => qb.select('content'))
      .where('pageId', '=', pageId)
      .where('kind', '=', kind)
      .limit(1)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  withLastUpdatedBy(eb: ExpressionBuilder<DB, 'pageHistory'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'pageHistory.lastUpdatedById'),
    ).as('lastUpdatedBy');
  }

  /** Select the row's resolved chat role (name + emoji) as `agentRole`, or null
   *  when there is no internal chat / the chat has no role (#300). */
  withAgentRole(eb: ExpressionBuilder<DB, 'pageHistory'>) {
    return jsonObjectFrom(pageHistoryAgentRoleQuery(eb)).as('agentRole');
  }

  /** #559 — select the external-MCP key's name (name-only object, or null when
   *  the row has no api_key / the key was hard-deleted) as `apiKey`. */
  withApiKeyName(eb: ExpressionBuilder<DB, 'pageHistory'>) {
    return jsonObjectFrom(pageHistoryApiKeyNameQuery(eb)).as('apiKey');
  }

  withContributors(eb: ExpressionBuilder<DB, 'pageHistory'>) {
    return jsonArrayFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef(
          'users.id',
          '=',
          sql`ANY(${eb.ref('pageHistory.contributorIds')})`,
        ),
    ).as('contributors');
  }
}

/**
 * Attach the normalized agent/launcher provenance (#300) to a page-history row
 * and strip the internal `agentRole` join column. The trigger is
 * `lastUpdatedSource === 'agent'`, the internal-chat discriminator is
 * `lastUpdatedAiChatId`, and the human is `lastUpdatedBy`. Non-agent rows pass
 * through unchanged (neither field added).
 */
function attachPageHistoryAgent<
  R extends {
    lastUpdatedSource?: string | null;
    lastUpdatedAiChatId?: string | null;
    lastUpdatedApiKeyId?: string | null;
    lastUpdatedBy?: { name: string; avatarUrl?: string | null } | null;
    agentRole?: { name: string; emoji?: string | null } | null;
    apiKey?: { name: string | null } | null;
  },
>(row: R) {
  // Strip the join-only `apiKey` object (its name feeds the resolver); keep the
  // raw `lastUpdatedApiKeyId` column on the row (like lastUpdatedAiChatId).
  const { agentRole, apiKey, ...rest } = row;
  const provenance = resolveAgentProvenance({
    isAgent: row.lastUpdatedSource === 'agent',
    aiChatId: row.lastUpdatedAiChatId,
    api_key_id: row.lastUpdatedApiKeyId,
    apiKeyName: apiKey?.name,
    creator: row.lastUpdatedBy,
    agentRole,
  });
  return provenance
    ? { ...rest, agent: provenance.agent, launcher: provenance.launcher }
    : rest;
}
