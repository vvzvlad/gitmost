import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { validate as isValidUUID } from 'uuid';
import type {
  GitSyncClient,
  GitSyncPageNodeLite,
} from '@docmost/git-sync';
import { loadGitSync } from '../git-sync.loader';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageService } from '../../../core/page/services/page.service';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import { AuthProvenanceData } from '../../../common/decorators/auth-provenance.decorator';

/**
 * The acting context the orchestrator binds the datasource to. The datasource is
 * NOT a fixed-identity singleton: it operates on behalf of a (workspaceId,
 * userId) pair the orchestrator supplies per space. `userId` is the
 * git-sync service user — it stays the responsible author (creatorId /
 * lastUpdatedById) while the `'git-sync'` actor marks provenance.
 */
export interface GitSyncBindContext {
  workspaceId: string;
  userId: string;
  /**
   * The space this cycle reconciles. Used to distinguish a genuine page deletion
   * from a cross-space MOVE: when a page leaves space A, A's vault file is removed
   * and the push phase would otherwise soft-delete the page — but the page still
   * lives in space B. `deletePage` skips the soft-delete when the page's current
   * space differs from the reconciling space. Optional for back-compat.
   */
  spaceId?: string;
}

/**
 * The git-sync provenance carried into PageService writes. PageService.create/
 * update/movePage honor this provenance and stamp `lastUpdatedSource = 'git-sync'`
 * on the page row when `provenance.actor === 'git-sync'`. Body writes (writeBody,
 * §3.3) likewise stamp 'git-sync' because the collab context's `actor: 'git-sync'`
 * flows into PersistenceExtension. So ALL git-sync structural + body writes mark
 * the row's source, which the listener's loop-guard reads to skip our own writes.
 */
const GIT_SYNC_PROVENANCE: AuthProvenanceData = {
  actor: 'git-sync',
  aiChatId: null,
};

/**
 * Native, in-process implementation of the engine's `GitSyncClient` seam
 * Reads go through repositories (PageRepo/SpaceRepo); body writes go
 * through collab `openDirectConnection` (§3.3); structural mutations
 * (create/move/delete/rename) go through PageService.
 *
 * Shape: this is an `@Injectable()` holding the repos/services. The orchestrator
 * calls `bind({ workspaceId, userId })` to obtain a `GitSyncClient` bound to that
 * acting context. The bound object is a thin closure over `this` — no per-call
 * identity plumbing leaks into the engine.
 */
