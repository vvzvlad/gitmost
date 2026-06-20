import { Injectable, Logger } from '@nestjs/common';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { ShareService } from '../../share/share.service';
import { SearchService } from '../../search/search.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { jsonToMarkdown } from '../../../collaboration/collaboration.util';

/**
 * Isolated, READ-ONLY toolset for the ANONYMOUS public-share assistant.
 *
 * Unlike the authenticated `AiChatToolsService.forUser`, this toolset:
 *  - mints NO loopback token and carries NO user identity;
 *  - runs fully in-process (no HTTP self-calls);
 *  - exposes ONLY read tools, every one of them hard-scoped to a SINGLE share
 *    tree (`shareId` + `workspaceId`).
 *
 * The security boundary is this tool scope, not any caller identity. Each tool
 * re-derives the share scope server-side and never trusts client-supplied ids
 * beyond looking them up inside the share tree:
 *  - search uses the existing share-scoped FTS branch
 *    (`shareId && !spaceId && !userId`), which itself restricts results to the
 *    share's pages and excludes restricted descendants;
 *  - reading a page first confirms, via `getShareForPage`, that the page
 *    resolves to THIS share AND (because getShareForPage does NOT itself
 *    exclude restricted descendants) that the page has no restricted ancestor,
 *    before returning any content.
 */
@Injectable()
export class PublicShareChatToolsService {
  private readonly logger = new Logger(PublicShareChatToolsService.name);

  constructor(
    private readonly shareService: ShareService,
    private readonly searchService: SearchService,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  /**
   * Build the read-only tool set scoped to one share tree. `shareId` and
   * `workspaceId` are server-resolved (host = tenant), never taken from the
   * model's input. Returns search + read tools and a small outline tool; there
   * are NO write tools, NO comments/history, NO cross-space or external tools.
   */
  forShare(shareId: string, workspaceId: string): Record<string, Tool> {
    return {
      searchSharePages: tool({
        description:
          'Search the pages of THIS published documentation share for a ' +
          'query. Returns the most relevant pages with a short snippet, best ' +
          "match first. Rephrase the reader's question into focused keywords " +
          '(key terms and entities), not a full sentence. If the first ' +
          'results look weak, search again with different wording before ' +
          'answering. Only pages inside this share are ever returned.',
        inputSchema: z.object({
          query: z.string().describe('The search query.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe('Maximum number of results (1-20).'),
        }),
        execute: async ({ query, limit }) => {
          const trimmed = (query ?? '').trim();
          if (!trimmed) return [];
          // Share-scoped FTS branch: passing shareId WITHOUT spaceId/userId
          // selects the `shareId && !spaceId && !opts.userId` path, which
          // validates the share + workspace, drops restricted ancestors, and
          // limits results to the share's page set.
          const { items } = await this.searchService.searchPage(
            { query: trimmed, shareId, limit: limit ?? 10 } as never,
            { workspaceId },
          );
          return items.map((item) => ({
            id: item.id,
            title: item.title ?? '',
            snippet: item.highlight ?? '',
          }));
        },
      }),

      getSharePage: tool({
        description:
          'Fetch a single page of THIS published documentation share as ' +
          'Markdown, by its page id. Returns the page title and its Markdown ' +
          'content. Only pages inside this share can be read; reading any ' +
          'other page fails.',
        inputSchema: z.object({
          pageId: z
            .string()
            .describe('The id (or slugId) of a page within this share.'),
        }),
        execute: async ({ pageId }) => {
          const id = (pageId ?? '').trim();
          if (!id) {
            throw new Error('A pageId is required.');
          }
          // Confirm the page resolves to THIS share (recursive CTE up the tree,
          // honouring includeSubPages + workspace check). NOTE: getShareForPage
          // joins only the `shares` table — it does NOT exclude restricted
          // descendants — so membership alone is not sufficient (see the
          // explicit restricted check below, which the public view also does).
          // Not in this share => tool error WITHOUT leaking whether the page
          // exists at all.
          const share = await this.shareService.getShareForPage(
            id,
            workspaceId,
          );
          if (!share || share.id !== shareId) {
            throw new Error('That page is not part of this published share.');
          }

          const page = await this.pageRepo.findById(id, {
            includeContent: true,
          });
          if (!page || page.deletedAt) {
            throw new Error('That page is not part of this published share.');
          }

          // A restricted descendant (a page with its own page_permissions /
          // pageAccess row) is hidden from the public share view even when it
          // sits inside an includeSubPages share. getShareForPage does NOT
          // exclude it, so we must replicate the public view's restricted-
          // ancestor gate here (ShareService.getSharedPage). Use the SAME
          // generic message as an out-of-share page so the model cannot
          // distinguish "restricted" from "not in share" (no info leak).
          if (await this.pagePermissionRepo.hasRestrictedAncestor(page.id)) {
            throw new Error('That page is not part of this published share.');
          }

          // Reuse the public share-content sanitizer: strips comment marks and
          // tokenizes attachments for public delivery, exactly as the public
          // shared-page view does.
          const publicContent = await this.shareService.updatePublicAttachments(
            page,
          );
          let markdown = '';
          try {
            markdown = jsonToMarkdown(publicContent);
          } catch (err) {
            // Never throw raw conversion errors back to the model; log short.
            this.logger.warn(
              `Share page markdown conversion failed: ${
                err instanceof Error ? err.message : 'unknown error'
              }`,
            );
            markdown = '';
          }
          return { title: page.title ?? '', markdown };
        },
      }),

      listSharePages: tool({
        description:
          'List the pages (titles + ids) that make up THIS published ' +
          'documentation share, so you can orient yourself before reading or ' +
          'searching. Only pages inside this share are listed.',
        inputSchema: z.object({}),
        execute: async () => {
          // Reuse the same share-tree logic the public /shares/tree route uses:
          // it validates the share + workspace, excludes restricted subtrees,
          // and returns only the share's pages (or just the root page when
          // includeSubPages is false).
          try {
            const { share, pageTree } = await this.shareService.getShareTree(
              shareId,
              workspaceId,
            );
            // getShareTree's `share` comes from shareRepo.findById WITHOUT
            // includeSharedPage, so it carries NO root title. When the share
            // includes subpages, the root page is the FIRST entry of pageTree
            // (getPageAndDescendantsExcludingRestricted starts at share.pageId)
            // and already has its real title — so we list pageTree directly and
            // only fall back to a cheap title-only lookup for the single-page
            // share (includeSubPages=false => pageTree is empty).
            const rootInTree = pageTree.some((p) => p.id === share.pageId);
            const pages: Array<{ id: string; title?: string }> = pageTree.map(
              (p) => ({ id: p.id, title: p.title }),
            );
            if (!rootInTree) {
              // Single-page share (or root missing from tree): fetch the root
              // title cheaply (base fields only, no content) so it isn't blank.
              const rootPage = await this.pageRepo.findById(share.pageId);
              pages.unshift({
                id: share.pageId,
                title: rootPage?.title,
              });
            }
            // De-duplicate by id, keeping the first (titled) occurrence.
            const seen = new Set<string>();
            return pages
              .filter((p) => {
                if (!p.id || seen.has(p.id)) return false;
                seen.add(p.id);
                return true;
              })
              .map((p) => ({ id: p.id, title: p.title ?? '' }));
          } catch (err) {
            this.logger.warn(
              `Share outline lookup failed: ${
                err instanceof Error ? err.message : 'unknown error'
              }`,
            );
            return [];
          }
        },
      }),
    };
  }
}
