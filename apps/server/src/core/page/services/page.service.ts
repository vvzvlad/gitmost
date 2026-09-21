import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreatePageDto, ContentFormat } from '../dto/create-page.dto';
import { ContentOperation, UpdatePageDto } from '../dto/update-page.dto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { InsertablePage, Page, User } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  CursorPaginationResult,
  executeWithCursorPagination,
} from '@docmost/db/pagination/cursor-pagination';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { MovePageDto } from '../dto/move-page.dto';
import { shapeSidebarPagesTree } from './sidebar-pages-tree.util';
import { generateSlugId } from '../../../common/helpers';
import { getPageTitle } from '../../../common/helpers';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { v7 as uuid7 } from 'uuid';
import {
  createYdocFromJson,
  getAttachmentIds,
  getProsemirrorContent,
  isAttachmentNode,
  removeMarkTypeFromDoc,
} from '../../../common/helpers/prosemirror/utils';
import {
  htmlToJson,
  jsonToNode,
  jsonToText,
  tiptapExtensions,
} from 'src/collaboration/collaboration.util';
import { pageContentHash } from 'src/collaboration/content-hash.util';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import {
  CopyPageMapEntry,
  ICopyPageAttachment,
} from '../dto/duplicate-page.dto';
import { Node as PMNode } from '@tiptap/pm/model';
import { StorageService } from '../../../integrations/storage/storage.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { EventName } from '../../../common/events/event.contants';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import {
  INTERNAL_LINK_REGEX,
  extractPageSlugId,
} from '../../../integrations/export/utils';
import { canonicalizeFootnotes } from '@docmost/editor-ext';
import {
  markdownToProseMirror,
  normalizeAgentMarkdown,
} from '@docmost/prosemirror-markdown';
import { WatcherService } from '../../watcher/watcher.service';
import { sql } from 'kysely';
import { TransclusionService } from '../transclusion/transclusion.service';
import { remapPageEmbedSourceId } from '../transclusion/utils/transclusion-prosemirror.util';
import {
  AuthProvenanceData,
  agentSourceFields,
} from '../../../common/decorators/auth-provenance.decorator';
import { DEFAULT_TEMPORARY_NOTE_HOURS } from '../constants/temporary-note.constants';

// Hard upper bound on how deep the recursive page-tree CTEs (ancestor /
// descendant traversals) may walk. Real page trees are only a handful of levels
// deep, so this cap never truncates a legitimate result; it purely defends the
// recursive CTEs against runaway iteration if a parent/child cycle ever exists
// in the data (e.g. one slipped in before the move guard, #207 #8). Without it a
// cycle makes `withRecursive` loop forever (hang / statement timeout), and the
// move guard itself calls one of these CTEs — so a cycle would disable the very
// guard meant to prevent it. Each CTE carries a depth counter and stops here.
const MAX_PAGE_TREE_DEPTH = 10_000;

// Advisory-lock namespace (the first key of pg_advisory_xact_lock) used to
// serialize concurrent page moves within a single space so the cycle check and
// the move UPDATE stay atomic (see movePage, #207 #7). A dedicated namespace
// constant keeps these locks from colliding with any other advisory lock; the
// second key is hashtext(spaceId). Fits a signed int4 ('page' in ASCII).
const PAGE_MOVE_LOCK_NAMESPACE = 0x70616765;

@Injectable()
export class PageService {
  private readonly logger = new Logger(PageService.name);

  constructor(
    private pageRepo: PageRepo,
    private pagePermissionRepo: PagePermissionRepo,
    private attachmentRepo: AttachmentRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private attachmentQueue: Queue,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
    @InjectQueue(QueueName.GENERAL_QUEUE) private generalQueue: Queue,
    private eventEmitter: EventEmitter2,
    private collaborationGateway: CollaborationGateway,
    private readonly watcherService: WatcherService,
    private readonly transclusionService: TransclusionService,
  ) {}

  async findById(
    pageId: string,
    includeContent?: boolean,
    includeYdoc?: boolean,
    includeSpace?: boolean,
  ): Promise<Page> {
    return this.pageRepo.findById(pageId, {
      includeContent,
      includeYdoc,
      includeSpace,
    });
  }

  async create(
    userId: string,
    workspaceId: string,
    createPageDto: CreatePageDto,
    // Optional agent-edit provenance (from the signed access claim). When the
    // actor is 'agent', stamp the page's source marker so a freshly created page
    // shows it was created by the AI agent (§14 N2) — create goes through REST,
    // not collab, so the collab-token claim never reaches it.
    provenance?: AuthProvenanceData,
  ): Promise<Page> {
    let parentPageId = undefined;

    // check if parent page exists
    if (createPageDto.parentPageId) {
      const parentPage = await this.pageRepo.findById(
        createPageDto.parentPageId,
      );

      if (
        !parentPage ||
        parentPage.deletedAt ||
        parentPage.spaceId !== createPageDto.spaceId
      ) {
        throw new NotFoundException('Parent page not found');
      }

      parentPageId = parentPage.id;
    }

    // Freeze the death timer here so later changes to the workspace setting
    // never reschedule existing temporary notes. NULL => permanent page.
    let temporaryExpiresAt: Date | undefined;
    if (createPageDto.temporary) {
      const workspace = await this.db
        .selectFrom('workspaces')
        .select(['temporaryNoteHours'])
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      const hours =
        workspace?.temporaryNoteHours ?? DEFAULT_TEMPORARY_NOTE_HOURS;
      temporaryExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    }

    let content = undefined;
    let textContent = undefined;
    let ydoc = undefined;

    if (createPageDto?.content && createPageDto?.format) {
      // createPage always writes a FULL document, so canonicalize footnotes to
      // the editor's invariant before persisting (issue #228). Pure + idempotent
      // + shape-safe: a doc with no footnotes is returned unchanged.
      const prosemirrorJson = canonicalizeFootnotes(
        await this.parseProsemirrorContent(
          createPageDto.content,
          createPageDto.format,
        ),
      );

      content = prosemirrorJson;
      textContent = jsonToText(prosemirrorJson);
      ydoc = createYdocFromJson(prosemirrorJson);
    }

    const page = await this.pageRepo.insertPage({
      slugId: generateSlugId(),
      title: createPageDto.title,
      position: await this.nextPagePosition(
        createPageDto.spaceId,
        parentPageId,
      ),
      icon: createPageDto.icon,
      parentPageId: parentPageId,
      spaceId: createPageDto.spaceId,
      creatorId: userId,
      workspaceId: workspaceId,
      lastUpdatedById: userId,
      // Agent-edit provenance. The human stays the responsible author
      // (creatorId/lastUpdatedById); these only annotate the source. A normal
      // user request leaves the column default ('user').
      ...agentSourceFields(
        provenance,
        'lastUpdatedSource',
        'lastUpdatedAiChatId',
        'lastUpdatedApiKeyId',
      ),
      temporaryExpiresAt,
      content,
      textContent,
      ydoc,
    });

    this.generalQueue
      .add(QueueJob.ADD_PAGE_WATCHERS, {
        userIds: [userId],
        pageId: page.id,
        spaceId: createPageDto.spaceId,
        workspaceId,
      })
      .catch((err) =>
        this.logger.warn(`Failed to queue add-page-watchers: ${err.message}`),
      );

    return page;
  }