@Injectable()
export class GitmostDataSourceService {
  private readonly logger = new Logger(GitmostDataSourceService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly pageService: PageService,
    private readonly collabGateway: CollaborationGateway,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Bind the datasource to an acting (workspaceId, userId) context and return a
   * `GitSyncClient` the engine can consume directly.
   */
  bind(ctx: GitSyncBindContext): GitSyncClient {
    return {
      listSpaceTree: (spaceId, rootPageId) =>
        this.listSpaceTree(ctx, spaceId, rootPageId),
      pageIdsExist: (pageIds) => this.pageIdsExist(ctx, pageIds),
      getPageJson: (pageId) => this.getPageJson(ctx, pageId),
      // The id-scoped WRITE ops are wrapped so a malformed (non-UUID) `pageId`
      // from a broken vault `gitmost_id` frontmatter cannot wedge the space's sync
      // loop (bug C9-D1) — see `skipIfMalformedId`.
      importPageMarkdown: (pageId, fullMarkdown, baseMarkdown) =>
        this.skipIfMalformedId(
          'import',
          pageId,
          ctx,
          () => this.importPageMarkdown(ctx, pageId, fullMarkdown, baseMarkdown),
          {},
        ),
      createPage: (title, content, spaceId, parentPageId) =>
        this.createPage(ctx, title, content, spaceId, parentPageId),
      deletePage: (pageId) =>
        this.skipIfMalformedId('delete', pageId, ctx, () =>
          this.deletePage(ctx, pageId),
        ),
      movePage: (pageId, parentPageId, position) =>
        this.skipIfMalformedId('move', pageId, ctx, () =>
          this.movePage(ctx, pageId, parentPageId, position),
        ),
      renamePage: (pageId, title) =>
        this.skipIfMalformedId('rename', pageId, ctx, () =>
          this.renamePage(ctx, pageId, title),
        ),
      listRecentSince: (spaceId, sinceIso, hardPageCap) =>
        this.listRecentSince(spaceId, sinceIso, hardPageCap),
      listTrash: (spaceId) => this.listTrash(spaceId),
      restorePage: (pageId) =>
        this.skipIfMalformedId('restore', pageId, ctx, () =>
          this.restorePage(ctx, pageId),
        ),
    };
  }

  /**
   * Run an id-scoped write op; if `pageId` was a malformed NON-UUID token (a
   * broken/hand-edited vault `gitmost_id`, e.g. `gitmost_id: [unclosed`), Postgres
   * rejects it at the `uuid` predicate with error code `22P02`
   * ("invalid input syntax for type uuid"). Left unhandled, the push apply records
   * that throw as a per-cycle failure that NEVER clears — refs never advance, so
   * the WHOLE space's sync loops on the same failure indefinitely (bug C9-D1).
   * Swallow exactly that error as an inert no-op so the cycle succeeds and the rest
   * of the space keeps syncing; re-throw anything else. NOTE: `pageId` is NOT the
   * only user-influenced uuid in these ops — `movePage` (and `createPage`) also
   * carry a `parentPageId`, sourced from the PARENT folder-note's `gitmost_id`
   * frontmatter. So a 22P02 caught here can originate from a malformed PARENT id,
   * not the child `pageId`; the log message is therefore op-generic and does not
   * attribute the bad id to a specific field. (createPage/movePage additionally
   * COERCE a malformed `parentPageId` to root up-front — see those methods — so
   * that variant self-heals and never reaches this catch.)
   */
  private async skipIfMalformedId<T>(
    op: string,
    pageId: string,
    ctx: GitSyncBindContext,
    run: () => Promise<T>,
    fallback?: T,
  ): Promise<T | undefined> {
    try {
      return await run();
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        this.logger.warn(
          `git-sync[${ctx.spaceId ?? '-'}] skip ${op}: malformed (non-UUID) id reached a uuid predicate; ignored (no wedge)`,
        );
        return fallback;
      }
      throw err;
    }
  }

  // --- reads (pull) ---------------------------------------------------------

  /**
   * Full page tree of a space mapped to the engine's `PageNode` shape. We read
   * the DB directly, so `complete` is ALWAYS `true` — the incomplete-fetch
   * suppression (SPEC §8) never fires natively.
   */
  private async listSpaceTree(
    ctx: GitSyncBindContext,
    spaceId: string,
    _rootPageId?: string,
  ): Promise<{ pages: GitSyncPageNodeLite[]; complete: boolean }> {
    const space = await this.spaceRepo.findById(spaceId, ctx.workspaceId);
    if (!space) {
      throw new NotFoundException(`Space ${spaceId} not found`);
    }

    const rows = await this.pageRepo.getSpaceDescendants(space.id, {
      includeContent: false,
    });

    // `getSpaceDescendants` does not select `hasChildren`; derive it from the
    // parent links present in the same result set.
    const parentIds = new Set<string>();
    for (const row of rows) {
      if (row.parentPageId) parentIds.add(row.parentPageId);
    }

    const pages: GitSyncPageNodeLite[] = rows.map((row) => ({
      id: row.id,
      slugId: row.slugId,
      title: row.title,
      parentPageId: row.parentPageId ?? null,
      hasChildren: parentIds.has(row.id),
      position: row.position,
    }));

    return { pages, complete: true };
  }

  /**
   * Existence probe for the pull-side ghost guard (D-P3-1). Return the subset of
   * `pageIds` that correspond to a REAL page ROW in this workspace — INCLUDING
   * soft-deleted (trashed) rows and pages in ANY OTHER space (no `deletedAt` /
   * `spaceId` filter), i.e. any id that has ever been a page. The engine only
   * absence-deletes a tracked vault file whose id is returned here; a GHOST id
   * (a git file whose id was never a page) has no row and is preserved.
   *
   * Malformed (non-UUID) ids are filtered out BEFORE the `id = ANY(...)`
   * predicate: an invalid uuid literal would make Postgres reject the whole
   * query (error 22P02), and a ghost id is often exactly such a hand-edited
   * token. A filtered-out id is never returned, so its file is preserved.
   */
  private async pageIdsExist(
    ctx: GitSyncBindContext,
    pageIds: string[],
  ): Promise<string[]> {
    const validIds = pageIds.filter((id) => isValidUUID(id));
    if (validIds.length === 0) return [];

    const rows = await this.db
      .selectFrom('pages')
      .select(['id'])
      .where('workspaceId', '=', ctx.workspaceId)
      .where('id', 'in', validIds)
      .execute();

    return rows.map((row) => row.id);
  }

