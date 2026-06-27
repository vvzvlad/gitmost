import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateShareDto, ShareInfoDto, UpdateShareDto } from './dto/share.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { nanoIdGen } from '../../common/helpers';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { TokenService } from '../auth/services/token.service';
import { jsonToNode } from '../../collaboration/collaboration.util';
import {
  getAttachmentIds,
  getProsemirrorContent,
  isAttachmentNode,
  removeMarkTypeFromDoc,
} from '../../common/helpers/prosemirror/utils';
import { Node } from '@tiptap/pm/model';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { updateAttachmentAttr } from './share.util';
import { Page } from '@docmost/db/types/entity.types';
import { validate as isValidUUID } from 'uuid';
import { sql } from 'kysely';
import { TransclusionService } from '../page/transclusion/transclusion.service';
import { TransclusionLookup } from '../page/transclusion/transclusion.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import {
  isHtmlEmbedFeatureEnabled,
  stripHtmlEmbedNodes,
} from '../../common/helpers/prosemirror/html-embed.util';

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly shareRepo: ShareRepo,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly tokenService: TokenService,
    private readonly transclusionService: TransclusionService,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  /**
   * Resolve whether the htmlEmbed feature toggle is ON for a workspace.
   * Fail-closed: a missing workspace (or absent/non-true setting) => OFF, so
   * share content gets the embed stripped when we can't positively confirm the
   * feature is enabled.
   */
  private async isHtmlEmbedEnabledForWorkspace(
    workspaceId: string,
  ): Promise<boolean> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    return isHtmlEmbedFeatureEnabled(workspace?.settings);
  }

  async getShareTree(shareId: string, workspaceId: string) {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspaceId) {
      throw new NotFoundException('Share not found');
    }

    const isRestricted =
      await this.pagePermissionRepo.hasRestrictedAncestor(share.pageId);
    if (isRestricted) {
      throw new NotFoundException('Share not found');
    }

    if (share.includeSubPages) {
      const pageTree =
        await this.pageRepo.getPageAndDescendantsExcludingRestricted(
          share.pageId,
          { includeContent: false },
        );

      return { share, pageTree };
    } else {
      return { share, pageTree: [] };
    }
  }

  async createShare(opts: {
    authUserId: string;
    workspaceId: string;
    page: Page;
    createShareDto: CreateShareDto;
  }) {
    const { authUserId, workspaceId, page, createShareDto } = opts;

    try {
      const shares = await this.shareRepo.findByPageId(page.id);
      if (shares) {
        return shares;
      }

      return await this.shareRepo.insertShare({
        key: nanoIdGen().toLowerCase(),
        pageId: page.id,
        includeSubPages: createShareDto.includeSubPages ?? false,
        searchIndexing: createShareDto.searchIndexing ?? false,
        creatorId: authUserId,
        spaceId: page.spaceId,
        workspaceId,
      });
    } catch (err) {
      this.logger.error(err);
      throw new BadRequestException('Failed to share page');
    }
  }

  async updateShare(shareId: string, updateShareDto: UpdateShareDto) {
    try {
      return this.shareRepo.updateShare(
        {
          includeSubPages: updateShareDto.includeSubPages,
          searchIndexing: updateShareDto.searchIndexing,
        },
        shareId,
      );
    } catch (err) {
      this.logger.error(err);
      throw new BadRequestException('Failed to update share');
    }
  }

  /**
   * THE share access boundary in ONE place.
   *
   * Answers exactly: "does this (shareId, pageId) pair resolve to a usable,
   * non-restricted, live page WITHIN this share?" Returns the resolved
   * `{ share, page }` on success, or `null` on ANY failure (share not found /
   * wrong workspace / out-of-tree page / share-id mismatch / missing /
   * soft-deleted / restricted ancestor).
   *
   * This is the single canonical sequence that every public-share read path
   * must funnel through, so no path can skip a check (most importantly the
   * restricted-ancestor gate, which `getShareForPage` does NOT perform on its
   * own). The checks run in this fixed order:
   *   1. getShareForPage(pageId, workspaceId)   — page reachable in this ws?
   *   2. share.id === shareId                   — and it is THIS share?
   *      (pass `null`/`undefined` shareId to skip the match when the caller has
   *       no independent requested shareId — getSharedPage resolves the share
   *       FROM the page, so there is nothing to cross-check.)
   *   3. pageRepo.findById(pageId, ...)         — page row (+ content/creator)
   *   4. !page.deletedAt                        — live (defense in depth:
   *      getShareForPage already excludes deleted anchors)
   *   5. !hasRestrictedAncestor(page.id)        — not a restricted descendant
   *
   * `isSharingAllowed` is intentionally NOT part of this boundary: it is an
   * orthogonal workspace/space toggle that each call-site layers separately
   * (share.controller after getSharedPage; the assistant funnel as its own
   * gate). Folding it in here would silently change those call-sites' grading.
   */
  async resolveReadableSharePage(
    shareId: string | null | undefined,
    pageId: string,
    workspaceId: string,
    opts?: { includeCreator?: boolean },
  ): Promise<{
    share: NonNullable<Awaited<ReturnType<ShareService['getShareForPage']>>>;
    page: Page;
  } | null> {
    const share = await this.getShareForPage(pageId, workspaceId);
    if (!share) return null;

    // Only ever an equality check against the server-resolved share id; an
    // attacker-supplied shareId can never widen access. Skipped when the caller
    // passes no shareId (it resolved the share from the page itself).
    if (shareId != null && share.id !== shareId) return null;

    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeCreator: opts?.includeCreator ?? false,
    });
    if (!page || page.deletedAt) return null;

    // Restricted descendants are hidden from the public view even inside an
    // includeSubPages share; getShareForPage does NOT exclude them.
    if (await this.pagePermissionRepo.hasRestrictedAncestor(page.id)) {
      return null;
    }

    return { share, page };
  }

  async getSharedPage(dto: ShareInfoDto, workspaceId: string) {
    // Resolve via the single canonical boundary. The share is resolved FROM the
    // page (the request carries the page slug), so the boundary itself performs
    // no share-id match here.
    const resolved = await this.resolveReadableSharePage(
      null,
      dto.pageId,
      workspaceId,
      { includeCreator: true },
    );

    if (!resolved) {
      throw new NotFoundException('Shared page not found');
    }

    const { share, page } = resolved;

    // Bind content to the requested share (#218). When the caller supplies a
    // shareId/key (the `/share/:shareId/p/:slug` route now forwards it), the
    // page must be reachable THROUGH that exact share — a forged or mismatched
    // shareId must 404 instead of rendering the page off its slug alone, and it
    // must not be answerable with the page's real (canonical) share key. A
    // request with no shareId keeps the legacy slug-capability behavior (the
    // `/share/p/:slug` route + internal title look-ups); the slug nanoid stays
    // the access secret there — an inherited Docmost design we don't widen.
    // FUTURE: this ancestor-aware match could fold INTO resolveReadableSharePage
    // (so the boundary's narrow `share.id === shareId` gate isn't effectively
    // dead). Deferred — it widens the contract for the 3 other callers that pass
    // no shareId (share-alias.controller, share-alias.service, share-seo.controller);
    // the two ai-chat callers (public-share-chat.controller,
    // public-share-chat-tools.service) already pass a real shareId. Kept here as
    // a local post-check until that consolidation is worth the blast radius.
    if (dto.shareId) {
      const reachable = await this.isPageReachableThroughShare(
        dto.shareId,
        share,
        page.id,
        workspaceId,
      );
      if (!reachable) {
        throw new NotFoundException('Shared page not found');
      }
    }

    page.content = await this.updatePublicAttachments(page);

    return { page, share };
  }

  /**
   * Does `requestedShareId` (a share id OR key) legitimately grant access to
   * `pageId`? True when it names the page's own resolved share, or an ancestor
   * share with `includeSubPages` that contains the page. Any other value
   * (unknown key, wrong workspace, a sibling share that doesn't cover the page)
   * is false, so a guessed slug paired with a forged shareId can't render.
   */
  private async isPageReachableThroughShare(
    requestedShareId: string,
    resolvedShare: NonNullable<
      Awaited<ReturnType<ShareService['getShareForPage']>>
    >,
    pageId: string,
    workspaceId: string,
  ): Promise<boolean> {
    // Fast path: the request names the page's own resolved share.
    if (this.shareIdGrantsAccess(requestedShareId, resolvedShare)) {
      return true;
    }

    // Otherwise it may name an includeSubPages ANCESTOR share: the page has its
    // own closer share but is also served under the ancestor's public tree.
    const requested = await this.shareRepo.findById(requestedShareId);
    if (!requested || requested.workspaceId !== workspaceId) return false;
    if (!requested.includeSubPages) return false;

    const ancestor = await this.getShareAncestorPage(requested.pageId, pageId);
    return !!ancestor;
  }

  /**
   * Does the requested share id/key directly name `resolvedShare` — by id, or
   * by key (case-insensitive)? This is the "names the page's OWN share" half of
   * the access concept; ancestor includeSubPages shares are matched separately.
   * Intentionally narrower than `resolveReadableSharePage`'s id-only gate, which
   * keeps its own contract for the callers that pass a shareId there.
   */
  private shareIdGrantsAccess(
    requestedShareId: string,
    resolvedShare: { id: string; key?: string | null },
  ): boolean {
    return (
      requestedShareId === resolvedShare.id ||
      requestedShareId.toLowerCase() === resolvedShare.key?.toLowerCase()
    );
  }

  async getShareForPage(pageId: string, workspaceId: string) {
    // here we try to check if a page was shared directly or if it inherits the share from its closest shared ancestor
    const share = await this.db
      .withRecursive('page_hierarchy', (cte) =>
        cte
          .selectFrom('pages')
          .leftJoin('shares', 'shares.pageId', 'pages.id')
          .select([
            'pages.id',
            'pages.slugId',
            'pages.title',
            'pages.icon',
            'pages.parentPageId',
            sql`0`.as('level'),
            'shares.id as shareId',
            'shares.key as shareKey',
            'shares.includeSubPages',
            'shares.searchIndexing',
            'shares.creatorId',
            'shares.spaceId',
            'shares.workspaceId',
            'shares.createdAt',
          ])
          .where(isValidUUID(pageId) ? 'pages.id' : 'pages.slugId', '=', pageId)
          .where('pages.deletedAt', 'is', null)
          .unionAll(
            (union) =>
              union
                .selectFrom('pages as p')
                .innerJoin('page_hierarchy as ph', 'ph.parentPageId', 'p.id')
                .leftJoin('shares as s', 's.pageId', 'p.id')
                .select([
                  'p.id',
                  'p.slugId',
                  'p.title',
                  'p.icon',
                  'p.parentPageId',
                  sql`ph.level + 1`.as('level'),
                  's.id as shareId',
                  's.key as shareKey',
                  's.includeSubPages',
                  's.searchIndexing',
                  's.creatorId',
                  's.spaceId',
                  's.workspaceId',
                  's.createdAt',
                ])
                .where('p.deletedAt', 'is', null)
                .where(sql`ph.share_id`, 'is', null) // stop if share found
                .where(sql`ph.level`, '<', sql`25`), // prevent loop
          ),
      )
      .selectFrom('page_hierarchy')
      .selectAll()
      .where('shareId', 'is not', null)
      .limit(1)
      .executeTakeFirst();

    if (!share || share.workspaceId !== workspaceId) {
      return undefined;
    }

    if ((share.level as number) > 0 && !share.includeSubPages) {
      return undefined;
    }

    return {
      id: share.shareId,
      key: share.shareKey,
      includeSubPages: share.includeSubPages,
      searchIndexing: share.searchIndexing,
      pageId: share.id,
      creatorId: share.creatorId,
      spaceId: share.spaceId,
      workspaceId: share.workspaceId,
      createdAt: share.createdAt,
      level: share.level,
      sharedPage: {
        id: share.id,
        slugId: share.slugId,
        title: share.title,
        icon: share.icon,
      },
    };
  }

  async getShareAncestorPage(
    ancestorPageId: string,
    childPageId: string,
  ): Promise<any> {
    let ancestor = null;
    try {
      ancestor = await this.db
        .withRecursive('page_ancestors', (db) =>
          db
            .selectFrom('pages')
            .select([
              'id',
              'slugId',
              'title',
              'parentPageId',
              'spaceId',
              (eb) =>
                eb
                  .case()
                  .when(eb.ref('id'), '=', ancestorPageId)
                  .then(true)
                  .else(false)
                  .end()
                  .as('found'),
            ])
            .where(isValidUUID(childPageId) ? 'id' : 'slugId', '=', childPageId)
            .unionAll((exp) =>
              exp
                .selectFrom('pages as p')
                .select([
                  'p.id',
                  'p.slugId',
                  'p.title',
                  'p.parentPageId',
                  'p.spaceId',
                  (eb) =>
                    eb
                      .case()
                      .when(eb.ref('p.id'), '=', ancestorPageId)
                      .then(true)
                      .else(false)
                      .end()
                      .as('found'),
                ])
                .innerJoin('page_ancestors as pa', 'pa.parentPageId', 'p.id')
                // Continue recursing only when the target ancestor hasn't been found on that branch.
                .where('pa.found', '=', false),
            ),
        )
        .selectFrom('page_ancestors')
        .selectAll()
        .where('found', '=', true)
        .limit(1)
        .executeTakeFirst();
    } catch (err) {
      // Fail closed (return null -> caller 404s), but never silently: this is
      // now a live public-share path (isPageReachableThroughShare), so a
      // transient DB error here would otherwise turn a legitimate viewer of an
      // includeSubPages descendant into a misleading "not found" with no trace.
      this.logger.error(
        `getShareAncestorPage failed (ancestorPageId=${ancestorPageId}, childPageId=${childPageId})`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    return ancestor;
  }

  /**
   * Resolve transclusion content for a public share viewer. Each requested
   * source page must itself be reachable via the share graph (its own share
   * or a shared ancestor with `includeSubPages`), in the same workspace as
   * the requesting share, with sharing allowed and no restricted ancestors.
   * Sources that don't qualify come back as `no_access` so the editor renders
   * the existing placeholder. The viewer's personal permissions are
   * intentionally ignored — share-served content is gated only by the share
   * graph.
   */
  async lookupTransclusionForShare(
    shareId: string,
    references: Array<{ sourcePageId: string; transclusionId: string }>,
    workspaceId: string,
  ): Promise<{ items: TransclusionLookup[] }> {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspaceId) {
      throw new NotFoundException('Share not found');
    }
    const sharingAllowed = await this.isSharingAllowed(
      workspaceId,
      share.spaceId,
    );
    if (!sharingAllowed) {
      throw new NotFoundException('Share not found');
    }

    const candidatePageIds = Array.from(
      new Set(references.map((r) => r.sourcePageId)),
    );

    // TODO: Reduce DB round trips at scale by replacing the per-page chain
    // with bulk repo methods that take all candidate pageIds at once:
    //   - shareRepo.getSharesForPages(pageIds, workspaceId): Map<pageId, share>
    //   - pagePermissionRepo.filterRestrictedPageIds(pageIds): Set<pageId>
    //   - isSharingAllowed for the distinct spaceIds in one query
    // Brings per-request trip count from ~2N+1 (parallel) to 3 (constant)
    // for N unique candidate pages. Worth doing if profiling ever flags it.

    // Most candidates will share the host share's space, so cache by spaceId
    // and seed with the host space we just verified. Stores in-flight
    // promises so concurrent chains de-dupe at the request boundary.
    const sharingAllowedCache = new Map<string, Promise<boolean>>();
    sharingAllowedCache.set(share.spaceId, Promise.resolve(true));
    const isSharingAllowedFor = (spaceId: string) => {
      const cached = sharingAllowedCache.get(spaceId);
      if (cached) return cached;
      const p = this.isSharingAllowed(workspaceId, spaceId);
      sharingAllowedCache.set(spaceId, p);
      return p;
    };

    // Per-page chains run in parallel; wall time is the slowest chain, not
    // the sum. Each chain still does its 2–3 queries sequentially because
    // each step gates the next.
    const accessibleResults = await Promise.all(
      candidatePageIds.map(async (pageId) => {
        const sourceShare = await this.getShareForPage(pageId, workspaceId);
        if (!sourceShare) return null;
        if (!(await isSharingAllowedFor(sourceShare.spaceId))) return null;
        const restricted =
          await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
        if (restricted) return null;
        return pageId;
      }),
    );
    const accessibleSet = new Set<string>(
      accessibleResults.filter((id): id is string => id !== null),
    );

    const { items } = await this.transclusionService.lookupWithAccessSet(
      references,
      accessibleSet,
      workspaceId,
    );

    // Resolve the workspace htmlEmbed toggle once for this share request; all
    // transcluded items belong to the same workspace as the host share.
    const htmlEmbedEnabled =
      await this.isHtmlEmbedEnabledForWorkspace(workspaceId);

    // Sanitize each item's content for public delivery
    // generate per-attachment tokens scoped to the source page
    // and strip comment marks.
    const tokenized = await Promise.all(
      items.map(async (item) => {
        if ('status' in item) return item;
        const doc = await this.prepareContentForShare(
          item.content,
          item.sourcePageId,
          workspaceId,
          htmlEmbedEnabled,
        );
        return { ...item, content: doc?.toJSON() ?? item.content };
      }),
    );

    // Collapse `not_found` to `no_access` for share viewers so the response
    // can't be used to tell "page is shared but transclusion id doesn't
    // match" from "page isn't shared at all".
    const sanitized = tokenized.map((item) =>
      'status' in item && item.status === 'not_found'
        ? {
            sourcePageId: item.sourcePageId,
            transclusionId: item.transclusionId,
            status: 'no_access' as const,
          }
        : item,
    );

    return { items: sanitized };
  }

  async isSharingAllowed(
    workspaceId: string,
    spaceId: string,
  ): Promise<boolean> {
    const result = await this.db
      .selectFrom('workspaces')
      .innerJoin('spaces', 'spaces.workspaceId', 'workspaces.id')
      .select([
        'workspaces.settings as workspaceSettings',
        'spaces.settings as spaceSettings',
      ])
      .where('workspaces.id', '=', workspaceId)
      .where('spaces.id', '=', spaceId)
      .executeTakeFirst();

    if (!result) return false;

    const workspaceDisabled =
      (result.workspaceSettings as any)?.sharing?.disabled === true;
    const spaceDisabled =
      (result.spaceSettings as any)?.sharing?.disabled === true;

    return !workspaceDisabled && !spaceDisabled;
  }

  async updatePublicAttachments(page: Page): Promise<any> {
    const htmlEmbedEnabled = await this.isHtmlEmbedEnabledForWorkspace(
      page.workspaceId,
    );
    const doc = await this.prepareContentForShare(
      page.content,
      page.id,
      page.workspaceId,
      htmlEmbedEnabled,
    );
    return doc?.toJSON() ?? page.content;
  }

  /**
   * Prepare a ProseMirror JSON doc for delivery to a public share viewer.
   * Performs the two transforms required by the share threat model:
   *
   * 1. Mint a per-attachment public token scoped to `attachmentOwnerPageId`
   *    and rewrite each attachment node's `src`/`url` to the public form
   *    (`/files/public/...?jwt=`). The receiver enforces
   *    `attachment.pageId === token.pageId`, which is why the owner page id
   *    has to be passed in explicitly: the host page for direct shared
   *    content, the source page for transcluded source-block content
   *    (attachments in a sync block were uploaded onto the source page).
   *
   * 2. Strip `comment` marks. Comments are internal-team metadata and must
   *    not leak structure (existence, location, count, resolved state, or
   *    comment ids) to public viewers.
   *
   * 3. Strip `htmlEmbed` nodes when the workspace master toggle is OFF. The
   *    block renders inside a sandboxed iframe on the client (harmless, no
   *    same-origin access), so this is NOT an XSS guard — it is the
   *    SERVER-AUTHORITATIVE enforcement of the workspace master toggle for
   *    anonymous shares: an anonymous viewer cannot read the per-workspace
   *    toggle, so when OFF the block is never served, and when ON it is served
   *    and rendered in its sandboxed frame. `htmlEmbedEnabled` is resolved
   *    fail-closed by the callers (missing workspace => OFF => strip).
   *
   * Both share-content paths — the host page (`updatePublicAttachments`) and
   * the share-scoped transclusion lookup (`lookupTransclusionForShare`) —
   * call into this single helper so the two paths can never drift on
   * sanitization rules.
   */
  private async prepareContentForShare(
    content: unknown,
    attachmentOwnerPageId: string,
    workspaceId: string,
    htmlEmbedEnabled: boolean,
  ): Promise<Node | null> {
    let pmJson = getProsemirrorContent(content);

    // Master-toggle enforcement: when the workspace toggle is OFF, never serve
    // htmlEmbed nodes to anonymous public viewers (who cannot read the toggle).
    // Strip before tokenizing/serializing.
    if (!htmlEmbedEnabled) {
      pmJson = stripHtmlEmbedNodes(pmJson);
    }

    const attachmentIds = getAttachmentIds(pmJson);

    const tokenMap = new Map<string, string>();
    await Promise.all(
      attachmentIds.map(async (attachmentId: string) => {
        const token = await this.tokenService.generateAttachmentToken({
          attachmentId,
          pageId: attachmentOwnerPageId,
          workspaceId,
        });
        tokenMap.set(attachmentId, token);
      }),
    );

    const doc = jsonToNode(pmJson);
    doc?.descendants((node: Node) => {
      if (!isAttachmentNode(node.type.name)) return;
      const token = tokenMap.get(node.attrs.attachmentId);
      if (!token) return;
      updateAttachmentAttr(node, 'src', token);
      updateAttachmentAttr(node, 'url', token);
    });

    return doc ? removeMarkTypeFromDoc(doc, 'comment') : null;
  }
}
