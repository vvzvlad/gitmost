import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ShareAliasRepo } from '@docmost/db/repos/share-alias/share-alias.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareService } from './share.service';
import { Page, ShareAlias } from '@docmost/db/types/entity.types';
import { isValidShareAlias, normalizeShareAlias } from './share-alias.util';

/** Postgres unique_violation; the (workspace_id, alias) constraint races here. */
const PG_UNIQUE_VIOLATION = '23505';

export interface ResolvedAliasTarget {
  share: NonNullable<
    Awaited<ReturnType<ShareService['resolveReadableSharePage']>>
  >['share'];
  page: Page;
}

@Injectable()
export class ShareAliasService {
  private readonly logger = new Logger(ShareAliasService.name);

  constructor(
    private readonly shareAliasRepo: ShareAliasRepo,
    private readonly pageRepo: PageRepo,
    private readonly shareService: ShareService,
  ) {}

  /**
   * Create or retarget a vanity alias. The alias is workspace-scoped:
   *   - no row for this name        -> INSERT a new pointer
   *   - row already points at pageId -> no-op (idempotent)
   *   - row points elsewhere         -> the "swap". Without confirmReassign we
   *     throw 409 carrying the current target so the client can confirm; with
   *     it we UPDATE the single row's page_id (every /l/<alias> link follows the
   *     302 to the new page instantly — no stale 301 cache).
   *
   * Caller is responsible for authorizing the page (edit rights + public
   * readability); this method owns only the alias-name semantics.
   */
  async setAlias(opts: {
    workspaceId: string;
    pageId: string;
    creatorId: string;
    alias: string;
    confirmReassign?: boolean;
  }): Promise<ShareAlias> {
    const { workspaceId, pageId, creatorId, confirmReassign } = opts;
    const alias = normalizeShareAlias(opts.alias);
    if (!isValidShareAlias(alias)) {
      throw new BadRequestException(
        'Invalid alias. Use 2-60 lowercase letters, digits and hyphens.',
      );
    }

    const existing = await this.shareAliasRepo.findByAliasAndWorkspace(
      alias,
      workspaceId,
    );

    if (!existing) {
      try {
        return await this.shareAliasRepo.insert({
          workspaceId,
          alias,
          pageId,
          creatorId,
        });
      } catch (err: any) {
        // Lost a uniqueness race: another request claimed the name first.
        if (err?.code === PG_UNIQUE_VIOLATION) {
          throw new ConflictException({ message: 'Alias already taken' });
        }
        this.logger.error(err);
        throw new BadRequestException('Failed to set alias');
      }
    }

    // Already points at this page -> nothing to do.
    if (existing.pageId === pageId) {
      return existing;
    }

    // Name occupied by a different (or dangling) target: require confirmation.
    if (!confirmReassign) {
      const currentPage = existing.pageId
        ? await this.pageRepo.findById(existing.pageId)
        : null;
      throw new ConflictException({
        message: 'Alias already in use',
        code: 'ALIAS_REASSIGN_REQUIRED',
        currentPageId: existing.pageId,
        currentPageTitle: currentPage?.title ?? null,
      });
    }

    return this.shareAliasRepo.updatePageId(existing.id, pageId, workspaceId);
  }

  /** Free a vanity name (no history kept). */
  async removeAlias(aliasId: string, workspaceId: string): Promise<void> {
    await this.shareAliasRepo.delete(aliasId, workspaceId);
  }

  /** Debounced availability probe for the modal. */
  async checkAvailability(
    rawAlias: string,
    workspaceId: string,
  ): Promise<{
    alias: string;
    valid: boolean;
    available: boolean;
    currentPageId: string | null;
  }> {
    const alias = normalizeShareAlias(rawAlias);
    if (!isValidShareAlias(alias)) {
      return { alias, valid: false, available: false, currentPageId: null };
    }
    const existing = await this.shareAliasRepo.findByAliasAndWorkspace(
      alias,
      workspaceId,
    );
    return {
      alias,
      valid: true,
      available: !existing,
      currentPageId: existing?.pageId ?? null,
    };
  }

  /** A single alias row scoped to the workspace, or undefined. */
  getAliasById(
    aliasId: string,
    workspaceId: string,
  ): Promise<ShareAlias | undefined> {
    return this.shareAliasRepo.findById(aliasId, workspaceId);
  }

  /** The alias currently targeting a page (modal display), or undefined. */
  getAliasForPage(
    pageId: string,
    workspaceId: string,
  ): Promise<ShareAlias | undefined> {
    return this.shareAliasRepo.findByPageId(pageId, workspaceId);
  }

  /**
   * Resolve a vanity alias to the canonical, publicly-READABLE share page, or
   * null. This re-runs the authoritative share boundary at request time (so a
   * later-unshared / restricted / sharing-disabled target collapses to null and
   * the caller serves the generic SPA 404 — no existence leak). The alias row
   * itself is just a pointer; this is where access is actually decided.
   */
  async resolveReadableTarget(
    rawAlias: string,
    workspaceId: string,
  ): Promise<ResolvedAliasTarget | null> {
    const alias = normalizeShareAlias(rawAlias);
    if (!isValidShareAlias(alias)) return null;

    const aliasRow = await this.shareAliasRepo.findByAliasAndWorkspace(
      alias,
      workspaceId,
    );
    // Unknown name or a dangling alias (target page deleted) -> not resolvable.
    if (!aliasRow?.pageId) return null;

    const resolved = await this.shareService.resolveReadableSharePage(
      undefined,
      aliasRow.pageId,
      workspaceId,
    );
    if (!resolved) return null;

    const sharingAllowed = await this.shareService.isSharingAllowed(
      workspaceId,
      resolved.share.spaceId,
    );
    if (!sharingAllowed) return null;

    return resolved;
  }
}