  /**
   * One page WITH its ProseMirror body content (editor-ext schema). `updatedAt`
   * is serialized to an ISO string for the loop-guard.
   */
  private async getPageJson(
    ctx: GitSyncBindContext,
    pageId: string,
  ): Promise<{
    id: string;
    slugId: string;
    title: string;
    parentPageId: string | null;
    spaceId: string;
    updatedAt: string;
    content: unknown;
  }> {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    return {
      id: page.id,
      slugId: page.slugId,
      title: page.title,
      parentPageId: page.parentPageId ?? null,
      spaceId: page.spaceId,
      updatedAt: new Date(page.updatedAt).toISOString(),
      content: page.content,
    };
  }

  // --- writes (push) --------------------------------------------------------

  /**
   * Merge a page's body from a self-contained markdown file: parse the meta+body
   * envelope, convert the body to ProseMirror, then merge it through collab
   * (§3.3). When `baseMarkdown` (the last-synced version of the file) is given,
   * the body write is a THREE-WAY merge against the live doc so concurrent human
   * edits survive (review #5); without it, a 2-way merge. Returns the fresh
   * page's `updatedAt` for the loop-guard.
   */
  private async importPageMarkdown(
    ctx: GitSyncBindContext,
    pageId: string,
    fullMarkdown: string,
    baseMarkdown?: string | null,
  ): Promise<{ updatedAt?: string }> {
    // Idempotency guard #1 (fixes GS-EDIT-REVERT + idle re-ingest churn). The
    // reconcile can call this every poll cycle for a page whose vault file did
    // NOT actually change since the last sync (non-idempotent change-detection
    // upstream). Each such call re-imports the SAME vault body into the live
    // collab doc — a no-op at idle, but it CLOBBERS a concurrent human edit that
    // is still in the (debounced, not-yet-flushed) Yjs doc, silently reverting
    // it within one poll. When `baseMarkdown` (the last-synced version) is
    // byte-identical to the current file, there is genuinely nothing to ingest.
    // A real git-side change makes the strings differ, so legitimate
    // git->Docmost ingests still proceed.
    const currentPage = await this.pageRepo.findById(pageId, {
      includeContent: true,
    });
    // Unknown-page guard (bug N1-D1). `importPageMarkdown` is only ever called for a
    // vault file that CARRIES a `gitmost_id`, so a null page means the id is a
    // well-formed UUID that matches NO page — a stale id from a restored-from-backup
    // file, or a copied/foreign id. Left unhandled it falls through to `writeBody()`
    // on a non-existent page, which throws "Page … not found"; the push apply records
    // that as a per-cycle failure that never clears, wedging the whole space's sync
    // loop (same user-visible impact as C9-D1, but the id is a VALID uuid so the
    // 22P02 guard does not catch it). Skip it as an inert no-op so the cycle succeeds
    // and the rest of the space keeps syncing. (ADOPTING such a file as a fresh page
    // — the restore-from-backup use case — is a separate design decision: the title
    // lives in the filename, which the engine classifier holds, not this method.)
    if (currentPage == null) {
      this.logger.warn(
        `git-sync[${ctx.spaceId ?? '-'}] skip import of page ${pageId}: no page with that id (stale/foreign gitmost_id; not adopted, no wedge)`,
      );
      return {};
    }
    // Cross-space confused-deputy guard (review S2). The target `pageId` comes
    // from THIS space's vault file frontmatter, but a file in space A could carry
    // space B's page id. Without this check that file could resurrect (via
    // restorePage), overwrite the body (writeBody), or clear the content of B's
    // page — a cross-space write the reconciling space has no authority over.
    // Mirror deletePage's guard (same `ctx.spaceId` source, same fail-safe
    // direction): when the reconciling space is known and the resolved page
    // already lives in a DIFFERENT space, skip — touch nothing. A null page is
    // already handled by the N1-D1 guard above, so here `currentPage` is
    // guaranteed non-null.
    if (ctx.spaceId && currentPage.spaceId !== ctx.spaceId) {
      this.logger.log(
        `git-sync[${ctx.spaceId}] skip import of page ${pageId}: page lives in space ${currentPage.spaceId} (cross-space vault reference; page preserved)`,
      );
      return {
        updatedAt: new Date(currentPage.updatedAt).toISOString(),
      };
    }
    // Revert-of-delete undelete (review warning). If the target page is currently
    // SOFT-DELETED, this ingest is a git-revert that re-added the page's file
    // (the push classifier saw an add carrying a known pageId -> UPDATE). Writing
    // the body to a trashed page leaves it in Trash, and the next pull re-deletes
    // the file — the git revert is silently nullified. Restore the page FIRST so
    // the revert actually brings it back, then apply the body below. (restorePage
    // stamps git-sync provenance so the loop-guard skips its own echo.)
    if (currentPage.deletedAt != null) {
      await this.restorePage(ctx, pageId);
    }
    // Skip the early no-op return when we just restored (the page must still get
    // its body write below); only short-circuit for a live, unchanged page.
    if (
      currentPage.deletedAt == null &&
      baseMarkdown != null &&
      fullMarkdown === baseMarkdown
    ) {
      return {
        updatedAt: new Date(currentPage.updatedAt).toISOString(),
      };
    }

    const { parseDocmostMarkdown, markdownToProseMirror, docsCanonicallyEqual } =
      await loadGitSync();
    const { body } = parseDocmostMarkdown(fullMarkdown);
    const doc = await markdownToProseMirror(body);

    // Idempotency guard #2 (defense-in-depth). Even when the vault file text
    // differs cosmetically, the PARSED body can be SEMANTICALLY identical to the
    // page's current Docmost content — the markdown<->ProseMirror round-trip is
    // not byte-stable, so upstream change-detection mis-flags such pages as
    // changed every cycle. But the divergence is NOT just JSON key order: a fresh
    // `markdownToProseMirror(doc)` carries new/null block ids and materialized
    // schema default attrs, whereas `currentContent` (from the DB) carries the
    // real per-block uuids (to which comments are anchored) and KNOWN_DEFAULTS.
    // A key-order-only compare therefore NEVER matches a real collab page, so use
    // the package's authoritative `docsCanonicallyEqual` — the same equality the
    // converter's round-trip losslessness tests use, which strips block ids and
    // normalizes KNOWN_DEFAULTS. If the incoming body already equals current
    // content, this ingest is a no-op — skip it so a concurrent live edit is
    // never clobbered and the vault never churns. A genuine content change is not
    // canonically equal, so it proceeds.
    const currentContent =
      typeof currentPage.content === 'string'
        ? (() => {
            try {
              return JSON.parse(currentPage.content as unknown as string);
            } catch {
              return currentPage.content;
            }
          })()
        : currentPage.content;
    if (currentContent && docsCanonicallyEqual(doc, currentContent)) {
      return {
        updatedAt: new Date(currentPage.updatedAt).toISOString(),
      };
    }

    let baseDoc: unknown;
    if (baseMarkdown != null) {
      const { body: baseBody } = parseDocmostMarkdown(baseMarkdown);
      baseDoc = await markdownToProseMirror(baseBody);
    }

    await this.writeBody(pageId, doc, ctx.userId, baseDoc);

    // CAVEAT: writeBody merges through collab, whose persistence is DEBOUNCED, so
    // this `updatedAt` read can be STALE — it may reflect the row BEFORE the
    // debounced flush lands. Currently harmless: the only consumer is the deferred
    // §10 loop-guard, which is not yet wired. When that loop-guard is implemented
    // it MUST NOT trust this timestamp as a read-after-write of the body change
    // (it would misfire on the pre-flush value); it needs a post-flush read (or to
    // key off the collab flush completion) instead.
    const page = await this.pageRepo.findById(pageId);
    return {
      updatedAt: page ? new Date(page.updatedAt).toISOString() : undefined,
    };
  }

