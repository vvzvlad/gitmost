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

      // --- READ tools (added) ---

      getWorkspace: tool({
        description:
          'Fetch metadata about the current workspace (name, settings).',
        inputSchema: z.object({}),
        execute: async () => await client.getWorkspace(),
      }),

      listSpaces: tool({
        description:
          'List the spaces the current user can access. Returns the array ' +
          'of spaces (id, name, slug, ...).',
        inputSchema: z.object({}),
        execute: async () => await client.getSpaces(),
      }),

      listPages: tool({
        description:
          'List the most recent pages, optionally scoped to a single space. ' +
          'Returns a bounded list (default 50, max 100).',
        inputSchema: z.object({
          spaceId: z
            .string()
            .optional()
            .describe('Optional space id to scope the listing to.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Maximum number of pages (1-100).'),
        }),
        execute: async ({ spaceId, limit }) =>
          await client.listPages(spaceId, limit),
      }),

      listSidebarPages: tool({
        description:
          'List sidebar pages for a space. With no pageId, returns the ' +
          "space's ROOT pages; with a pageId, returns that page's direct " +
          'CHILDREN.',
        inputSchema: z.object({
          spaceId: z.string().describe('The id of the space.'),
          pageId: z
            .string()
            .optional()
            .describe(
              'Optional page id; when given, lists that page\'s direct children.',
            ),
        }),
        execute: async ({ spaceId, pageId }) =>
          await client.listSidebarPages(spaceId, pageId),
      }),

      getOutline: tool({
        description:
          "Compact outline of a page's top-level blocks, with block ids. Use " +
          'it to locate sections/tables and grab block ids before drilling in ' +
          'with getNode / patchNode / insertNode.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
        }),
        execute: async ({ pageId }) => await client.getOutline(pageId),
      }),

      getPageJson: tool({
        description:
          'Fetch a page as lossless ProseMirror JSON (preserves block ids and ' +
          'marks). Use this when you need exact structure for node-level edits.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
        }),
        execute: async ({ pageId }) => await client.getPageJson(pageId),
      }),

      getNode: tool({
        description:
          "Fetch a single block's full ProseMirror subtree (lossless) by " +
          'reference.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          nodeId: z
            .string()
            .describe(
              'A block id from getOutline, or "#<index>" to select a ' +
                'top-level block by its outline index (e.g. a table).',
            ),
        }),
        execute: async ({ pageId, nodeId }) =>
          await client.getNode(pageId, nodeId),
      }),

      getTable: tool({
        description:
          'Read a table as a matrix of cell texts (plus a parallel cellIds ' +
          'matrix so cells can be addressed for rich edits).',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          tableRef: z
            .string()
            .describe(
              '"#<index>" from getOutline, or a block id of any node inside ' +
                'the table.',
            ),
        }),
        execute: async ({ pageId, tableRef }) =>
          await client.getTable(pageId, tableRef),
      }),

      listComments: tool({
        description:
          'List all comments on a page (content as Markdown).',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
        }),
        execute: async ({ pageId }) => await client.listComments(pageId),
      }),

      getComment: tool({
        description: 'Fetch a single comment by id (content as Markdown).',
        inputSchema: z.object({
          commentId: z.string().describe('The id of the comment.'),
        }),
        execute: async ({ commentId }) => await client.getComment(commentId),
      }),

      checkNewComments: tool({
        description:
          'Find new comments across a space (optionally scoped to a subtree) ' +
          'created after a given timestamp.',
        inputSchema: z.object({
          spaceId: z.string().describe('The id of the space to scan.'),
          since: z
            .string()
            .describe('An ISO-8601 timestamp; only comments created after it.'),
          parentPageId: z
            .string()
            .optional()
            .describe(
              'Optional page id to scope the scan to that page and its ' +
                'descendants.',
            ),
        }),
        execute: async ({ spaceId, since, parentPageId }) =>
          await client.checkNewComments(spaceId, since, parentPageId),
      }),

      listShares: tool({
        description:
          'List all public shares in the workspace, each with its public URL.',
        inputSchema: z.object({}),
        execute: async () => await client.listShares(),
      }),

      listPageHistory: tool({
        description:
          'List the saved versions (history snapshots) of a page, newest ' +
          'first. Returns one cursor-paginated page of results.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          cursor: z
            .string()
            .optional()
            .describe('Optional pagination cursor from a previous call.'),
        }),
        execute: async ({ pageId, cursor }) =>
          await client.listPageHistory(pageId, cursor),
      }),

      getPageHistory: tool({
        description:
          'Fetch a single page-history version including its lossless ' +
          'ProseMirror content.',
        inputSchema: z.object({
          historyId: z.string().describe('The id of the history version.'),
        }),
        execute: async ({ historyId }) =>
          await client.getPageHistory(historyId),
      }),

      diffPageVersions: tool({
        description:
          'Diff two versions of a page and return the change set. from/to ' +
          "each accept a historyId or 'current' (or omit for current).",
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          from: z
            .string()
            .optional()
            .describe("A historyId, or 'current'/omit for current content."),
          to: z
            .string()
            .optional()
            .describe("A historyId, or 'current'/omit for current content."),
        }),
        execute: async ({ pageId, from, to }) =>
          await client.diffPageVersions(pageId, from, to),
      }),

      exportPageMarkdown: tool({
        description:
          'Export a page to a single self-contained Docmost-flavoured ' +
          'Markdown file (meta + body + comment threads). Lossless round-trip ' +
          'with importPageMarkdown.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to export.'),
        }),
        execute: async ({ pageId }) => {
          const markdown = await client.exportPageMarkdown(pageId);
          return { markdown };
        },
      }),

      // --- WRITE tools (added; reversible via page history/trash) ---

      editPageText: tool({
        description:
          'Surgical find/replace inside a page\'s text, preserving all block ' +
          'ids and marks. A find MAY cross bold/italic/link boundaries; the ' +
          'replacement inherits marks from the unchanged common prefix/suffix ' +
          '(so editing plain text next to a bold word keeps it bold, and ' +
          'editing inside a bold word keeps the new text bold). Each find must ' +
          'match exactly once unless replaceAll is set. The batch applies what ' +
          'it can and returns applied[] + failed[]; a fully-unmatched batch ' +
          'writes nothing and errors. find should be the literal rendered text ' +
          '(no markdown). Markdown wrappers (**bold**, *italic*, `code`) and ' +
          'trailing emoji are tolerated via a strip-and-retry fallback, but ' +
          'plain text is preferred. Examples: edits:[{find:"teh",replace:"the"}]; ' +
          'edits:[{find:"Hello world",replace:"Hello there"}] (crosses a bold ' +
          'boundary). Reversible: the previous version is kept in page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to edit.'),
          edits: z
            .array(
              z.object({
                find: z.string().describe('Exact text to find.'),
                replace: z.string().describe('Replacement text.'),
                replaceAll: z
                  .boolean()
                  .optional()
                  .describe('Replace every occurrence (default: one match).'),
              }),
            )
            .min(1)
            .describe('One or more find/replace edits.'),
        }),
        execute: async ({ pageId, edits }) =>
          await client.editPageText(pageId, edits),
      }),

      patchNode: tool({
        description:
          'Replace a single content block (by id) with a new ProseMirror ' +
          'node; the replacement keeps the same nodeId. Example node: a ' +
          'paragraph {"type":"paragraph","content":[{"type":"text","text":"Hello"}]} ' +
          'or a heading {"type":"heading","attrs":{"level":2},"content":' +
          '[{"type":"text","text":"Title"}]}. Bold is a mark: ' +
          '{"type":"text","text":"x","marks":[{"type":"bold"}]}. The node arg ' +
          'may be a JSON object or a JSON string (both accepted). Reversible: ' +
          'the previous version is kept in page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          nodeId: z
            .string()
            .describe('The block id to replace (from getOutline/getPageJson).'),
          node: z
            .any()
            .describe(
              'The replacement ProseMirror node, e.g. ' +
                '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}. ' +
                'JSON object or JSON string both accepted.',
            ),
        }),
        execute: async ({ pageId, nodeId, node }) => {
          // Parity with the standalone MCP server (index.ts patch_node): the
          // model sometimes serializes the node as a JSON string. Parse it
          // before the client's typeof-object guard rejects it.
          let parsedNode = node;
          if (typeof node === 'string') {
            try {
              parsedNode = JSON.parse(node);
            } catch {
              throw new Error('node was a string but not valid JSON');
            }
          }
          return await client.patchNode(pageId, nodeId, parsedNode);
        },
      }),

      insertNode: tool({
        description:
          'Insert a ProseMirror node relative to an anchor, or append it at ' +
          'the top level. For before/after you MUST provide EXACTLY ONE of ' +
          'anchorNodeId or anchorText. Example node: a paragraph ' +
          '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]} or a ' +
          'heading {"type":"heading","attrs":{"level":2},"content":' +
          '[{"type":"text","text":"Title"}]}. Bold is a mark: ' +
          '{"type":"text","text":"x","marks":[{"type":"bold"}]}. The node arg ' +
          'may be a JSON object or a JSON string (both accepted). Reversible ' +
          'via page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          node: z
            .any()
            .describe(
              'The ProseMirror node to insert, e.g. ' +
                '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}. ' +
                'JSON object or JSON string both accepted.',
            ),
          position: z
            .enum(['before', 'after', 'append'])
            .describe('Where to insert relative to the anchor.'),
          anchorNodeId: z
            .string()
            .optional()
            .describe('Anchor block id (for before/after).'),
          anchorText: z
            .string()
            .optional()
            .describe(
              'Anchor text fragment (for before/after), matched against the ' +
                "block's literal rendered plain text (no markdown). " +
                'Markdown/emoji are tolerated as a fallback; prefer plain text ' +
                'or anchorNodeId.',
            ),
        }),
        execute: async ({
          pageId,
          node,
          position,
          anchorNodeId,
          anchorText,
        }) => {
          // Parity with the standalone MCP server (index.ts insert_node): the
          // model sometimes serializes the node as a JSON string. Parse it
          // before the client's typeof-object guard rejects it.
          let parsedNode = node;
          if (typeof node === 'string') {
            try {
              parsedNode = JSON.parse(node);
            } catch {
              throw new Error('node was a string but not valid JSON');
            }
          }
          return await client.insertNode(pageId, parsedNode, {
            position,
            anchorNodeId,
            anchorText,
          });
        },
      }),

      deleteNode: tool({
        description:
          'Remove a content BLOCK by its id (NOT a page). Reversible: the ' +
          'previous version is kept in page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          nodeId: z.string().describe('The block id to remove.'),
        }),
        execute: async ({ pageId, nodeId }) =>
          await client.deleteNode(pageId, nodeId),
      }),

      updatePageJson: tool({
        description:
          "Replace a page's body with a full ProseMirror document — a full " +
          'overwrite — and/or update its title. Minimal example content: ' +
          '{"type":"doc","content":[{"type":"paragraph","content":' +
          '[{"type":"text","text":"Hi"}]}]}. The content arg may be a JSON ' +
          'object or a JSON string (both accepted). Omit content for a ' +
          'title-only update. Reversible: the previous version is kept in page ' +
          'history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to update.'),
          content: z
            .any()
            .optional()
            .describe(
              'Full ProseMirror doc {"type":"doc","content":[...]} (JSON ' +
                'object or JSON string); omit for a title-only update.',
            ),
          title: z.string().optional().describe('Optional new title.'),
        }),
        execute: async ({ pageId, content, title }) => {
          // Parity with the standalone MCP server (index.ts update_page_json):
          // undefined/null pass through as undefined (title-only / no-op); any
          // string is JSON.parsed (so an empty string "" throws, matching the
          // MCP server); an object is passed through unchanged.
          let doc;
          if (content === undefined || content === null) {
            doc = undefined;
          } else if (typeof content === 'string') {
            try {
              doc = JSON.parse(content);
            } catch {
              throw new Error('content was a string but not valid JSON');
            }
          } else {
            doc = content;
          }
          return await client.updatePageJson(pageId, doc, title);
        },
      }),

      tableInsertRow: tool({
        description:
          'Insert a row of plain-text cells into a table. Reversible via ' +
          'page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          tableRef: z
            .string()
            .describe('"#<index>" from getOutline, or a block id in the table.'),
          cells: z.array(z.string()).describe('The cell texts for the row.'),
          index: z
            .number()
            .int()
            .optional()
            .describe('0-based insert position (omit/out-of-range to append).'),
        }),
        execute: async ({ pageId, tableRef, cells, index }) =>
          await client.tableInsertRow(pageId, tableRef, cells, index),
      }),

      tableDeleteRow: tool({
        description:
          'Delete a table row at a 0-based index. Reversible via page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          tableRef: z
            .string()
            .describe('"#<index>" from getOutline, or a block id in the table.'),
          index: z.number().int().describe('0-based row index to delete.'),
        }),
        execute: async ({ pageId, tableRef, index }) =>
          await client.tableDeleteRow(pageId, tableRef, index),
      }),

      tableUpdateCell: tool({
        description:
          'Set the plain-text content of a table cell at [row, col] (0-based). ' +
          'Reversible via page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page.'),
          tableRef: z
            .string()
            .describe('"#<index>" from getOutline, or a block id in the table.'),
          row: z.number().int().describe('0-based row index.'),
          col: z.number().int().describe('0-based column index.'),
          text: z.string().describe('The new cell text.'),
        }),
        execute: async ({ pageId, tableRef, row, col, text }) =>
          await client.tableUpdateCell(pageId, tableRef, row, col, text),
      }),

      copyPageContent: tool({
        description:
          "Replace the target page's BODY with the source page's body " +
          '(title/slug are kept). Runs server-side — no document passes ' +
          'through the model. Reversible: the target keeps page history.',
        inputSchema: z.object({
          sourcePageId: z.string().describe('The id of the source page.'),
          targetPageId: z
            .string()
            .describe('The id of the target page to overwrite.'),
        }),
        execute: async ({ sourcePageId, targetPageId }) =>
          await client.copyPageContent(sourcePageId, targetPageId),
      }),

      importPageMarkdown: tool({
        description:
          "Replace a page's body from Docmost-flavoured Markdown (as produced " +
          'by exportPageMarkdown). Reversible: the previous version is kept in ' +
          'page history.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to overwrite.'),
          markdown: z
            .string()
            .describe('Docmost-flavoured Markdown for the page body.'),
        }),
        execute: async ({ pageId, markdown }) =>
          await client.importPageMarkdown(pageId, markdown),
      }),

      sharePage: tool({
        description:
          'Make a page PUBLICLY accessible and return its public URL. ' +
          'Reversible via unsharePage. Only share when the user explicitly ' +
          'asked, since this exposes the page to anyone with the link.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to share.'),
          searchIndexing: z
            .boolean()
            .optional()
            .describe('Allow public search engines to index it (default true).'),
        }),
        execute: async ({ pageId, searchIndexing }) =>
          await client.sharePage(pageId, searchIndexing),
      }),

      unsharePage: tool({
        description:
          'Remove the public share of a page (reverses sharePage).',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to unshare.'),
        }),
        execute: async ({ pageId }) => await client.unsharePage(pageId),
      }),

      restorePageVersion: tool({
        description:
          'Restore a past version by writing its content back as the current ' +
          'page content. Itself reversible: it creates a new history snapshot.',
        inputSchema: z.object({
          historyId: z
            .string()
            .describe('The id of the history version to restore.'),
        }),
        execute: async ({ historyId }) =>
          await client.restorePageVersion(historyId),
      }),

      transformPage: tool({
        description:
          'Run a sandboxed JS transform of the form `(doc, ctx) => doc` over a ' +
          "page's ProseMirror document for complex/scripted rewrites. dryRun " +
          '(default true) previews a diff WITHOUT writing; set dryRun:false to ' +
          'apply. Reversible: applying creates a new page-history snapshot.',
        inputSchema: z.object({
          pageId: z.string().describe('The id of the page to transform.'),
          transformJs: z
            .string()
            .describe('The JS transform body: `(doc, ctx) => doc`.'),
          dryRun: z
            .boolean()
            .optional()
            .describe('Preview the diff without writing (default true).'),
        }),
        // GUARDRAIL: the schema deliberately omits `deleteComments`, and the
        // execute below NEVER passes it, so the client's comment-deletion path
        // stays unreachable from the agent.
        execute: async ({ pageId, transformJs, dryRun }) =>
          await client.transformPage(pageId, transformJs, { dryRun }),
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
