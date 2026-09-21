import { Injectable, Logger } from '@nestjs/common';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { ShareService } from '../../share/share.service';
import { SearchService } from '../../search/search.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { jsonToMarkdown } from '../../../collaboration/collaboration.util';
import { modelFriendlyInput } from './model-friendly-input';

/**
 * A tool error whose message is DELIBERATELY safe to expose to an anonymous
 * share reader (and to the model, for self-correction). Every OTHER thrown error
 * is treated as internal and replaced with a generic string by `wrapToolErrors`,
 * so a raw exception message — an internal page title, a DB/stack fragment, a
 * driver detail — never rides the public UI stream (#394).
 */
export class ShareToolError extends Error {}

// The only two classified strings an anonymous reader may ever see from a tool
// failure. The specific one keeps the model's self-correction useful ("try a
// different page"); the generic one reveals nothing about the internal fault.
const SHARE_TOOL_ERROR_NOT_AVAILABLE =
  'The requested page is not available in this share.';
const SHARE_TOOL_ERROR_GENERIC = 'The tool could not complete the request.';

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
 *  - reading a page first confirms, via the single canonical
 *    `ShareService.resolveReadableSharePage` boundary, that the page resolves
 *    to THIS share, is live, and has no restricted ancestor (which
 *    getShareForPage does NOT itself check), before returning any content.
 */
@Injectable()
export class PublicShareChatToolsService {
  private readonly logger = new Logger(PublicShareChatToolsService.name);

  constructor(
    private readonly shareService: ShareService,
    private readonly searchService: SearchService,
    private readonly pageRepo: PageRepo,
  ) {}

  /**
   * Build the read-only tool set scoped to one share tree. `shareId` and
   * `workspaceId` are server-resolved (host = tenant), never taken from the
   * model's input. Returns search + read tools and a small outline tool; there
   * are NO write tools, NO comments/history, NO cross-space or external tools.
   */
  forShare(shareId: string, workspaceId: string): Record<string, Tool> {
    return this.wrapToolErrors({
      searchSharePages: tool({
        description:
          'Search the pages of THIS published documentation share for a ' +
          'query. Returns the most relevant pages with a short snippet, best ' +
          "match first. Rephrase the reader's question into focused keywords " +
          '(key terms and entities), not a full sentence. If the first ' +
          'results look weak, search again with different wording before ' +
          'answering. Only pages inside this share are ever returned.',
        inputSchema: modelFriendlyInput({
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
        inputSchema: modelFriendlyInput({
          pageId: z
            .string()
            .describe('The id (or slugId) of a page within this share.'),
        }),
        execute: async ({ pageId }) => {
          const id = (pageId ?? '').trim();
          if (!id) {
            throw new ShareToolError('A pageId is required.');
          }
          // Resolve via the SINGLE canonical share-access boundary: confirms the
          // page resolves to THIS share (recursive CTE up the tree, honouring
          // includeSubPages + workspace), the share id matches, the page is live
          // (not soft-deleted), and it has NO restricted ancestor (a restricted
          // descendant is hidden from the public view even inside an
          // includeSubPages share). Any failure => null. Use the SAME generic
          // message for every failure so the model cannot distinguish
          // "restricted" / "deleted" / "not in share" / "doesn't exist".
          const resolved = await this.shareService.resolveReadableSharePage(
            shareId,
            id,
            workspaceId,
          );
          if (!resolved) {
            throw new ShareToolError(SHARE_TOOL_ERROR_NOT_AVAILABLE);
          }
          const { page } = resolved;

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
        inputSchema: modelFriendlyInput({}),
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
    });
  }

  /**
   * Wrap every tool's `execute` so a THROWN error is sanitized in ONE place —
   * closing the byte leak, the render, and the model context at once (#394).
   *
   * The AI SDK surfaces a tool-execution throw as an atomic `tool-output-error`
   * frame on the v6 UI stream whose `errorText` is the thrown message; on the
   * public share that frame goes straight to an anonymous reader. Unwrapped, a
   * raw exception (an internal page title, a DB/stack fragment, a driver detail)
   * would ride that frame verbatim. Here we catch it, LOG the full detail
   * server-side only, and re-throw a CLASSIFIED, safe error: the tool's own
   * intentional ShareToolError messages pass through (they keep the model's
   * self-correction useful), everything else collapses to a generic string.
   */
  private wrapToolErrors(
    tools: Record<string, Tool>,
  ): Record<string, Tool> {
    const wrapped: Record<string, Tool> = {};
    for (const [name, t] of Object.entries(tools)) {
      const original = t.execute;
      if (typeof original !== 'function') {
        wrapped[name] = t;
        continue;
      }
      wrapped[name] = {
        ...t,
        execute: async (args: unknown, options: unknown) => {
          try {
            return await (
              original as (a: unknown, o: unknown) => Promise<unknown>
            )(args, options);
          } catch (err) {
            const safe =
              err instanceof ShareToolError
                ? err.message
                : SHARE_TOOL_ERROR_GENERIC;
            // Full detail to the server log ONLY — never to the anon.
            this.logger.warn(
              `Public share tool "${name}" failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            // This safe string is ALL that rides the tool-output-error frame,
            // becomes model context, and could be rendered — one choke point.
            throw new ShareToolError(safe);
          }
        },
      } as Tool;
    }
    return wrapped;
  }
}