  /**
   * Create a page shell via PageService, then write its body through collab.
   * Returns the assigned id (`data.id`) + the page's `updatedAt`.
   */
  private async createPage(
    ctx: GitSyncBindContext,
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
  ): Promise<{ data: { id: string }; updatedAt?: string }> {
    // F1 self-heal (bug C9-D1, parent-id variant). `parentPageId` is a SECOND
    // user-influenced uuid: the push planner derives it from the parent
    // folder-note's `gitmost_id` frontmatter (resolveParentPageIdViaTree). A
    // broken/hand-edited non-UUID value flows into pageService.create, whose
    // findById(parentPageId) falls back to a slugId lookup (no row) and throws
    // NotFoundException — a throw that lands in the push `failures` set. The
    // wedge-gate only advances refs when failures is empty, so the WHOLE space
    // loops forever re-attempting (same failure mode as the self-id C9-D1 bug,
    // inside the same threat model). Do NOT skip the create (that would DROP the
    // page); instead COERCE a malformed parent to root (undefined) so the page is
    // created at the space root and self-heals, never wedging. Reuses the shared
    // `uuid` validator — the same check pageRepo.findById uses to tell an id from
    // a slugId — so a VALID parentPageId is left untouched.
    if (parentPageId && !isValidUUID(parentPageId)) {
      this.logger.warn(
        `git-sync[${ctx.spaceId ?? '-'}] createPage: malformed (non-UUID) parentPageId '${parentPageId}' coerced to root (self-heal; no wedge)`,
      );
      parentPageId = undefined;
    }

    const page = await this.pageService.create(
      ctx.userId,
      ctx.workspaceId,
      { spaceId, title, parentPageId },
      GIT_SYNC_PROVENANCE,
    );

    // The shell is created without body; push the markdown body through collab.
    const { parseDocmostMarkdown, markdownToProseMirror } = await loadGitSync();
    const { body } = parseDocmostMarkdown(content);
    const doc = await markdownToProseMirror(body);
    await this.writeBody(page.id, doc, ctx.userId);

    const fresh = await this.pageRepo.findById(page.id);
    return {
      data: { id: page.id },
      updatedAt: fresh ? new Date(fresh.updatedAt).toISOString() : undefined,
    };
  }