  async nextPagePosition(spaceId: string, parentPageId?: string) {
    let pagePosition: string;

    const lastPageQuery = this.db
      .selectFrom('pages')
      .select(['position'])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(1);

    if (parentPageId) {
      // check for children of this page
      const lastPage = await lastPageQuery
        .where('parentPageId', '=', parentPageId)
        .executeTakeFirst();

      if (!lastPage) {
        pagePosition = generateJitteredKeyBetween(null, null);
      } else {
        // if there is an existing page, we should get a position below it
        pagePosition = generateJitteredKeyBetween(lastPage.position, null);
      }
    } else {
      // for root page
      const lastPage = await lastPageQuery
        .where('parentPageId', 'is', null)
        .executeTakeFirst();

      // if no existing page, make this the first
      if (!lastPage) {
        pagePosition = generateJitteredKeyBetween(null, null); // we expect "a0"
      } else {
        // if there is an existing page, we should get a position below it
        pagePosition = generateJitteredKeyBetween(lastPage.position, null);
      }
    }

    return pagePosition;
  }

  async update(
    page: Page,
    updatePageDto: UpdatePageDto,
    user: User,
    // Optional agent-edit provenance (from the signed access claim). Stamps the
    // source marker on a REST rename/update by the agent (§6.6 REST path).
    provenance?: AuthProvenanceData,
  ): Promise<Page> {
    const contributors = new Set<string>(page.contributorIds);
    contributors.add(user.id);
    const contributorIds = Array.from(contributors);

    // Detect a real title/icon change so the WS tree listener can broadcast an
    // `updateOne` to the space (rename / icon swap) WITHOUT re-broadcasting on a
    // content-only save. Only treat a field as changed when the DTO actually
    // carries it AND its value differs from what is already stored — a no-op
    // save (same title, or a content-only update where these are undefined)
    // produces no tree snapshot, so the listener stays quiet.
    const titleChanged =
      updatePageDto.title !== undefined && updatePageDto.title !== page.title;
    const iconChanged =
      updatePageDto.icon !== undefined && updatePageDto.icon !== page.icon;

    // #647 §D — a guarded 'replace' (content + operation:'replace' + baseHash)
    // runs the server-side write-CAS FIRST, before any metadata write, so a
    // REJECTED write (409/422/503, thrown here) touches NOTHING — no bumped
    // updatedAt/contributors and no history version. On success we fall through
    // to the normal metadata/title write below (the bottom content block skips
    // the already-applied guarded body). Non-guarded writes are unchanged.
    const isGuardedReplace =
      !!updatePageDto.content &&
      updatePageDto.operation === 'replace' &&
      !!updatePageDto.format &&
      updatePageDto.baseHash !== undefined;
    if (isGuardedReplace) {
      await this.replacePageContentGuarded(
        page.id,
        updatePageDto.content!,
        updatePageDto.format!,
        updatePageDto.baseHash!,
        user,
        provenance,
      );
    }

    await this.pageRepo.updatePage(
      {
        title: updatePageDto.title,
        icon: updatePageDto.icon,
        lastUpdatedById: user.id,
        // Agent-edit provenance: annotate the source without changing the
        // responsible author. A normal user request leaves the existing source
        // value unchanged.
        ...agentSourceFields(
          provenance,
          'lastUpdatedSource',
          'lastUpdatedAiChatId',
          'lastUpdatedApiKeyId',
        ),
        updatedAt: new Date(),
        contributorIds: contributorIds,
      },
      page.id,
      undefined,
      // Enrich PAGE_UPDATED only when title/icon actually changed. The snapshot
      // values come from the server-side data being persisted (DTO when present,
      // otherwise the unchanged stored value), never relayed from the client.
      titleChanged || iconChanged
        ? {
            treeUpdate: {
              id: page.id,
              slugId: page.slugId,
              spaceId: page.spaceId,
              parentPageId: page.parentPageId ?? null,
              ...(titleChanged ? { title: updatePageDto.title } : {}),
              ...(iconChanged ? { icon: updatePageDto.icon } : {}),
            },
          }
        : undefined,
    );

    this.generalQueue
      .add(QueueJob.ADD_PAGE_WATCHERS, {
        userIds: [user.id],
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
      })
      .catch((err) =>
        this.logger.warn(`Failed to queue add-page-watchers: ${err.message}`),
      );

    if (
      !isGuardedReplace &&
      updatePageDto.content &&
      updatePageDto.operation &&
      updatePageDto.format
    ) {
      // Non-guarded write: append/prepend, or a legacy 'replace' WITHOUT baseHash
      // (back-compat, unchanged). The guarded 'replace' already ran above.
      await this.updatePageContent(
        page.id,
        updatePageDto.content,
        updatePageDto.operation,
        updatePageDto.format,
        user,
      );
    }

    return await this.pageRepo.findById(page.id, {
      includeSpace: true,
      includeContent: true,
      includeCreator: true,
      includeLastUpdatedBy: true,
      includeContributors: true,
    });
  }

  async updatePageContent(
    pageId: string,
    content: string | object,
    operation: ContentOperation,
    format: ContentFormat,
    user: User,
  ): Promise<void> {
    let prosemirrorJson = await this.parseProsemirrorContent(content, format);

    // Canonicalize footnotes ONLY for a full-document write ('replace'). For an
    // append/prepend FRAGMENT, canonicalizing is semantically wrong (it would
    // drop a definition-only fragment's list, or synthesize a duplicate empty
    // definition for a fragment reusing an existing id) — the fragment merges
    // into the live doc where the editor's footnoteSyncPlugin keeps the invariant
    // (issue #228, must-fix #1).
    if (operation === 'replace') {
      prosemirrorJson = canonicalizeFootnotes(prosemirrorJson);
    }

    const documentName = `page.${pageId}`;
    await this.collaborationGateway.handleYjsEvent(
      'updatePageContent',
      documentName,
      { operation, prosemirrorJson, user },
    );
  }

