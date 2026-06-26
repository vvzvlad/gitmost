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
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';

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
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Create, RENAME or retarget a page's vanity alias. INVARIANT: a page has
   * EXACTLY ONE custom address. The alias name is workspace-scoped:
   *   - name free, page has no alias yet -> INSERT a new pointer
   *   - name free, page already has one  -> RENAME that row in place (the slug
   *     edit, e.g. `te` -> `ted`); we never spawn a second row, so no orphan
   *     `/l/<old>` link survives
   *   - name already points at pageId    -> no-op (idempotent)
   *   - name points at ANOTHER page      -> the "swap". Without confirmReassign
   *     we throw 409 carrying the current target so the client can confirm;
   *     with it we UPDATE the single row's page_id (every /l/<alias> link
   *     follows the 302 to the new page instantly — no stale cache).
   *
   * After ANY successful write we DELETE every other alias row still pointing
   * at this page (the previous name after a rename/retarget, plus any legacy
   * duplicates) so the invariant self-heals. The whole thing runs in one
   * transaction so the page never transiently has zero or duplicate rows.
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

    try {
      return await executeTx(this.db, async (trx) => {
        const byName = await this.shareAliasRepo.findByAliasAndWorkspace(
          alias,
          workspaceId,
          trx,
        );

        // The name is occupied by a DIFFERENT (or dangling) target page.
        if (byName && byName.pageId !== pageId) {
          if (!confirmReassign) {
            const currentPage = byName.pageId
              ? await this.pageRepo.findById(byName.pageId)
              : null;
            throw new ConflictException({
              message: 'Alias already in use',
              code: 'ALIAS_REASSIGN_REQUIRED',
              currentPageId: byName.pageId,
              currentPageTitle: currentPage?.title ?? null,
            });
          }
          // Confirmed: claim the existing name row for this page, then drop the
          // page's previous alias row(s) so it ends with exactly this one.
          const retargeted = await this.shareAliasRepo.updatePageId(
            byName.id,
            pageId,
            workspaceId,
            trx,
          );
          await this.shareAliasRepo.deleteOthersForPage(
            pageId,
            retargeted.id,
            workspaceId,
            trx,
          );
          return retargeted;
        }

        // The name is FREE, or already points at THIS page. Ensure the page has
        // a single row carrying this name: rename its current one, or insert.
        const current =
          byName ??
          (await this.shareAliasRepo.findByPageId(pageId, workspaceId, trx));

        let row: ShareAlias;
        if (current) {
          row =
            current.alias === alias
              ? current // same-name no-op
              : await this.shareAliasRepo.updateAlias(
                  current.id,
                  alias,
                  workspaceId,
                  trx,
                );
        } else {
          row = await this.shareAliasRepo.insert(
            { workspaceId, alias, pageId, creatorId },
            trx,
          );
        }

        // Self-heal: a page keeps EXACTLY ONE custom address.
        await this.shareAliasRepo.deleteOthersForPage(
          pageId,
          row.id,
          workspaceId,
          trx,
        );
        return row;
      });
    } catch (err: any) {
      if (
        err instanceof ConflictException ||
        err instanceof BadRequestException
      ) {
        throw err;
      }
      // Lost a uniqueness race: another request claimed the name first.
      if (err?.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException({ message: 'Alias already taken' });
      }
      this.logger.error(err);
      throw new BadRequestException('Failed to set alias');
    }
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