  /**
   * Soft-delete the page to Trash (reversible). NOT a force delete — `restorePage`
   * can bring it back.
   */
  private async deletePage(
    ctx: GitSyncBindContext,
    pageId: string,
  ): Promise<unknown> {
    // Cross-space MOVE guard. A push-phase delete fires when a page's file
    // disappears from THIS space's vault. That happens for a genuine deletion —
    // but ALSO when the page was moved to another space (source vault file
    // removed, page recreated in the destination vault). In the move case the
    // page still exists and must NOT be trashed: soft-deleting it here loses the
    // page from BOTH vaults and dumps it in Trash (observed data-loss on
    // move-to-space with git-sync enabled). If the page's CURRENT space differs
    // from the space we're reconciling, this is a move-out — drop only the vault
    // file (already done by the engine), never the page.
    if (ctx.spaceId) {
      const page = await this.pageRepo.findById(pageId);
      if (page && page.deletedAt == null && page.spaceId !== ctx.spaceId) {
        this.logger.log(
          `git-sync[${ctx.spaceId}] skip delete of page ${pageId}: moved to space ${page.spaceId} (vault file removed, page preserved)`,
        );
        return { id: pageId, skipped: 'moved-to-other-space' };
      }
    }
    await this.pageService.removePage(
      pageId,
      ctx.userId,
      ctx.workspaceId,
      GIT_SYNC_PROVENANCE,
    );
    return { id: pageId };
  }

