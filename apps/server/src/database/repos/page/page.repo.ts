import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx, executeTx } from '../../utils';
import {
  InsertablePage,
  Page,
  UpdatablePage,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { validate as isValidUUID } from 'uuid';
import { ExpressionBuilder, sql } from 'kysely';
import { DB } from '@docmost/db/types/db';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';
import {
  TreeUpdateSnapshot,
  toTreeNodeSnapshot,
} from '../../listeners/page.listener';

/**
 * Optional extras for the PAGE_UPDATED event emitted by updatePage(s). Lets the
 * caller attach a tree snapshot for a title/icon change so the WS listener can
 * broadcast an `updateOne` without re-reading the DB.
 */
export interface UpdatePageEventOpts {
  treeUpdate?: TreeUpdateSnapshot;
}

@Injectable()
export class PageRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private spaceMemberRepo: SpaceMemberRepo,
    private eventEmitter: EventEmitter2,
  ) {}

  private baseFields: Array<keyof Page> = [
    'id',
    'slugId',
    'title',
    'icon',
    'coverPhoto',
    'position',
    'parentPageId',
    'creatorId',
    'lastUpdatedById',
    'lastUpdatedSource',
    'lastUpdatedAiChatId',
    'spaceId',
    'workspaceId',
    'isLocked',
    'isTemplate',
    'temporaryExpiresAt',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'contributorIds',
  ];

  async findById(
    pageId: string,
    opts?: {
      includeContent?: boolean;
      includeTextContent?: boolean;
      includeYdoc?: boolean;
      includeSpace?: boolean;
      includeCreator?: boolean;
      includeLastUpdatedBy?: boolean;
      includeContributors?: boolean;
      includeDeletedBy?: boolean;
      includeHasChildren?: boolean;
      withLock?: boolean;
      trx?: KyselyTransaction;
    },
  ): Promise<Page> {
    const db = dbOrTx(this.db, opts?.trx);

    let query = db
      .selectFrom('pages')
      .select(this.baseFields)
      .$if(opts?.includeContent, (qb) => qb.select('content'))
      .$if(opts?.includeYdoc, (qb) => qb.select('ydoc'))
      .$if(opts?.includeTextContent, (qb) => qb.select('textContent'))
      .$if(opts?.includeHasChildren, (qb) =>
        qb.select((eb) => this.withHasChildren(eb)),
      );

    if (opts?.includeCreator) {
      query = query.select((eb) => this.withCreator(eb));
    }

    if (opts?.includeLastUpdatedBy) {
      query = query.select((eb) => this.withLastUpdatedBy(eb));
    }

    if (opts?.includeContributors) {
      query = query.select((eb) => this.withContributors(eb));
    }

    if (opts?.includeDeletedBy) {
      query = query.select((eb) => this.withDeletedBy(eb));
    }

    if (opts?.includeSpace) {
      query = query.select((eb) => this.withSpace(eb));
    }

    if (opts?.withLock && opts?.trx) {
      query = query.forUpdate();
    }

    if (isValidUUID(pageId)) {
      query = query.where('id', '=', pageId);
    } else {
      query = query.where('slugId', '=', pageId);
    }

    return query.executeTakeFirst();
  }

  async findManyByIds(
    pageIds: string[],
    opts?: {
      trx?: KyselyTransaction;
      workspaceId?: string;
      includeContent?: boolean;
    },
  ): Promise<Page[]> {
    if (pageIds.length === 0) return [];
    const db = dbOrTx(this.db, opts?.trx);

    let query = db
      .selectFrom('pages')
      .select(this.baseFields)
      .$if(opts?.includeContent, (qb) => qb.select('content'))
      .where('id', 'in', pageIds);

    if (opts?.workspaceId) {
      query = query
        .where('workspaceId', '=', opts.workspaceId)
        .where('deletedAt', 'is', null);
    }

    return query.execute();
  }

  async updatePage(
    updatablePage: UpdatablePage,
    pageId: string,
    trx?: KyselyTransaction,
    opts?: UpdatePageEventOpts,
  ) {
    return this.updatePages(updatablePage, [pageId], trx, opts);
  }

  async updatePages(
    updatePageData: UpdatablePage,
    pageIds: string[],
    trx?: KyselyTransaction,
    opts?: UpdatePageEventOpts,
  ) {
    const result = await dbOrTx(this.db, trx)
      .updateTable('pages')
      .set({ ...updatePageData, updatedAt: new Date() })
      .where(
        pageIds.some((pageId) => !isValidUUID(pageId)) ? 'slugId' : 'id',
        'in',
        pageIds,
      )
      .executeTakeFirst();

    this.eventEmitter.emit(EventName.PAGE_UPDATED, {
      pageIds: pageIds,
      workspaceId: updatePageData.workspaceId,
      // Optional tree snapshot for the WS listener (variant A). The caller sets
      // it ONLY for a title/icon change so the listener can broadcast an
      // `updateOne` without a DB read; content-only saves omit it and the
      // listener skips them. Built from server-side data, never client-relayed.
      ...(opts?.treeUpdate ? { treeUpdate: opts.treeUpdate } : {}),
    });

    return result;
  }

  async insertPage(
    insertablePage: InsertablePage,
    trx?: KyselyTransaction,
  ): Promise<Page> {
    const db = dbOrTx(this.db, trx);
    const result = await db
      .insertInto('pages')
      .values(insertablePage)
      .returning(this.baseFields)
      .executeTakeFirst();

    // Enrich the event with a thin node snapshot (variant A) so the WS tree
    // listener can broadcast `addTreeNode` without re-reading the DB. `result`
    // already comes from `returning(this.baseFields)`, so no extra query.
    this.eventEmitter.emit(EventName.PAGE_CREATED, {
      pageIds: [result.id],
      workspaceId: result.workspaceId,
      // Built via the shared snapshot helper so the field copy (and the
      // death-timer deadline that shows the sidebar clock marker without a
      // reload) can't drift from the `addTreeNode` broadcast literal.
      pages: [toTreeNodeSnapshot(result)],
    });

    return result;
  }

  /**
   * Count non-deleted pages in a workspace. Used by the AI settings page to show
   * RAG indexing coverage ("N of M pages indexed").
   */
  async countByWorkspace(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom('pages')
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Count non-deleted pages in a workspace that have EMBEDDABLE content — i.e.
   * pages the RAG indexer can actually produce embeddings for. Used as the
   * denominator of the "Indexed N of M pages" coverage indicator so empty /
   * text-less pages (which legitimately store zero embeddings) don't keep the
   * bar below 100% forever.
   *
   * A page qualifies if it has non-empty textContent OR already has stored
   * embeddings. The second clause covers pages whose text the indexer extracted
   * from the content JSON when textContent was null, and guarantees this total is
   * always >= countIndexedPages (the indexed count can never exceed it).
   */
  async countEmbeddablePages(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom('pages as p')
      .where('p.workspaceId', '=', workspaceId)
      .where('p.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          // Has extractable body text. The regex matches any non-whitespace
          // character, mirroring the indexer's `text.trim().length === 0` check
          // (raw SQL -> use the snake_case column name).
          sql<boolean>`p.text_content ~ '[^[:space:]]'`,
          // OR already has at least one (non-deleted) embedding row.
          eb.exists(
            eb
              .selectFrom('pageEmbeddings as pe')
              .select(sql`1`.as('one'))
              .whereRef('pe.pageId', '=', 'p.id')
              .where('pe.deletedAt', 'is', null),
          ),
        ]),
      )
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * IDs of the EMBEDDABLE page set for a workspace — the exact same set that
   * `countEmbeddablePages` counts (a page qualifies if it has non-empty
   * textContent OR already has a stored embedding row). The bulk reindex
   * iterates THIS set so the live "done" counter reaches exactly
   * `countEmbeddablePages` (the steady-state denominator), instead of iterating
   * every non-deleted page (which would push the denominator above the
   * steady-state value mid-run).
   *
   * IMPORTANT: the WHERE here MUST stay in lockstep with `countEmbeddablePages`
   * — if one changes, change both, or the live total and steady-state total
   * diverge again. Dropping text-less pages is correct: `reindexPage` no-ops on
   * a page with no extractable content anyway, and a page that lost its text but
   * still has stale embeddings IS in this set (the EXISTS clause), so it is still
   * visited and its stale rows are cleared.
   */
  async getEmbeddablePageIds(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('pages as p')
      .select('p.id')
      .where('p.workspaceId', '=', workspaceId)
      .where('p.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          // Has extractable body text (mirrors countEmbeddablePages: any
          // non-whitespace char; raw SQL -> snake_case column name).
          sql<boolean>`p.text_content ~ '[^[:space:]]'`,
          // OR already has at least one (non-deleted) embedding row.
          eb.exists(
            eb
              .selectFrom('pageEmbeddings as pe')
              .select(sql`1`.as('one'))
              .whereRef('pe.pageId', '=', 'p.id')
              .where('pe.deletedAt', 'is', null),
          ),
        ]),
      )
      .execute();
    return rows.map((r) => r.id);
  }

  async deletePage(pageId: string): Promise<void> {
    let query = this.db.deleteFrom('pages');

    if (isValidUUID(pageId)) {
      query = query.where('id', '=', pageId);
    } else {
      query = query.where('slugId', '=', pageId);
    }

    await query.execute();
  }

  async removePage(
    pageId: string,
    deletedById: string,
    workspaceId: string,
  ): Promise<void> {
    const currentDate = new Date();

    // Read the root snapshot up front so PAGE_SOFT_DELETED can carry it without
    // a post-commit DB read (variant A). Only the root of the deleted subtree is
    // needed for the tree broadcast — the client `treeModel.remove` drops all
    // descendants, so we don't snapshot/broadcast every descendant.
    const rootSnapshot = await this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'position',
        'spaceId',
        'parentPageId',
      ])
      .where('id', '=', pageId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    const descendants = await this.db
      .withRecursive('page_descendants', (db) =>
        db
          .selectFrom('pages')
          .select(['id'])
          .where('id', '=', pageId)
          .where('deletedAt', 'is', null)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select(['p.id'])
              .innerJoin('page_descendants as pd', 'pd.id', 'p.parentPageId')
              .where('p.deletedAt', 'is', null),
          ),
      )
      .selectFrom('page_descendants')
      .selectAll()
      .execute();

    const pageIds = descendants.map((d) => d.id);

    if (pageIds.length > 0) {
      await executeTx(this.db, async (trx) => {
        await trx
          .updateTable('pages')
          .set({
            deletedById: deletedById,
            deletedAt: currentDate,
          })
          .where('id', 'in', pageIds)
          .where('deletedAt', 'is', null)
          .execute();

        await trx.deleteFrom('shares').where('pageId', 'in', pageIds).execute();
      });

      this.eventEmitter.emit(EventName.PAGE_SOFT_DELETED, {
        pageIds: pageIds,
        workspaceId,
        // Root-only snapshot: one `deleteTreeNode` is enough, the client removes
        // the whole subtree. Skip if the root vanished between the two reads.
        pages: rootSnapshot
          ? [
              {
                id: rootSnapshot.id,
                slugId: rootSnapshot.slugId,
                title: rootSnapshot.title,
                icon: rootSnapshot.icon,
                position: rootSnapshot.position,
                spaceId: rootSnapshot.spaceId,
                parentPageId: rootSnapshot.parentPageId,
              },
            ]
          : [],
      });
    }
  }

  async restorePage(pageId: string, workspaceId: string): Promise<void> {
    // First, check if the page being restored has a deleted parent
    const pageToRestore = await this.db
      .selectFrom('pages')
      .select(['id', 'parentPageId', 'spaceId'])
      .where('id', '=', pageId)
      .executeTakeFirst();

    if (!pageToRestore) {
      return;
    }

    // Check if the parent is also deleted
    let shouldDetachFromParent = false;
    if (pageToRestore.parentPageId) {
      const parent = await this.db
        .selectFrom('pages')
        .select(['id', 'deletedAt'])
        .where('id', '=', pageToRestore.parentPageId)
        .executeTakeFirst();

      // If parent is deleted, we should detach this page from it
      shouldDetachFromParent = parent?.deletedAt !== null;
    }

    // Find all descendants to restore
    const pages = await this.db
      .withRecursive('page_descendants', (db) =>
        db
          .selectFrom('pages')
          .select(['id'])
          .where('id', '=', pageId)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select(['p.id'])
              .innerJoin('page_descendants as pd', 'pd.id', 'p.parentPageId'),
          ),
      )
      .selectFrom('page_descendants')
      .selectAll()
      .execute();

    const pageIds = pages.map((p) => p.id);

    // Restore all pages, but only detach the root page if its parent is deleted
    await this.db
      .updateTable('pages')
      // On restore, disarm the death timer: pulling a note out of trash means
      // "keep it". Otherwise a deadline now in the past would re-trash it on the
      // next cleanup sweep.
      .set({ deletedById: null, deletedAt: null, temporaryExpiresAt: null })
      .where('id', 'in', pageIds)
      .execute();

    // If we need to detach the restored page from its deleted parent
    if (shouldDetachFromParent) {
      await this.db
        .updateTable('pages')
        .set({ parentPageId: null })
        .where('id', '=', pageId)
        .execute();
    }
    this.eventEmitter.emit(EventName.PAGE_RESTORED, {
      pageIds: pageIds,
      workspaceId: workspaceId,
      // spaceId lets the WS listener send a space-scoped refetchRootTreeNodeEvent.
      // Restore can re-attach a whole subtree, so a root refetch is simpler and
      // more robust than N pointwise addTreeNode events.
      spaceId: pageToRestore.spaceId,
    });
  }

  async getRecentPagesInSpace(spaceId: string, pagination: PaginationOptions) {
    const query = this.db
      .selectFrom('pages')
      .select(this.baseFields)
      .select((eb) => this.withSpace(eb))
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  async getRecentPages(userId: string, pagination: PaginationOptions) {
    const query = this.db
      .selectFrom('pages')
      .select(this.baseFields)
      .select((eb) => this.withSpace(eb))
      .where('spaceId', 'in', this.spaceMemberRepo.getUserSpaceIdsQuery(userId))
      .where('deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  async getCreatedByPages(creatorId: string, requestingUserId: string, pagination: PaginationOptions, spaceId?: string) {
    let query = this.db
      .selectFrom('pages')
      .select(this.baseFields)
      .select((eb) => this.withSpace(eb))
      .where('creatorId', '=', creatorId)
      .where('deletedAt', 'is', null);

    if (spaceId) {
      query = query.where('spaceId', '=', spaceId);
    } else {
      query = query.where('spaceId', 'in', this.spaceMemberRepo.getUserSpaceIdsQuery(requestingUserId));
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  async getDeletedPagesInSpace(spaceId: string, pagination: PaginationOptions) {
    const query = this.db
      .selectFrom('pages')
      .select(this.baseFields)
      .select('content')
      .select((eb) => this.withSpace(eb))
      .select((eb) => this.withDeletedBy(eb))
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is not', null)
      // Only include pages that are either root pages (no parent) or whose parent is not deleted
      // This prevents showing orphaned pages when their parent has been soft-deleted
      .where((eb) =>
        eb.or([
          eb('parentPageId', 'is', null),
          eb.not(
            eb.exists(
              eb
                .selectFrom('pages as parent')
                .select('parent.id')
                .where('parent.id', '=', eb.ref('pages.parentPageId'))
                .where('parent.deletedAt', 'is not', null),
            ),
          ),
        ]),
      );

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'deletedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        deletedAt: new Date(cursor.deletedAt),
        id: cursor.id,
      }),
    });
  }

  withSpace(eb: ExpressionBuilder<DB, 'pages'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('spaces')
        .select(['spaces.id', 'spaces.name', 'spaces.slug'])
        .whereRef('spaces.id', '=', 'pages.spaceId'),
    ).as('space');
  }

  withCreator(eb: ExpressionBuilder<DB, 'pages'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'pages.creatorId'),
    ).as('creator');
  }

  withLastUpdatedBy(eb: ExpressionBuilder<DB, 'pages'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'pages.lastUpdatedById'),
    ).as('lastUpdatedBy');
  }

  withDeletedBy(eb: ExpressionBuilder<DB, 'pages'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'pages.deletedById'),
    ).as('deletedBy');
  }

  withContributors(eb: ExpressionBuilder<DB, 'pages'>) {
    return jsonArrayFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', sql`ANY(${eb.ref('pages.contributorIds')})`),
    ).as('contributors');
  }

  withHasChildren(eb: ExpressionBuilder<DB, 'pages'>) {
    return eb
      .selectFrom('pages as child')
      .select((eb) =>
        eb
          .case()
          .when(eb.fn.countAll(), '>', 0)
          .then(true)
          .else(false)
          .end()
          .as('count'),
      )
      .whereRef('child.parentPageId', '=', 'pages.id')
      .where('child.deletedAt', 'is', null)
      .limit(1)
      .as('hasChildren');
  }

  async getPageAndDescendants(
    parentPageId: string,
    opts: { includeContent: boolean },
  ) {
    return this.db
      .withRecursive('page_hierarchy', (db) =>
        db
          .selectFrom('pages')
          .select([
            'id',
            'slugId',
            'title',
            'icon',
            'position',
            'parentPageId',
            'spaceId',
            'workspaceId',
            'createdAt',
            'updatedAt',
          ])
          .$if(opts?.includeContent, (qb) => qb.select('content'))
          .where('id', '=', parentPageId)
          .where('deletedAt', 'is', null)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select([
                'p.id',
                'p.slugId',
                'p.title',
                'p.icon',
                'p.position',
                'p.parentPageId',
                'p.spaceId',
                'p.workspaceId',
                'p.createdAt',
                'p.updatedAt',
              ])
              .$if(opts?.includeContent, (qb) => qb.select('p.content'))
              .innerJoin('page_hierarchy as ph', 'p.parentPageId', 'ph.id')
              .where('p.deletedAt', 'is', null),
          ),
      )
      .selectFrom('page_hierarchy')
      .selectAll()
      .execute();
  }

  /**
   * Get page and all descendants, excluding restricted pages and their subtrees.
   * More efficient than getPageAndDescendants + filtering because:
   * 1. Single DB query (no separate restricted IDs query)
   * 2. Stops traversing at restricted pages (doesn't fetch data to discard)
   * 3. No in-memory filtering needed
   */
  async getPageAndDescendantsExcludingRestricted(
    parentPageId: string,
    opts: { includeContent: boolean },
  ) {
    return (
      this.db
        .withRecursive('page_hierarchy', (db) =>
          db
            .selectFrom('pages')
            .leftJoin('pageAccess', 'pageAccess.pageId', 'pages.id')
            .select([
              'pages.id',
              'pages.slugId',
              'pages.title',
              'pages.icon',
              'pages.position',
              'pages.parentPageId',
              'pages.spaceId',
              'pages.workspaceId',
              sql<boolean>`page_access.id IS NOT NULL`.as('isRestricted'),
            ])
            .$if(opts?.includeContent, (qb) => qb.select('pages.content'))
            .where('pages.id', '=', parentPageId)
            .where('pages.deletedAt', 'is', null)
            .unionAll((exp) =>
              exp
                .selectFrom('pages as p')
                .innerJoin('page_hierarchy as ph', 'p.parentPageId', 'ph.id')
                .leftJoin('pageAccess', 'pageAccess.pageId', 'p.id')
                .select([
                  'p.id',
                  'p.slugId',
                  'p.title',
                  'p.icon',
                  'p.position',
                  'p.parentPageId',
                  'p.spaceId',
                  'p.workspaceId',
                  sql<boolean>`page_access.id IS NOT NULL`.as('isRestricted'),
                ])
                .$if(opts?.includeContent, (qb) => qb.select('p.content'))
                .where('p.deletedAt', 'is', null)
                // Only recurse into children of non-restricted pages
                .where('ph.isRestricted', '=', false),
            ),
        )
        .selectFrom('page_hierarchy')
        .select([
          'id',
          'slugId',
          'title',
          'icon',
          'position',
          'parentPageId',
          'spaceId',
          'workspaceId',
        ])
        .$if(opts?.includeContent, (qb) => qb.select('content'))
        // Filter out restricted pages from the result
        .where('isRestricted', '=', false)
        .execute()
    );
  }

  /**
   * Whole space tree (all root pages and their descendants) in a single
   * recursive query. Mirrors getPageAndDescendants but seeded by every root
   * page of the space (parentPageId IS NULL) instead of a single parent.
   */
  async getSpaceDescendants(
    spaceId: string,
    opts: { includeContent: boolean },
  ) {
    return this.db
      .withRecursive('page_hierarchy', (db) =>
        db
          .selectFrom('pages')
          .select([
            'id',
            'slugId',
            'title',
            'icon',
            'position',
            'parentPageId',
            'spaceId',
            'workspaceId',
            'createdAt',
            'updatedAt',
          ])
          .$if(opts?.includeContent, (qb) => qb.select('content'))
          .where('spaceId', '=', spaceId)
          .where('parentPageId', 'is', null)
          .where('deletedAt', 'is', null)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select([
                'p.id',
                'p.slugId',
                'p.title',
                'p.icon',
                'p.position',
                'p.parentPageId',
                'p.spaceId',
                'p.workspaceId',
                'p.createdAt',
                'p.updatedAt',
              ])
              .$if(opts?.includeContent, (qb) => qb.select('p.content'))
              .innerJoin('page_hierarchy as ph', 'p.parentPageId', 'ph.id')
              .where('p.deletedAt', 'is', null),
          ),
      )
      .selectFrom('page_hierarchy')
      .selectAll()
      .execute();
  }
}