  /**
   * #647 §C/§D — guarded full replace (server-side write-CAS). Parses + footnote-
   * canonicalizes the incoming body exactly like `updatePageContent`'s 'replace',
   * then routes `replaceIfMatch` to the document owner: the base-hash compare and
   * the structural overwrite happen ATOMICALLY on the authoritative live doc.
   *
   * Fail-closed on every non-apply outcome (§R4):
   *  - hash mismatch → HTTP 409 + `currentHash` (a concurrent edit landed; the
   *    client re-reads and retries). No content written, no history version.
   *  - empty-over-non-empty (§C/B4) → HTTP 422 (would clear the page; refused).
   *  - owner unreachable / bridge timeout → HTTP 503 (retryable). We NEVER read a
   *    stale DB snapshot to satisfy the compare, so an unreachable owner can never
   *    be clobbered.
   *
   * B3 attribution: the request provenance (`actor`/`aiChatId`/`apiKeyId`) is
   * threaded into the collab connection context so the debounced store stamps the
   * write as agent-authored and preserves the api-key/ai-chat identity.
   */
  async replacePageContentGuarded(
    pageId: string,
    content: string | object,
    format: ContentFormat,
    baseHash: string,
    user: User,
    provenance?: AuthProvenanceData,
  ): Promise<{ applied: true; newHash: string }> {
    let prosemirrorJson = await this.parseProsemirrorContent(content, format);
    prosemirrorJson = canonicalizeFootnotes(prosemirrorJson);

    const documentName = `page.${pageId}`;
    let result;
    try {
      result = await this.collaborationGateway.handleYjsEvent(
        'replaceIfMatch',
        documentName,
        {
          prosemirrorJson,
          baseHash,
          user,
          actor: provenance?.actor,
          aiChatId: provenance?.aiChatId ?? null,
          apiKeyId: provenance?.apiKeyId ?? null,
        },
      );
    } catch (err) {
      // Bridge timeout / no live collaboration instance: the owner is
      // unreachable. Fail CLOSED (retryable) — do NOT fall back to a DB compare.
      this.logger.warn(
        `Guarded replace for ${pageId} could not reach the collab owner: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not reach the live document to verify baseHash; retry shortly.',
      );
    }

    if (!result.applied) {
      if (result.reason === 'empty-replace-refused') {
        throw new UnprocessableEntityException(
          'Refusing a guarded replace that would empty a non-empty page. ' +
            'Clear the page explicitly instead of overwriting it with an empty body.',
        );
      }
      // Hash mismatch → 409 with the current hash so the client can re-read.
      throw new ConflictException({
        message:
          'Page changed since it was read (baseHash mismatch). Re-read the ' +
          'page to get a fresh baseHash and retry the write.',
        currentHash: result.currentHash,
      });
    }

    return result;
  }

  /**
   * #647 §B/§E — coherent `{ content, contentHash }` for the opt-in
   * `/pages/info?includeContentHash` read path (and the base hash a future
   * guarded-replace re-checks). The hash is computed over `fromYdoc(D)`, NEVER the
   * raw `page.content` (#647 B1: `fromYdoc(toYdoc(x)) !== x`, so hashing raw
   * content would produce a permanent false 409), and the returned `content` is
   * the SAME materialization, so a caller keying a cache by this hash gets true
   * read-your-own-writes.
   *
   * When the collab doc is LOADED on some instance we take its live content via
   * the non-claiming `readLiveIfLoaded` primitive (RYOW even while the DB row is
   * debounce-stale). When it is NOT loaded we reconstruct a TRANSIENT ydoc from
   * the DB exactly as `onLoadDocument` would (page.ydoc → applyUpdate, else
   * toYdoc(page.content)) and hash that — WITHOUT force-loading the document.
   */
  async getLiveContentPair(
    pageId: string,
  ): Promise<{ content: any; contentHash: string }> {
    const documentName = `page.${pageId}`;
    const live = await this.collaborationGateway.readLiveIfLoaded(documentName);
    if (live.loaded) {
      return { content: live.content, contentHash: live.hash };
    }

    // Not loaded (or owner unreachable): reconstruct a transient ydoc from the DB
    // and hash the SAME `fromYdoc` materialization the load path would produce.
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });
    const content = this.reconstructContentFromDb(page);
    return { content, contentHash: pageContentHash(content) };
  }

  /**
   * #654 §Server — the read-your-own-writes resolution for the structural read
   * tools' opt-in `preferLive` hint. Consumes the SAME non-claiming, non-force-
   * loading `readLiveIfLoaded` primitive (#647) but, unlike getLiveContentPair,
   * returns NO hash and falls back to the raw `page.content` DB row (NOT a
   * transient ydoc reconstruction) — a stale read is acceptable here (this feeds
   * structural views, not a CAS base hash), so we keep the fallback cheap.
   *
   * Three outcomes (contract point 4 of the primitive), mapped to a metric-
   * distinguishable `fallbackReason`:
   *  - loaded            -> live content, `contentSource:'live'`.
   *  - not loaded        -> `dbContent`, `contentSource:'db'`, `not_loaded`.
   *  - owner unreachable -> `dbContent`, `contentSource:'db'`, `owner_unreachable`.
   *
   * ALWAYS fails open to the DB row — it never throws, so a hung/absent owner
   * degrades to a (possibly stale) read within the primitive's short probe
   * timeout instead of erroring or stalling the hot read path.
   */
  async resolvePreferLiveContent(
    pageId: string,
    dbContent: any,
  ): Promise<{
    content: any;
    contentSource: 'live' | 'db';
    fallbackReason?: 'not_loaded' | 'owner_unreachable';
  }> {
    const documentName = `page.${pageId}`;
    let live: Awaited<
      ReturnType<typeof this.collaborationGateway.readLiveIfLoaded>
    >;
    try {
      live = await this.collaborationGateway.readLiveIfLoaded(documentName);
    } catch {
      // Fail OPEN (the docstring's "never throws" contract): ANY error while
      // probing the owner — e.g. an unwrapped redis reject in readLiveIfLoaded's
      // non-remote pub.get branch — must degrade to the DB row, not 500 the hot
      // /pages/info read path. Fail-CLOSED in the sense that matters: we return
      // the SAME dbContent a plain read returns, never another page's content.
      return { content: dbContent, contentSource: 'db', fallbackReason: 'owner_unreachable' };
    }
    if (live.loaded) {
      return { content: live.content, contentSource: 'live' };
    }
    // Not loaded (no owner / not hydrated) vs owner present but the short probe
    // timed out / errored — different metrics, same fail-open to the DB row.
    const fallbackReason = (live as { unreachable?: boolean }).unreachable
      ? 'owner_unreachable'
      : 'not_loaded';
    return { content: dbContent, contentSource: 'db', fallbackReason };
  }

  /**
   * #647 B1 — materialize a page's ProseMirror JSON the SAME way onLoadDocument
   * hydrates it, so a hash over the result matches what the collab process holds:
   * prefer the persisted ydoc bytes, else convert `page.content`, else an empty
   * doc. Uses a throwaway Y.Doc — it never touches the live collab instance.
   */
  private reconstructContentFromDb(page: Page | null | undefined): any {
    if (page?.ydoc) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(page.ydoc as any));
      return TiptapTransformer.fromYdoc(doc, 'default');
    }
    if (page?.content) {
      const doc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );
      return TiptapTransformer.fromYdoc(doc, 'default');
    }
    return { type: 'doc', content: [] };
  }

  async getSidebarPages(
    spaceId: string,
    pagination: PaginationOptions,
    pageId?: string,
    userId?: string,
    spaceCanEdit?: boolean,
  ): Promise<CursorPaginationResult<Partial<Page> & { hasChildren: boolean }>> {
    let query = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'position',
        'parentPageId',
        'spaceId',
        'creatorId',
        'isTemplate',
        'temporaryExpiresAt',
        'deletedAt',
      ])
      .select((eb) => this.pageRepo.withHasChildren(eb))
      .where('deletedAt', 'is', null)
      .where('spaceId', '=', spaceId);

    if (pageId) {
      query = query.where('parentPageId', '=', pageId);
    } else {
      query = query.where('parentPageId', 'is', null);
    }

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        {
          expression: 'position',
          direction: 'asc',
          orderModifier: (ob) => ob.collate('C').asc(),
          cursorExpression: sql`position collate "C"`,
        },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({
        position: cursor.position,
        id: cursor.id,
      }),
    });

    if (userId && result.items.length > 0) {
      const hasRestrictions =
        await this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);

      if (!hasRestrictions) {
        result.items = result.items.map((p: any) => ({
          ...p,
          canEdit: spaceCanEdit ?? true,
        }));
      } else {
        const pageIds = result.items.map((p: any) => p.id);

        const accessiblePages =
          await this.pagePermissionRepo.filterAccessiblePageIdsWithPermissions(
            pageIds,
            userId,
          );

        const permissionMap = new Map(
          accessiblePages.map((p) => [p.id, p.canEdit]),
        );

        result.items = result.items
          .filter((p: any) => permissionMap.has(p.id))
          .map((p: any) => ({
            ...p,
            canEdit: permissionMap.get(p.id) && (spaceCanEdit ?? true),
          }));

        const pagesWithChildren = result.items.filter(
          (p: any) => p.hasChildren,
        );
        if (pagesWithChildren.length > 0) {
          const parentIds = pagesWithChildren.map((p: any) => p.id);
          const parentsWithAccessibleChildren =
            await this.pagePermissionRepo.getParentIdsWithAccessibleChildren(
              parentIds,
              userId,
            );
          const hasAccessibleChildrenSet = new Set(
            parentsWithAccessibleChildren,
          );

          result.items = result.items.map((p: any) => ({
            ...p,
            hasChildren: p.hasChildren && hasAccessibleChildrenSet.has(p.id),
          }));
        }
      }
    }

    return result;
  }

  async movePageToSpace(
    rootPage: Page,
    spaceId: string,
    userId: string,
    // Optional agent-edit provenance (from the signed access claim). Stamps the
    // source marker on the moved root page when the agent moves it (§6.6 REST).
    provenance?: AuthProvenanceData,
  ) {
    let childPageIds: string[] = [];

    const allPages = await this.pageRepo.getPageAndDescendants(rootPage.id, {
      includeContent: false,
    });

    // Filter to only accessible pages while maintaining tree integrity
    const accessiblePages = await this.filterAccessibleTreePages(
      allPages,
      rootPage.id,
      userId,
      rootPage.spaceId,
    );
    const accessibleIds = new Set(accessiblePages.map((p) => p.id));

    // Find inaccessible pages whose parent is being moved - these need to be orphaned
    const pagesToOrphan = allPages.filter(
      (p) =>
        !accessibleIds.has(p.id) &&
        p.parentPageId &&
        accessibleIds.has(p.parentPageId),
    );

    await executeTx(this.db, async (trx) => {
      // Orphan inaccessible child pages (make them root pages in original space)
      for (const page of pagesToOrphan) {
        const orphanPosition = await this.nextPagePosition(
          rootPage.spaceId,
          null,
        );
        await this.pageRepo.updatePage(
          { parentPageId: null, position: orphanPosition },
          page.id,
          trx,
        );
      }

      // Update root page
      const nextPosition = await this.nextPagePosition(spaceId);
      await this.pageRepo.updatePage(
        {
          spaceId,
          parentPageId: null,
          position: nextPosition,
          // Agent-edit provenance on the moved root page. Child pages are bulk
          // re-parented to the new space (no content change), so the marker is
          // stamped on the root the agent acted on. Normal user: no change.
          ...agentSourceFields(
            provenance,
            'lastUpdatedSource',
            'lastUpdatedAiChatId',
            'lastUpdatedApiKeyId',
          ),
        },
        rootPage.id,
        trx,
      );

      const pageIdsToMove = accessiblePages.map((p) => p.id);

      childPageIds = pageIdsToMove.filter((id) => id !== rootPage.id);

      if (pageIdsToMove.length > 1) {
        // Update sub pages (all accessible pages except root)
        await this.pageRepo.updatePages({ spaceId }, childPageIds, trx);
      }

      if (pageIdsToMove.length > 0) {
        // Clear page-level permissions - moved pages inherit destination space permissions
        // (page_permissions cascade deletes via foreign key)
        await trx
          .deleteFrom('pageAccess')
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // update spaceId in shares
        await trx
          .updateTable('shares')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update comments
        await trx
          .updateTable('comments')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update page verifications
        await trx
          .updateTable('pageVerifications')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update notifications — access follows the page after a move
        await trx
          .updateTable('notifications')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update attachments
        await this.attachmentRepo.updateAttachmentsByPageId(
          { spaceId },
          pageIdsToMove,
          trx,
        );

        // Update watchers and remove those without access to new space
        await this.watcherService.movePageWatchersToSpace(
          pageIdsToMove,
          spaceId,
          {
            trx,
          },
        );

        await this.aiQueue.add(QueueJob.PAGE_MOVED_TO_SPACE, {
          pageIds: pageIdsToMove,
          workspaceId: rootPage.workspaceId,
        });
      }
    });

    return { childPageIds };
  }

  async duplicatePage(
    rootPage: Page,
    targetSpaceId: string | undefined,
    authUser: User,
  ) {
    const spaceId = targetSpaceId || rootPage.spaceId;
    const isDuplicateInSameSpace =
      !targetSpaceId || targetSpaceId === rootPage.spaceId;

    let nextPosition: string;

    if (isDuplicateInSameSpace) {
      // For duplicate in same space, position right after the original page
      nextPosition = generateJitteredKeyBetween(rootPage.position, null);
    } else {
      // For copy to different space, position at the end
      nextPosition = await this.nextPagePosition(spaceId);
    }

    const allPages = await this.pageRepo.getPageAndDescendants(rootPage.id, {
      includeContent: true,
    });

    // Filter to only accessible pages while maintaining tree integrity
    const pages = await this.filterAccessibleTreePages(
      allPages,
      rootPage.id,
      authUser.id,
      rootPage.spaceId,
    );

    const pageMap = new Map<string, CopyPageMapEntry>();
    pages.forEach((page) => {
      pageMap.set(page.id, {
        newPageId: uuid7(),
        newSlugId: generateSlugId(),
        oldSlugId: page.slugId,
      });
    });

    const slugIdMap = new Map<string, CopyPageMapEntry>();
    for (const [, entry] of pageMap) {
      slugIdMap.set(entry.oldSlugId, entry);
    }

    // Keyed by old attachmentId. A single attachment can be referenced by more
    // than one page in the copied subtree (e.g. a block copy-pasted into a child
    // page keeps the same attachmentId). Each referencing page needs its own
    // fresh attachment id / row / blob copy, so the value is a LIST of copy
    // entries rather than a single one — otherwise the last page's entry would
    // clobber the others and their images would 404 in the copies (#206 attach-1).
    const attachmentMap = new Map<string, ICopyPageAttachment[]>();

    const insertablePages: InsertablePage[] = await Promise.all(
      pages.map(async (page) => {
        const pageContent = getProsemirrorContent(page.content);
        const pageFromMap = pageMap.get(page.id);

        const doc = jsonToNode(pageContent);
        const prosemirrorDoc = removeMarkTypeFromDoc(doc, 'comment');

        const attachmentIds = getAttachmentIds(prosemirrorDoc.toJSON());

        if (attachmentIds.length > 0) {
          attachmentIds.forEach((attachmentId: string) => {
            const newPageId = pageFromMap.newPageId;
            const newAttachmentId = uuid7();
            const existingEntries = attachmentMap.get(attachmentId) ?? [];
            existingEntries.push({
              newPageId: newPageId,
              oldPageId: page.id,
              oldAttachmentId: attachmentId,
              newAttachmentId: newAttachmentId,
            });
            attachmentMap.set(attachmentId, existingEntries);

            prosemirrorDoc.descendants((node: PMNode) => {
              if (isAttachmentNode(node.type.name)) {
                if (node.attrs.attachmentId === attachmentId) {
                  //@ts-ignore
                  node.attrs.attachmentId = newAttachmentId;

                  if (node.attrs.src) {
                    //@ts-ignore
                    node.attrs.src = node.attrs.src.replace(
                      attachmentId,
                      newAttachmentId,
                    );
                  }
                  if (node.attrs.src) {
                    //@ts-ignore
                    node.attrs.src = node.attrs.src.replace(
                      attachmentId,
                      newAttachmentId,
                    );
                  }
                }
              }
            });
          });
        }

        // Update internal page links in mention nodes
        prosemirrorDoc.descendants((node: PMNode) => {
          if (
            node.type.name === 'mention' &&
            node.attrs.entityType === 'page'
          ) {
            const referencedPageId = node.attrs.entityId;

            // Check if the referenced page is within the pages being copied
            if (referencedPageId && pageMap.has(referencedPageId)) {
              const mappedPage = pageMap.get(referencedPageId);
              //@ts-ignore
              node.attrs.entityId = mappedPage.newPageId;
              //@ts-ignore
              node.attrs.slugId = mappedPage.newSlugId;
            }
          }

          // Remap transclusion-reference source pages to their copies when
          // the source page is also being duplicated in the same operation.
          if (node.type.name === 'transclusionReference') {
            const sourcePageId = node.attrs.sourcePageId;
            if (sourcePageId && pageMap.has(sourcePageId)) {
              const mappedPage = pageMap.get(sourcePageId);
              //@ts-ignore
              node.attrs.sourcePageId = mappedPage.newPageId;
            }
          }

          // Remap whole-page embeds (pageEmbed) the same way: if the embedded
          // source page is also part of the copied set, point at its new copy;
          // otherwise leave it pointing at the original (live embed of original).
          if (node.type.name === 'pageEmbed') {
            // @ts-expect-error ProseMirror Attrs is read-only typed; intentional remap to the duplicated copy
            node.attrs.sourcePageId = remapPageEmbedSourceId(
              node.attrs.sourcePageId,
              (id) => pageMap.get(id)?.newPageId,
            );
          }

          // Update internal page links in link marks
          for (const mark of node.marks) {
            if (
              mark.type.name === 'link' &&
              mark.attrs.internal &&
              mark.attrs.href
            ) {
              const match = mark.attrs.href.match(INTERNAL_LINK_REGEX);
              if (match) {
                const slugId = extractPageSlugId(match[5]);
                if (slugId && slugIdMap.has(slugId)) {
                  const mappedPage = slugIdMap.get(slugId);
                  //@ts-ignore
                  mark.attrs.href = mark.attrs.href.replace(
                    slugId,
                    mappedPage.newSlugId,
                  );
                }
              }
            }
          }
        });

        const prosemirrorJson = prosemirrorDoc.toJSON();

        // Add "Copy of " prefix to the root page title only for duplicates in same space
        let title = page.title;
        if (isDuplicateInSameSpace && page.id === rootPage.id) {
          const originalTitle = getPageTitle(page.title);
          title = `Copy of ${originalTitle}`;
        }

        return {
          id: pageFromMap.newPageId,
          slugId: pageFromMap.newSlugId,
          title: title,
          icon: page.icon,
          content: prosemirrorJson,
          textContent: jsonToText(prosemirrorJson),
          ydoc: createYdocFromJson(prosemirrorJson),
          position: page.id === rootPage.id ? nextPosition : page.position,
          spaceId: spaceId,
          workspaceId: page.workspaceId,
          creatorId: authUser.id,
          lastUpdatedById: authUser.id,
          parentPageId:
            page.id === rootPage.id
              ? isDuplicateInSameSpace
                ? rootPage.parentPageId
                : null
              : page.parentPageId
                ? pageMap.get(page.parentPageId)?.newPageId
                : null,
        };
      }),
    );

    await this.db.insertInto('pages').values(insertablePages).execute();

    // Extract transclusions from every duplicated page and persist them in
    // one statement. Duplication bypasses Yjs onStoreDocument; brand-new
    // pages never have prior rows so we can skip the diff and just bulk-insert.
    try {
      await this.transclusionService.insertTransclusionsForPages(
        insertablePages.map((p) => ({
          id: p.id,
          workspaceId: p.workspaceId,
          content: p.content,
        })),
      );
    } catch (err) {
      this.logger.error(
        'Failed to insert transclusions for duplicated pages',
        err,
      );
    }

    try {
      await this.transclusionService.insertReferencesForPages(
        insertablePages.map((p) => ({
          id: p.id,
          workspaceId: p.workspaceId,
          content: p.content,
        })),
      );
    } catch (err) {
      this.logger.error(
        'Failed to insert transclusion references for duplicated pages',
        err,
      );
    }

    try {
      await this.transclusionService.insertTemplateReferencesForPages(
        insertablePages.map((p) => ({
          id: p.id,
          workspaceId: p.workspaceId,
          content: p.content,
        })),
      );
    } catch (err) {
      this.logger.error(
        'Failed to insert page template references for duplicated pages',
        err,
      );
    }

    const insertedPageIds = insertablePages.map((page) => page.id);
    // `spaceId` is the single destination space for the whole copy/duplicate
    // (every inserted page above gets `spaceId: spaceId`). It lets the WS
    // listener trigger a root refetch for the bulk subtree (no `pages` snapshot
    // here on purpose — we want the refetch fallback, not per-node addTreeNode).
    this.eventEmitter.emit(EventName.PAGE_CREATED, {
      pageIds: insertedPageIds,
      workspaceId: authUser.workspaceId,
      spaceId,
    });

    //TODO: best to handle this in a queue
    const attachmentsIds = Array.from(attachmentMap.keys());
    if (attachmentsIds.length > 0) {
      const attachments = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('id', 'in', attachmentsIds)
        .where('workspaceId', '=', rootPage.workspaceId)
        .execute();

      for (const attachment of attachments) {
        // One source attachment may need to be copied for several destination
        // pages (it is referenced by more than one page in the subtree). Copy a
        // distinct blob + row for every referencing page so each copy resolves
        // (#206 attach-1). The old per-page ownership guard is gone: when the
        // same attachmentId is shared, only one page would ever match the row's
        // pageId, silently dropping the other copies.
        const pageAttachments = attachmentMap.get(attachment.id) ?? [];
        for (const pageAttachment of pageAttachments) {
          try {
            const newAttachmentId = pageAttachment.newAttachmentId;

            const newPageId = pageAttachment.newPageId;

            const newPathFile = attachment.filePath.replace(
              attachment.id,
              newAttachmentId,
            );

            try {
              await this.storageService.copy(attachment.filePath, newPathFile);

              await this.db
                .insertInto('attachments')
                .values({
                  id: newAttachmentId,
                  type: attachment.type,
                  filePath: newPathFile,
                  fileName: attachment.fileName,
                  fileSize: attachment.fileSize,
                  mimeType: attachment.mimeType,
                  fileExt: attachment.fileExt,
                  creatorId: attachment.creatorId,
                  workspaceId: attachment.workspaceId,
                  pageId: newPageId,
                  spaceId: spaceId,
                })
                .execute();
            } catch (err) {
              this.logger.error(
                `Duplicate page: failed to copy attachment ${attachment.id}`,
                err,
              );
              // Continue with other attachments even if one fails
            }
          } catch (err) {
            this.logger.error(err);
          }
        }
      }
    }

    const newPageId = pageMap.get(rootPage.id).newPageId;
    const duplicatedPage = await this.pageRepo.findById(newPageId, {
      includeSpace: true,
    });

    const hasChildren = pages.length > 1;
    const childPageIds = insertedPageIds.filter((id) => id !== newPageId);

    return {
      ...duplicatedPage,
      hasChildren,
      childPageIds,
    };
  }

  async movePage(
    dto: MovePageDto,
    movedPage: Page,
    // Optional agent-edit provenance (from the signed access claim). Stamps the
    // source marker when the agent moves a page via REST (§6.6 REST path).
    provenance?: AuthProvenanceData,
  ) {
    // validate position value by attempting to generate a key
    try {
      generateJitteredKeyBetween(dto.position, null);
    } catch (err) {
      throw new BadRequestException('Invalid move position');
    }

    let parentPageId = null;
    if (movedPage.parentPageId === dto.parentPageId) {
      parentPageId = undefined;
    } else {
      // changing the page's parent
      if (dto.parentPageId) {
        const parentPage = await this.pageRepo.findById(dto.parentPageId);
        if (
          !parentPage ||
          parentPage.deletedAt ||
          parentPage.spaceId !== movedPage.spaceId
        ) {
          throw new NotFoundException('Parent page not found');
        }
        parentPageId = parentPage.id;
      }
    }

    // Server-side cycle guard + the move UPDATE run in ONE transaction. A page
    // may not be moved into itself or into any page within its own subtree;
    // without this an MCP/REST/agent caller (or a fast drag racing the client
    // check) could persist a cycle and broadcast it. Crucially, doing the guard
    // and the write as two separate, unlocked statements is a TOCTOU race: two
    // concurrent moves ("A under B" and "B under A") can each read the same
    // pre-write acyclic snapshot, both pass the guard, then persist
    // A.parentPageId=B AND B.parentPageId=A — a parent/child cycle (#207 #7). A
    // per-space advisory lock (held until COMMIT) serializes all moves within a
    // space: the second mover blocks until the first commits and then sees the
    // freshly written parent, so its guard rejects the cycle.
    const updateResult = await executeTx(this.db, async (trx) => {
      await sql`select pg_advisory_xact_lock(${sql.lit(
        PAGE_MOVE_LOCK_NAMESPACE,
      )}, hashtext(${movedPage.spaceId}))`.execute(trx);

      // Only relevant when re-parenting under a concrete parent; moving to root
      // (parentPageId null/undefined) can never create a cycle.
      if (dto.parentPageId) {
        if (dto.parentPageId === dto.pageId) {
          throw new BadRequestException(
            'Cannot move a page into its own subtree',
          );
        }
        // Walk the destination parent's ancestor chain (reusing the breadcrumb
        // ancestor CTE) inside the lock. If the page being moved appears among
        // those ancestors, the destination lives inside the moved page's
        // subtree -> cycle.
        const destAncestors = await this.getPageBreadCrumbs(
          dto.parentPageId,
          trx,
        );
        if (destAncestors.some((ancestor) => ancestor.id === dto.pageId)) {
          throw new BadRequestException(
            'Cannot move a page into its own subtree',
          );
        }
      }

      return this.pageRepo.updatePage(
        {
          position: dto.position,
          parentPageId: parentPageId,
          // Agent-edit provenance: annotate the source on an agent move. A
          // normal user request leaves the existing source value unchanged.
          ...agentSourceFields(
            provenance,
            'lastUpdatedSource',
            'lastUpdatedAiChatId',
            'lastUpdatedApiKeyId',
          ),
        },
        dto.pageId,
        trx,
      );
    });

    // Guard against a phantom broadcast: if the row was concurrently deleted or
    // otherwise not updated, skip the PAGE_MOVED event so we don't replay a move
    // built from the stale pre-read snapshot to every connected client.
    if (!updateResult || updateResult.numUpdatedRows === 0n) {
      return;
    }

    // The generic PAGE_UPDATED emitted by updatePage above is intentionally NOT
    // used to drive the tree `moveTreeNode` broadcast: it also fires on rename /
    // content-save and carries neither oldParentId nor the new position. Emit a
    // dedicated PAGE_MOVED so the WS listener can build a precise moveTreeNode
    // without a DB read (variant A: snapshot in the event).
    //
    // `parentPageId` is `undefined` when only the position changed (same
    // parent); resolve it back to the page's actual parent for the snapshot.
    const newParentPageId =
      parentPageId === undefined ? movedPage.parentPageId : parentPageId;

    this.eventEmitter.emit(EventName.PAGE_MOVED, {
      workspaceId: movedPage.workspaceId,
      oldParentId: movedPage.parentPageId ?? null,
      // `hasChildren` is selected by findById({ includeHasChildren: true }) in
      // the controller; it isn't on the base Page type, hence the cast.
      hasChildren:
        (movedPage as Page & { hasChildren?: boolean }).hasChildren ?? false,
      node: {
        id: movedPage.id,
        slugId: movedPage.slugId,
        title: movedPage.title,
        icon: movedPage.icon,
        position: dto.position,
        spaceId: movedPage.spaceId,
        parentPageId: newParentPageId ?? null,
      },
    });
  }

  /**
   * Walk the ancestor chain of `childPageId` up to the space root, filtered
   * ONLY by `deletedAt` (+ MAX_PAGE_TREE_DEPTH) — WITHOUT per-ancestor
   * permission filtering. Callers that expose this to a user (the
   * `/breadcrumbs` endpoint) validate `validateCanView` on the TARGET page
   * only, then return the whole chain of ancestor titles (#471).
   *
   * This is safe — NOT a title leak — because page restrictions inherit DOWN
   * the tree: to view a page the caller must hold permission on EVERY
   * restricted ancestor (`validateCanView` -> `canUserAccessPage` checks the
   * full ancestor chain — see page-access.service.ts / page-permission.repo.ts
   * `canUserEditPage`). A restricted ancestor the caller may not see would
   * therefore already hide the TARGET page itself, so every ancestor reachable
   * here is one the caller is already entitled to view (content stays gated
   * regardless — getPage/getNode re-check permissions).
   *
   * Note the guarantee is the narrow "may view a descendant => may view its
   * ancestors", NOT "space membership sees every page" — restricted subtrees do
   * hide pages from members. Per-ancestor permission filtering here was
   * considered and declined as redundant given the inheritance invariant above
   * (#471). The same chain feeds the web-UI breadcrumb bar under identical CASL
   * scope.
   */
  async getPageBreadCrumbs(childPageId: string, trx?: KyselyTransaction) {
    const ancestors = await dbOrTx(this.db, trx)
      .withRecursive('page_ancestors', (db) =>
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
            'deletedAt',
          ])
          // Depth counter: bounds the walk so a parent/child cycle in the data
          // can't make this recursive CTE loop forever (#207 #8).
          .select(sql<number>`0`.as('depth'))
          .where('id', '=', childPageId)
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
                'p.deletedAt',
              ])
              .select(sql<number>`pa.depth + 1`.as('depth'))
              .innerJoin('page_ancestors as pa', 'pa.parentPageId', 'p.id')
              .where('p.deletedAt', 'is', null)
              .where(sql<number>`pa.depth`, '<', MAX_PAGE_TREE_DEPTH),
          ),
      )
      .selectFrom('page_ancestors')
      // Explicit column list (not selectAll) so the internal `depth` counter
      // never leaks into the breadcrumb result shape.
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'position',
        'parentPageId',
        'spaceId',
        'deletedAt',
      ])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('pages as child')
              .select(sql`1`.as('one'))
              .whereRef('child.parentPageId', '=', 'page_ancestors.id')
              .where('child.deletedAt', 'is', null),
          )
          .as('hasChildren'),
      )
      .execute();

    return ancestors.reverse();
  }

  async getRecentSpacePages(
    spaceId: string,
    userId: string,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Page>> {
    const result = await this.pageRepo.getRecentPagesInSpace(
      spaceId,
      pagination,
    );

    if (result.items.length > 0) {
      const pageIds = result.items.map((p) => p.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId,
          spaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      result.items = result.items.filter((p) => accessibleSet.has(p.id));
    }

    return result;
  }

  async getRecentPages(
    userId: string,
    pagination: PaginationOptions,
    workspaceId?: string | null,
  ): Promise<CursorPaginationResult<Page>> {
    const result = await this.pageRepo.getRecentPages(userId, pagination);

    if (result.items.length > 0) {
      const pageIds = result.items.map((p) => p.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId,
          // #348 — cross-space "recent"; enable the workspace short-circuit.
          workspaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      result.items = result.items.filter((p) => accessibleSet.has(p.id));
    }

    return result;
  }

  async getCreatedByPages(
    creatorId: string,
    requestingUserId: string,
    pagination: PaginationOptions,
    spaceId?: string,
    workspaceId?: string | null,
  ): Promise<CursorPaginationResult<Page>> {
    const result = await this.pageRepo.getCreatedByPages(
      creatorId,
      requestingUserId,
      pagination,
      spaceId,
    );

    if (result.items.length > 0) {
      const pageIds = result.items.map((p) => p.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId: requestingUserId,
          spaceId,
          // #348 — enable the workspace short-circuit when not space-scoped.
          workspaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      result.items = result.items.filter((p) => accessibleSet.has(p.id));
    }

    return result;
  }

  async getDeletedSpacePages(
    spaceId: string,
    userId: string,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Page>> {
    const result = await this.pageRepo.getDeletedPagesInSpace(
      spaceId,
      pagination,
    );

    if (result.items.length > 0) {
      const pageIds = result.items.map((p) => p.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId,
          spaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      result.items = result.items.filter((p) => accessibleSet.has(p.id));
    }

    return result;
  }

  async forceDelete(pageId: string, workspaceId: string): Promise<void> {
    // Get all descendant IDs (including the page itself) using recursive CTE
    const descendants = await this.db
      .withRecursive('page_descendants', (db) =>
        db
          .selectFrom('pages')
          .select(['id'])
          // Depth counter: bounds the walk so a parent/child cycle in the data
          // can't make this recursive CTE loop forever (#207 #8).
          .select(sql<number>`0`.as('depth'))
          .where('id', '=', pageId)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select(['p.id'])
              .select(sql<number>`pd.depth + 1`.as('depth'))
              .innerJoin('page_descendants as pd', 'pd.id', 'p.parentPageId')
              .where(sql<number>`pd.depth`, '<', MAX_PAGE_TREE_DEPTH),
          ),
      )
      .selectFrom('page_descendants')
      .select(['id'])
      .execute();

    const pageIds = descendants.map((d) => d.id);

    // Queue attachment deletion for all pages with unique job IDs to prevent duplicates
    for (const id of pageIds) {
      await this.attachmentQueue.add(
        QueueJob.DELETE_PAGE_ATTACHMENTS,
        {
          pageId: id,
        },
        {
          jobId: `delete-page-attachments-${id}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      );
    }

    if (pageIds.length > 0) {
      await this.db.deleteFrom('pages').where('id', 'in', pageIds).execute();
      this.eventEmitter.emit(EventName.PAGE_DELETED, {
        pageIds: pageIds,
        workspaceId,
      });
    }
  }

