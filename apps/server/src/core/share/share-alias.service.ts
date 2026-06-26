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

/** Postgres unique_violation. Two unique indexes can raise it on this table. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Unique index names from the share_aliases migrations. The `postgres@3.x`
 * driver (kysely-postgres-js) surfaces the violated constraint as
 * `err.constraint_name` (NOT `.constraint`); we keep `.constraint` only as a
 * defensive fallback for other drivers.
 *   - ALIAS:  `(workspace_id, alias)`  -> the vanity NAME is taken.
 *   - PAGE_ID: partial `(workspace_id, page_id) WHERE page_id IS NOT NULL`
 *             -> a concurrent writer already gave THIS page an alias.
 */
const UNIQUE_ALIAS_INDEX = 'share_aliases_workspace_id_alias_unique';
const UNIQUE_PAGE_ID_INDEX = 'share_aliases_workspace_id_page_id_unique';

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
   * To keep the invariant self-healing we DELETE every other alias row still
   * pointing at this page (a legacy duplicate, or the target page's own former
   * alias during a swap). The whole thing runs in one transaction. Because the
   * `(workspace_id, page_id)` unique index is NON-deferrable (checked at the end
   * of each statement), the swap branch DELETEs the target page's existing row
   * BEFORE retargeting, so the page is never transiently carried by two rows;
   * the other branches self-heal AFTER their write. Either way the page never
   * ends a statement with duplicate rows.
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
          // Confirmed swap. ORDER MATTERS: the partial unique index on
          // `(workspace_id, page_id)` is NON-deferrable, so it is checked at the
          // end of EVERY statement. If we retargeted `byName` onto `pageId`
          // first while `pageId` still had its OWN alias row, there would
          // momentarily be two rows with this page_id -> immediate 23505 and a
          // rolled-back tx (a misleading "Alias already taken"). So we FIRST drop
          // the target page's existing alias row(s), THEN retarget. `byName.id`
          // still points at its old page here, so excluding it via `keepId` is
          // harmless; after the retarget it is the page's only row, so no
          // trailing self-heal is needed.
          await this.shareAliasRepo.deleteOthersForPage(
            pageId,
            byName.id,
            workspaceId,
            trx,
          );
          return await this.shareAliasRepo.updatePageId(
            byName.id,
            pageId,
            workspaceId,
            trx,
          );
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
      // A unique index fired. Which one decides the message — always log the
      // constraint so the race is diagnosable.
      if (err?.code === PG_UNIQUE_VIOLATION) {
        const constraint: string | undefined =
          err?.constraint_name ?? err?.constraint;
        this.logger.warn(
          `share alias unique violation on ${constraint ?? '<unknown>'}`,
        );
        // `(workspace_id, page_id)`: a concurrent request already gave this page
        // an alias. The page still has exactly one custom address (the racing
        // writer's), so this is not a user-facing name clash — surface a
        // distinct, non-misleading message instead of "Alias already taken".
        if (constraint === UNIQUE_PAGE_ID_INDEX) {
          throw new ConflictException({
            message: 'This page is being given an address by another request',
            code: 'ALIAS_PAGE_RACE',
          });
        }
        // `(workspace_id, alias)` (UNIQUE_ALIAS_INDEX) or any other/unknown
        // unique index: treat as the vanity name being claimed first.
        if (constraint && constraint !== UNIQUE_ALIAS_INDEX) {
          this.logger.warn(
            `unexpected unique index ${constraint} mapped to "Alias already taken"`,
          );
        }
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