  /**
   * Reparent a page. Docmost-move REQUIRES a fractional-index `position`; when the
   * engine omits it, compute a key after the destination's last sibling (plan
   * §3.2 / §14.4).
   */
  private async movePage(
    ctx: GitSyncBindContext,
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ): Promise<unknown> {
    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    // F1 self-heal (parent-id variant), mirror of createPage. `parentPageId` is a
    // second user-influenced uuid (the DESTINATION parent folder-note's
    // `gitmost_id`). A malformed value reaches `computeMovePosition`'s raw
    // `where('parentPageId','=',parentPageId)` uuid predicate (22P02 — swallowed
    // by skipIfMalformedId but MIS-attributed to the child `pageId`) when no
    // position is supplied; and when a position IS supplied it reaches
    // pageService.movePage's findById(parentPageId) -> NotFoundException, which is
    // NOT a 22P02 and so is NOT caught by skipIfMalformedId -> the space wedges.
    // Coerce a malformed parent to root (null) so the page becomes a root page
    // (self-heal) rather than wedging or being silently swallowed. Same shared
    // `uuid` validator as createPage; a valid parent is left untouched.
    if (parentPageId && !isValidUUID(parentPageId)) {
      this.logger.warn(
        `git-sync[${ctx.spaceId ?? '-'}] movePage: malformed (non-UUID) parentPageId '${parentPageId}' coerced to root (self-heal; no wedge)`,
      );
      parentPageId = null;
    }

    // GS-MOVE-ECHO guard (review #6). A drag-move in Docmost echoes back through
    // git-sync as movePage(pageId, sameParent) WITHOUT a position. Recomputing a
    // position here would append the page to the end of its sibling list,
    // clobbering the position the user just chose. If the parent is unchanged and
    // no explicit position was provided, there is nothing to reparent — skip, so
    // the user's ordering is preserved. A real reparent (parent differs) or an
    // explicit position still proceeds.
    if (position == null && parentPageId === (page.parentPageId ?? null)) {
      return { id: pageId, skipped: 'no-op-move-echo' };
    }

    const resolvedPosition =
      position ?? (await this.computeMovePosition(page.spaceId, parentPageId));

    await this.pageService.movePage(
      { pageId, parentPageId: parentPageId ?? null, position: resolvedPosition },
      page,
      GIT_SYNC_PROVENANCE,
      // Attribute the git-initiated move to the service user (lastUpdatedById),
      // matching create/delete/rename — the contract is "git-operations are
      // attributed to the service account".
      ctx.userId,
    );
    return { id: pageId };
  }

  /**
   * Compute a fractional-index position AFTER the last sibling under
   * `parentPageId` (root pages when null) in the space, ordered by `position`
   * with the "C" collation Docmost uses. Falls back to a fresh key
   * when there are no siblings.
   */
  private async computeMovePosition(
    spaceId: string,
    parentPageId: string | null,
  ): Promise<string> {
    let query = this.db
      .selectFrom('pages')
      .select(['position'])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(1);

    query = parentPageId
      ? query.where('parentPageId', '=', parentPageId)
      : query.where('parentPageId', 'is', null);

    const lastSibling = await query.executeTakeFirst();
    return generateJitteredKeyBetween(lastSibling?.position ?? null, null);
  }