  async removePage(
    pageId: string,
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.pageRepo.removePage(pageId, userId, workspaceId);
  }

  private async parseProsemirrorContent(
    content: string | object,
    format: ContentFormat,
  ): Promise<any> {
    let prosemirrorJson: any;

    switch (format) {
      case 'markdown': {
        // Canonical markdown -> ProseMirror JSON directly via
        // `@docmost/prosemirror-markdown` (issue #345) — no HTML intermediate,
        // no editor-ext markdown layer. Foreign markdown surfaces the strict
        // parser rejects (GFM `[^id]` reference footnotes) are normalized to the
        // canonical inline form first.
        //
        // #555 (review of #514): use `normalizeAgentMarkdown`, NOT
        // `normalizeForeignMarkdown`. This is the REST content-write path
        // (createPage / updatePageContent — a user or client PUTting a full body
        // or a fragment), which must be SYMMETRIC with the MCP agent-write path
        // (`markdownToProseMirrorCanonical` -> `normalizeAgentMarkdown`): a leading
        // `---…---` in a full-body write is (almost) always a `horizontalRule` the
        // serializer emitted, so stripping it as YAML front-matter would silently
        // delete the page's leading content. The front-matter strip stays a
        // FILE-import concern (`normalizeForeignMarkdown` in import.service.ts /
        // file-import-task.service.ts), where a `.md` really can open with an
        // Obsidian/Hugo header. Both normalizers still rewrite GFM `[^id]`
        // reference footnotes to the canonical inline form.
        prosemirrorJson = await markdownToProseMirror(
          normalizeAgentMarkdown(content as string),
        );
        break;
      }
      case 'html': {
        prosemirrorJson = htmlToJson(content as string);
        break;
      }
      case 'json':
      default: {
        prosemirrorJson = content;
        break;
      }
    }

    // NOTE: footnote canonicalization is intentionally NOT done here. This
    // method serves BOTH full writes (createPage / updatePageContent with
    // operation 'replace') AND fragment writes (append / prepend). Canonicalizing
    // a FRAGMENT is semantically wrong — e.g. a definition-only fragment has no
    // references, so the canonicalizer would drop its whole footnotesList (lost
    // footnotes), and a fragment reusing an existing id would synthesize an empty
    // duplicate definition. The canonicalizer therefore runs only at the
    // FULL-DOCUMENT callers (createPage, and updatePageContent for 'replace'),
    // never on a fragment (issue #228, must-fix #1).
    // (Future consolidation, architecture B: the import services persist via a
    // different path; folding all of these into one "prepare JSON for persist"
    // helper would centralize the canonicalize call — left as follow-up.)
    //
    // ENFORCEMENT RULE (#228): any NEW FULL-document persist path MUST call
    // `canonicalizeFootnotes(json)` before writing (see createPage and
    // updatePageContent 'replace'); append/prepend FRAGMENT writes MUST NOT (it
    // would drop or duplicate footnotes — that is exactly why this is per-call-site
    // rather than a single wrapper here).
    try {
      jsonToNode(prosemirrorJson);
    } catch (err) {
      throw new BadRequestException('Invalid content format');
    }

    return prosemirrorJson;
  }

