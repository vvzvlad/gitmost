import { Injectable, Logger } from '@nestjs/common';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { User } from '@docmost/db/types/entity.types';
import { TokenService } from '../../auth/services/token.service';
import { AiService } from '../../../integrations/ai/ai.service';
import { AiEmbeddingNotConfiguredException } from '../../../integrations/ai/ai-embedding-not-configured.exception';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import {
  loadDocmostMcp,
  type DocmostClientLike,
} from './docmost-client.loader';

/**
 * Per-user, per-request adapter that exposes Docmost READ operations to the
 * agent as AI SDK tools (STAGE A = read only).
 *
 * Each tool call goes loopback over the user's own access JWT, so Docmost CASL
 * enforces access on every request — there is NO extra authorization here
 * (§8.5). The client is built fresh per chat request and never shares the
 * cached service-account `/mcp` handler.
 *
 * SINGLE-WORKSPACE ASSUMPTION: the loopback host (127.0.0.1) does not resolve a
 * workspace subdomain, so this targets the default/first workspace only. The
 * existing service-account `/mcp` path already calls loopback successfully, so
 * this works for single-workspace self-host.
 */
@Injectable()
export class AiChatToolsService {
  private readonly logger = new Logger(AiChatToolsService.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly aiService: AiService,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async forUser(
    user: User,
    sessionId: string,
    // workspaceId scopes the provenance collab token (which is workspace-bound),
    // and documents the single-workspace assumption; the loopback REST client is
    // scoped by the user's JWT, not by an explicit workspace argument.
    workspaceId: string,
    // The resolved AI chat id. Threaded into both provenance tokens so every
    // agent write (REST + collab) records { actor:'agent', aiChatId } off a
    // SIGNED claim — non-spoofable, never a client body field (§6.5/§6.6).
    aiChatId: string,
  ): Promise<Record<string, Tool>> {
    const apiUrl =
      process.env.MCP_DOCMOST_API_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/api`;

    // BARE access JWT carrying the agent provenance claim (the client adds the
    // "Bearer " prefix and re-calls this on a 401). Minted against the live
    // session so jwt.strategy validates it (§15[C1]); the signed actor/aiChatId
    // drives the REST write provenance (create/rename/move page, comment
    // create/resolve) server-side.
    const getToken = () =>
      this.tokenService.generateAccessToken(user, sessionId, {
        actor: 'agent',
        aiChatId,
      });

    // Provenance COLLAB token for content mutations (which go over the collab
    // websocket). Signed with the same agent claim so onAuthenticate ->
    // onStoreDocument record 'agent'/aiChatId on the page (§6.6/§15 C2). The
    // client routes every content mutation through this provider instead of
    // POST /auth/collab-token.
    const getCollabToken = () =>
      this.tokenService.generateCollabToken(user, workspaceId, {
        actor: 'agent',
        aiChatId,
      });

    const { DocmostClient } = await loadDocmostMcp();
    const client: DocmostClientLike = new DocmostClient({
      apiUrl,
      getToken,
      getCollabToken,
    });

    return {
      searchPages: tool({
        description:
          'Full-text search across the pages the current user can access. ' +
          'Returns a compact list of matching pages with a short snippet.',
        inputSchema: z.object({
          query: z.string().describe('The search query.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('Maximum number of results (1-50).'),
        }),
        execute: async ({ query, limit }) => {
          // search(query, spaceId?, limit?) -> { items, success }.
          // Items are filterSearchResult(): { id, title, highlight, ... }.
          const result = await client.search(query, undefined, limit);
          const items = Array.isArray(result?.items) ? result.items : [];
          // Keep the payload token-efficient: id + title + a short snippet only.
          return items.map((raw) => {
            const item = raw as {
              id?: string;
              slugId?: string;
              title?: string;
              highlight?: string;
            };
            return {
              id: item.id ?? item.slugId,
              title: item.title ?? '',
              snippet: snippet(item.highlight),
            };
          });
        },
      }),

      getPage: tool({
        description:
          'Fetch a single page as Markdown by its page id. Returns the page ' +
          'title and its Markdown content.',
        inputSchema: z.object({
          pageId: z.string().describe('The id (or slugId) of the page.'),
        }),
        execute: async ({ pageId }) => {
          // getPage(pageId) -> { data: filterPage(page, markdown), success }.
          const result = await client.getPage(pageId);
          const data = (result?.data ?? {}) as {
            title?: string;
            content?: string;
          };
          return {
            title: data.title ?? '',
            markdown: typeof data.content === 'string' ? data.content : '',
          };
        },
      }),

      semanticSearch: tool({
        description:
          'Semantic (vector) search across the pages the current user can ' +
          'access. Finds pages by meaning, not just keywords — use it to ' +
          'answer conceptual questions. Returns a compact list of relevant ' +
          'pages with a short snippet. Falls back to searchPages if semantic ' +
          'search is unavailable.',
        inputSchema: z.object({
          query: z.string().describe('The natural-language search query.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe('Maximum number of results (1-20).'),
        }),
        execute: async ({ query, limit }) => {
          // ACCESS CONTROL: this tool runs IN-PROCESS (a direct pgvector query),
          // so unlike the loopback REST tools it does NOT get CASL for free. We
          // scope every query to the spaces the user can read, mirroring
          // SearchService.searchPage (§6.7 / §8). We additionally post-filter by
          // page-level permissions so restricted pages inside an accessible
          // space are never returned.
          const trimmed = (query ?? '').trim();
          if (trimmed.length === 0) return [];

          // 1) Embed the query (no-op fallback when embeddings are unconfigured
          //    so the agent can fall back to searchPages instead of erroring).
          let queryVector: number[];
          try {
            const [vec] = await this.aiService.embedTexts(workspaceId, [
              trimmed,
            ]);
            if (!vec) return [];
            queryVector = vec;
          } catch (err) {
            if (err instanceof AiEmbeddingNotConfiguredException) {
              return {
                unavailable: true,
                reason:
                  'semantic search unavailable (embeddings not configured)',
              };
            }
            // Never leak provider/key details; surface a generic unavailable.
            this.logger.warn(
              `semanticSearch embed failed: ${
                err instanceof Error ? err.message : 'unknown error'
              }`,
            );
            return {
              unavailable: true,
              reason: 'semantic search unavailable',
            };
          }

          // 2) Resolve the spaces this user can read (member spaces + groups),
          //    mirroring SearchService's space scoping. No spaces => no results.
          const accessibleSpaceIds =
            await this.spaceMemberRepo.getUserSpaceIds(user.id);
          if (accessibleSpaceIds.length === 0) return [];

          // 3) Cosine ANN over the embeddings, scoped to the workspace AND the
          //    accessible spaces. Over-fetch a little so the page-permission
          //    post-filter still leaves enough results.
          const cap = limit ?? 10;
          const hits = await this.pageEmbeddingRepo.searchByEmbedding(
            workspaceId,
            queryVector,
            accessibleSpaceIds,
            cap * 3,
          );
          if (hits.length === 0) return [];

          // 4) Page-level permission post-filter: a space being accessible does
          //    not imply every page in it is (restricted pages). Mirror
          //    SearchService.searchPage's filterAccessiblePageIds pass.
          const pageIds = Array.from(new Set(hits.map((h) => h.pageId)));
          const accessibleIds =
            await this.pagePermissionRepo.filterAccessiblePageIds({
              pageIds,
              userId: user.id,
            });
          const accessibleSet = new Set(accessibleIds);

          // Keep the best (lowest-distance) hit per page, capped to `limit`.
          const seen = new Set<string>();
          const results: { pageId: string; title: string; snippet: string }[] =
            [];
          for (const hit of hits) {
            if (!accessibleSet.has(hit.pageId)) continue;
            if (seen.has(hit.pageId)) continue;
            seen.add(hit.pageId);
            results.push({
              pageId: hit.pageId,
              title: hit.title ?? '',
              snippet: snippet(hit.content),
            });
            if (results.length >= cap) break;
          }
          return results;
        },
      }),

      // --- WRITE tools (all reversible — history/trash; §6.5 / D3) ---

      createPage: tool({
        description:
          'Create a new page with a Markdown body in a space, optionally under ' +
          'a parent page. Returns the new page id and title. Reversible: a page ' +
          'can be moved to trash later.',
        inputSchema: z.object({
          title: z.string().describe('The title of the new page.'),
          content: z
            .string()
            .describe('The page body as Markdown (may be empty).'),
          spaceId: z
            .string()
            .describe('The id of the space to create the page in.'),
          parentPageId: z
            .string()
            .optional()
            .describe('Optional parent page id to nest the new page under.'),
        }),
        execute: async ({ title, content, spaceId, parentPageId }) => {
          // createPage(title, content, spaceId, parentPageId?) ->
          // { data: filterPage(page, markdown), success }.
          const result = await client.createPage(
            title,
            content ?? '',
            spaceId,
            parentPageId,
          );
          const data = (result?.data ?? {}) as {
            id?: string;
            slugId?: string;
            title?: string;
          };
          return { id: data.id ?? data.slugId, title: data.title ?? title };
        },
      }),

      updatePageContent: tool({
        description:
          "Replace a page's body with new Markdown content (and optionally its " +
          'title). Reversible: the previous version is kept in page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to update.'),
          content: z.string().describe('The new page body as Markdown.'),
          title: z
            .string()
            .optional()
            .describe('Optional new title for the page.'),
        }),
        execute: async ({ pageId, content, title }) => {
          // updatePage mutates the live collab doc -> provenance flows from the
          // collab-token provider. Returns { success, modified, message, pageId }.
          const result = (await client.updatePage(pageId, content, title)) as {
            success?: boolean;
          };
          return { pageId, updated: result?.success ?? true };
        },
      }),

      renamePage: tool({
        description:
          "Rename a page (change its title only; the body is untouched). " +
          'Reversible: rename back at any time.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to rename.'),
          title: z.string().describe('The new title.'),
        }),
        execute: async ({ pageId, title }) => {
          // renamePage(pageId, title) -> { success, pageId, title }.
          await client.renamePage(pageId, title);
          return { pageId, title };
        },
      }),

      movePage: tool({
        description:
          'Move a page under a new parent page, or to the space root when no ' +
          'parent is given. Reversible: move it back at any time.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to move.'),
          parentPageId: z
            .string()
            .nullable()
            .optional()
            .describe(
              'Target parent page id. Null/omitted moves the page to the ' +
                'space root.',
            ),
        }),
        execute: async ({ pageId, parentPageId }) => {
          // movePage(pageId, parentPageId, position?) -> raw move response.
          await client.movePage(pageId, parentPageId ?? null);
          return { pageId, parentPageId: parentPageId ?? null, moved: true };
        },
      }),

      deletePage: tool({
        description:
          'Move a page to the trash (SOFT delete only — fully reversible; the ' +
          'page can be restored from trash). This NEVER permanently deletes.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to move to trash.'),
        }),
        // GUARDRAIL (§14 H4): the only field ever passed to the client is
        // pageId. permanentlyDelete/forceDelete are not part of the schema and
        // are never forwarded, so the agent physically cannot permanently
        // delete a page through this tool.
        execute: async ({ pageId }) => {
          // deletePage(pageId) hits POST /pages/delete with { pageId } only,
          // which is the soft-delete (trash) path on the server.
          await client.deletePage(pageId);
          return { pageId, trashed: true };
        },
      }),

      createComment: tool({
        description:
          'Add a comment to a page, or reply to an existing top-level comment ' +
          '(one level only — the backend rejects replies to replies). ' +
          'Reversible via the comment UI.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to comment on.'),
          content: z.string().describe('The comment body as Markdown.'),
          parentCommentId: z
            .string()
            .optional()
            .describe(
              'Optional id of a TOP-LEVEL comment to reply to (one level ' +
                'of replies only).',
            ),
        }),
        execute: async ({ pageId, content, parentCommentId }) => {
          // createComment(pageId, content, type, selection?, parentCommentId?).
          // Page-type comment (no inline selection); replies inherit the anchor.
          const result = await client.createComment(
            pageId,
            content,
            'page',
            undefined,
            parentCommentId,
          );
          const data = (result?.data ?? {}) as { id?: string };
          return { commentId: data.id, pageId };
        },
      }),

      resolveComment: tool({
        description:
          'Resolve or reopen a top-level comment thread (reversible — toggle ' +
          'the resolved flag). Only top-level comments can be resolved.',
        inputSchema: z.object({
          commentId: z
            .string()
            .describe('The id of the top-level comment to resolve/reopen.'),
          resolved: z
            .boolean()
            .describe('true to resolve the thread, false to reopen it.'),
        }),
        execute: async ({ commentId, resolved }) => {
          // resolveComment(commentId, resolved) -> { success, commentId, resolved }.
          await client.resolveComment(commentId, resolved);
          return { commentId, resolved };
        },
      }),
    };
  }
}

/**
 * Trim a search highlight/snippet to a token-efficient length. The highlight
 * may contain `<b>` markers from the search backend; they are harmless to the
 * model but we cap the overall length so a long page does not bloat the tool
 * result.
 */
function snippet(text: string | undefined): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const MAX = 300;
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}