  /** Change a page's title only (no body touch). */
  private async renamePage(
    ctx: GitSyncBindContext,
    pageId: string,
    title: string,
  ): Promise<unknown> {
    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }
    // Defensive de-pollution of the cosmetic ` ~<slugId>` disambiguation suffix.
    // When two sibling pages share a title, the vault layout appends ` ~<slugId>`
    // to the colliding file's stem (engine `disambiguate(name, slugId)` = exactly
    // `${name} ~${slugId}`) so two pages never map to one `.md`. That suffix is a
    // LOCAL filesystem artifact and must NEVER become the page's real Docmost
    // title. A filename-derived title can carry it back in on ingest (observed:
    // intermittent same-title collision left a page permanently titled
    // "Title ~<slugId>"). Strip it here on the RENAME path (this is where a
    // filename-derived title lands as a page's real title); other title-write
    // paths (e.g. createPage / importPageMarkdown) are separate and not covered
    // by this choke point. Strip ONLY when the trailing token equals THIS page's
    // own slugId, so a genuine user title that legitimately ends in ` ~token` is
    // never corrupted (slugId is a random nanoid; no real collision).
    const suffix = ` ~${page.slugId}`;
    const cleanTitle =
      page.slugId && title.endsWith(suffix)
        ? title.slice(0, -suffix.length)
        : title;
    // GS-TITLE-SANITIZE guard (review Critical #2). A rename in Docmost to a
    // title with filename-hostile chars (`:` `/` `"` `|`, newlines, double
    // spaces, >120 chars) is pulled to a SANITIZED file stem; the same cycle then
    // sees an R(ename) line and would call renamePage with that sanitized stem,
    // PERMANENTLY replacing the real title with its sanitized form (e.g.
    // "Project: Plan" -> "Project- Plan"). In that echo the incoming title equals
    // `sanitizeTitle(current title)`, so skip the write — the sanitized stem is a
    // local filesystem artifact, never the page's real Docmost title. A genuine
    // retitle does NOT equal the sanitized current title, so it still applies.
    const { sanitizeTitle } = await loadGitSync();
    if (
      page.title &&
      cleanTitle !== page.title &&
      sanitizeTitle(page.title) === cleanTitle
    ) {
      this.logger.log(
        `git-sync: skip rename of page ${pageId}: incoming title is the sanitized form of current title (filesystem artifact; real title preserved)`,
      );
      return { id: pageId };
    }
    // PageService.update takes a User; the git-sync service user is the
    // responsible author. Only the id is read off it for lastUpdatedById.
    // `pageId` satisfies the UpdatePageDto type; PageService.update reads the
    // page id off `page`, not the DTO. Only `title` is applied here.
    await this.pageService.update(
      page,
      { pageId, title: cleanTitle },
      { id: ctx.userId } as any,
      GIT_SYNC_PROVENANCE,
    );
    return { id: pageId };
  }

  // --- continuous (phase B+) ------------------------------------------------

  /**
   * Pages in the space updated since `sinceIso` (poll-safety reconciliation,
   * SPEC §8). `spaceId` undefined widens to all spaces; `hardPageCap` bounds the
   * result. Reads the DB directly (no cursor pagination needed here).
   */
  private async listRecentSince(
    spaceId: string | undefined,
    sinceIso: string | null,
    hardPageCap?: number,
  ): Promise<unknown[]> {
    let query = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'parentPageId',
        'spaceId',
        'updatedAt',
      ])
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc');

    if (spaceId) query = query.where('spaceId', '=', spaceId);
    if (sinceIso) query = query.where('updatedAt', '>', new Date(sinceIso));
    if (hardPageCap) query = query.limit(hardPageCap);

    const rows = await query.execute();
    return rows.map((row) => ({
      ...row,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }

  /** Soft-deleted (trashed) pages for the space (deletion detection). */
  private async listTrash(spaceId: string): Promise<unknown[]> {
    const rows = await this.db
      .selectFrom('pages')
      .select(['id', 'slugId', 'title', 'parentPageId', 'spaceId', 'deletedAt'])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is not', null)
      .orderBy('deletedAt', 'desc')
      .execute();

    return rows.map((row) => ({
      ...row,
      deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    }));
  }

  /** Restore a soft-deleted page from Trash. */
  private async restorePage(
    ctx: GitSyncBindContext,
    pageId: string,
  ): Promise<unknown> {
    // Stamp git-sync provenance so the change-listener loop-guard skips the
    // PAGE_RESTORED echo (mirrors deletePage / create / update / move).
    await this.pageRepo.restorePage(
      pageId,
      ctx.workspaceId,
      GIT_SYNC_PROVENANCE.actor,
    );
    return { id: pageId };
  }

  // --- linchpin: native body write (§3.3) -----------------------------------

  /**
   * In-process body write — no loopback websocket, no service-user token.
   *
   * Routes the write through `CollaborationGateway.writePageBody`, which applies
   * the block-level MERGE on the instance that OWNS the live Y.Doc (via the
   * custom-event channel) rather than opening a direct connection on this
   * (api/worker) instance. That distinction is load-bearing: when an editor is
   * connected to a different collab instance/process, a direct connection here
   * mutates a SEPARATE, detached doc the editor never sees — the editor's next
   * autosave then silently REVERTS the git change (data loss). Running on the
   * owning instance broadcasts the merge as a Yjs update so the editor converges
   * (see CollaborationGateway.writePageBody for the full rationale).
   *
   * The merge itself stays a block-level reconcile, not a full-body replace
   * (review #5): only changed blocks are touched, concurrently-edited blocks are
   * left untouched, and an unchanged resync is a 0-op write. With a `base` (the
   * last-synced version) it is a THREE-WAY merge so a block ONLY the human
   * changed is kept and a block ONLY git changed is taken (conflicts -> git);
   * without a base (e.g. createPage) it falls back to the 2-way merge. The
   * `{ actor: 'git-sync', user: { id: userId } }` context flows into
   * PersistenceExtension.onStoreDocument, which persists ydoc+content+textContent,
   * stamps `lastUpdatedSource = 'git-sync'`, and broadcasts `page.updated`.
   */
  private async writeBody(
    pageId: string,
    prosemirrorJson: unknown,
    userId: string,
    baseProsemirrorJson?: unknown,
  ): Promise<void> {
    const documentName = `page.${pageId}`;
    await this.collabGateway.writePageBody(documentName, {
      prosemirrorJson,
      baseProsemirrorJson,
      userId,
    });
  }
}