  /**
   * Filters a list of pages to only those accessible to the user while maintaining tree integrity.
   * A page is included only if:
   * 1. The user has access to it
   * 2. Its parent is also included (or it's the root page)
   * This ensures that if a middle page is inaccessible, its entire subtree is excluded.
   */
  private async filterAccessibleTreePages<
    T extends { id: string; parentPageId: string | null },
  >(
    pages: T[],
    rootPageId: string | null,
    userId: string,
    spaceId?: string,
  ): Promise<T[]> {
    if (pages.length === 0) return [];

    const pageIds = pages.map((p) => p.id);
    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds,
        userId,
        spaceId,
      },
    );
    const accessibleSet = new Set(accessibleIds);

    // When no explicit root is given (whole-space tree), every page whose
    // parent is outside the returned set acts as a root (space root pages have
    // parentPageId === null). This mirrors the single-root case below.
    const pageIdSet = new Set(pageIds);
    const isRoot = (page: T): boolean => {
      if (rootPageId !== null) return page.id === rootPageId;
      return !page.parentPageId || !pageIdSet.has(page.parentPageId);
    };

    // Prune: include a page only if it's accessible AND its parent chain to root is included
    const includedIds = new Set<string>();

    // Process pages in a way that ensures parents are processed before children
    // We do this by iterating until no more pages can be added
    let changed = true;
    while (changed) {
      changed = false;
      for (const page of pages) {
        if (includedIds.has(page.id)) continue;
        if (!accessibleSet.has(page.id)) continue;

        // Root page: include if accessible
        if (isRoot(page)) {
          includedIds.add(page.id);
          changed = true;
          continue;
        }

        // Non-root: include if parent is already included
        if (page.parentPageId && includedIds.has(page.parentPageId)) {
          includedIds.add(page.id);
          changed = true;
        }
      }
    }

    return pages.filter((p) => includedIds.has(p.id));
  }

  /**
   * Whole subtree (pageId) or whole space tree (spaceId only) in a single
   * query, permission-filtered, returned as a flat list matching the sidebar
   * item shape (id, slugId, title, icon, position, parentPageId, spaceId,
   * hasChildren, canEdit) ordered by position. content is never fetched.
   *
   * Reproduces the exact two-branch permission logic of getSidebarPages():
   *  - open space (no restrictions): every returned page is visible, canEdit =
   *    spaceCanEdit, hasChildren derived from the returned set.
   *  - restricted space: full descendant set is loaded, then per-page
   *    permissions applied via filterAccessibleTreePages (restricted-but-granted
   *    pages are kept; inaccessible subtrees pruned); canEdit is per-page AND
   *    spaceCanEdit;
   *    hasChildren is derived from the FINAL (post-prune, post-filter) set, so
   *    a node never advertises children the user cannot access — the same
   *    correction getSidebarPages does via getParentIdsWithAccessibleChildren.
   */
  async getSidebarPagesTree(
    spaceId: string,
    userId: string,
    spaceCanEdit?: boolean,
    pageId?: string,
  ): Promise<
    Array<
      Pick<
        Page,
        | 'id'
        | 'slugId'
        | 'title'
        | 'icon'
        | 'position'
        | 'parentPageId'
        | 'spaceId'
      > & { hasChildren: boolean; canEdit: boolean }
    >
  > {
    const hasRestrictions =
      await this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);

    // Seed: a single page subtree, or all root pages of the space.
    // Always seed with the FULL (non-excluding) descendant set — in a restricted
    // space the per-page filtering below (filterAccessibleTreePages) does the
    // pruning, exactly like getSidebarPages. Seeding with *ExcludingRestricted
    // would wrongly drop restricted pages the user has an explicit grant for
    // (and never recurse into their children), diverging from the sidebar.
    let pages: Array<{
      id: string;
      slugId: string;
      title: string;
      icon: string;
      position: string;
      parentPageId: string | null;
      spaceId: string;
    }>;

    if (pageId) {
      pages = await this.pageRepo.getPageAndDescendants(pageId, {
        includeContent: false,
      });
    } else {
      pages = await this.pageRepo.getSpaceDescendants(spaceId, {
        includeContent: false,
      });
    }

    let permissionMap: Map<string, boolean> | undefined;

    if (hasRestrictions) {
      // Fine-grained per-page permissions on top of restricted pruning.
      pages = await this.filterAccessibleTreePages(
        pages,
        pageId ?? null,
        userId,
        spaceId,
      );

      // Per-page canEdit, same source as getSidebarPages.
      const accessiblePages =
        await this.pagePermissionRepo.filterAccessiblePageIdsWithPermissions(
          pages.map((p) => p.id),
          userId,
        );
      permissionMap = new Map(accessiblePages.map((p) => [p.id, p.canEdit]));
    }

    // Shape into sidebar items (derive hasChildren, apply per-branch canEdit,
    // order by position). Extracted as a pure helper so the load-bearing logic
    // is unit-testable directly (see sidebar-pages-tree.util.ts / its spec).
    return shapeSidebarPagesTree(pages, {
      hasRestrictions,
      spaceCanEdit,
      permissionMap,
    });
  }
}
