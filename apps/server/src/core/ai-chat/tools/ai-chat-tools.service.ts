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
  type SharedToolSpec,
} from './docmost-client.loader';
import { resolveCurrentPageResult } from './current-page.util';
import { parseNodeArg } from './parse-node-arg';

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
    // The page the user currently has open (from the request context), exposed
    // to the model via getCurrentPage. Optional and last so existing callers
    // keep compiling. Kept proxy-robust: the model can CALL for the current
    // page instead of relying on it surviving in the system prompt text.
    openedPage?: { id?: string; title?: string } | null,
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

    const { DocmostClient, sharedToolSpecs } = await loadDocmostMcp();
    const client: DocmostClientLike = new DocmostClient({
      apiUrl,
      getToken,
      getCollabToken,
    });

    // Build an ai-SDK tool from a shared, zod-agnostic spec. The spec owns the
    // canonical description + (optional) schema builder, which is invoked with
    // THIS layer's zod (v4); only the execute body is supplied per call. No-arg
    // specs (no buildShape) get an empty object schema.
    const sharedTool = (
      spec: SharedToolSpec,
      execute: Tool['execute'],
    ): Tool =>
      tool({
        description: spec.description,
        inputSchema: spec.buildShape
          ? z.object(spec.buildShape(z) as z.ZodRawShape)
          : z.object({}),
        execute,
      });

    return {
      searchPages: tool({
        description:
          'Search the wiki for pages relevant to a query. Combines exact ' +
          'keyword/identifier matching with semantic meaning and returns the ' +
          'most relevant pages with a short snippet, best match first. ' +
          "Rephrase the user's question into a focused search query (key terms " +
          'and entities), not a full sentence. If the first results look weak ' +
          'or incomplete, search again with different wording or synonyms ' +
          'before answering.',
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

          const cap = limit ?? 10;

          // Loopback REST full-text fallback. Used when AI search is not
          // configured, embedding fails, there are no accessible spaces, or the
          // hybrid query returns nothing — so keyword search always works.
          const fallback = async () => {
            // search(query, spaceId?, limit?) -> { items, success }.
            // Items are filterSearchResult(): { id, title, highlight, ... }.
            const result = await client.search(trimmed, undefined, cap);
            const items = Array.isArray(result?.items) ? result.items : [];
            // Keep the payload token-efficient: id + title + a short snippet.
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
          };

          // HYBRID path: fuse semantic (vector) + lexical (full-text) rankings
          // via RRF. Over-fetch candidates so the page-permission post-filter
          // still leaves enough results.
          const candidates = Math.min(Math.max(cap * 5, 50), 200);

          // 1) Embed the query. Unconfigured embeddings (or any embedding error)
          //    routes to the REST full-text fallback instead of erroring.
          let queryVector: number[];
          try {
            const [vec] = await this.aiService.embedTexts(workspaceId, [
              trimmed,
            ]);
            if (!vec) return await fallback();
            queryVector = vec;
          } catch (err) {
            if (!(err instanceof AiEmbeddingNotConfiguredException)) {
              // Never leak provider/key details; log generically and fall back.
              this.logger.warn(
                `searchPages embed failed: ${
                  err instanceof Error ? err.message : 'unknown error'
                }`,
              );
            }
            return await fallback();
          }

          // 2) ACCESS CONTROL: the hybrid query runs IN-PROCESS (a direct
          //    pgvector + full-text query), so unlike the loopback REST tools it
          //    does NOT get CASL for free. Scope to the spaces the user can read
          //    (member spaces + groups), mirroring SearchService.searchPage. No
          //    accessible spaces => fall back to REST (which is CASL-scoped).
          const accessibleSpaceIds =
            await this.spaceMemberRepo.getUserSpaceIds(user.id);
          if (accessibleSpaceIds.length === 0) return await fallback();

          // 3) Hybrid RRF retrieval, scoped to the workspace AND accessible
          //    spaces.
          const hits = await this.pageEmbeddingRepo.hybridSearch(
            workspaceId,
            queryVector,
            trimmed,
            accessibleSpaceIds,
            candidates,
          );
          if (hits.length === 0) return await fallback();

          // 4) Page-level permission post-filter: an accessible space does not
          //    imply every page in it is accessible (restricted pages). Mirror
          //    SearchService.searchPage's filterAccessiblePageIds pass.
          const pageIds = Array.from(new Set(hits.map((h) => h.pageId)));
          const accessibleIds =
            await this.pagePermissionRepo.filterAccessiblePageIds({
              pageIds,
              userId: user.id,
            });
          const accessibleSet = new Set(accessibleIds);

          // Keep the best (first — hits are ordered by fused score desc) chunk
          // per page, dropping any page the user cannot access, capped to `cap`.
          return selectAccessibleHits(hits, accessibleSet, cap);
        },
      }),

      getCurrentPage: tool({
        description:
          'Return the page the user is currently viewing — i.e. what "this page", ' +
          '"the current page", or "here" refers to. Returns the page id and title, ' +
          'or null if the user is not currently on a page. Call this first whenever ' +
          'the user refers to the current page without giving an explicit id.',
        inputSchema: z.object({}),
        execute: async () => resolveCurrentPageResult(openedPage),
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

      getWorkspace: sharedTool(
        sharedToolSpecs.getWorkspace,
        async () => await client.getWorkspace(),
      ),

      listSpaces: sharedTool(
        sharedToolSpecs.listSpaces,
        async () => await client.getSpaces(),
      ),

      listPages: tool({
        description:
          'List the most recent pages, optionally scoped to a single space. ' +
          'Returns a bounded list (default 50, max 100). Pass tree:true (with ' +
          "spaceId) to instead get the space's full page hierarchy as a nested tree.",
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
          tree: z
            .boolean()
            .optional()
            .describe(
              'When true, return the full page hierarchy of the given space as a nested tree (children arrays) instead of the recent-pages flat list. Requires spaceId; ignores limit.',
            ),
        }),
        execute: async ({ spaceId, limit, tree }) =>
          await client.listPages(spaceId, limit, tree),
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

      getOutline: sharedTool(
        sharedToolSpecs.getOutline,
        async ({ pageId }) => await client.getOutline(pageId),
      ),

      getPageJson: sharedTool(
        sharedToolSpecs.getPageJson,
        async ({ pageId }) => await client.getPageJson(pageId),
      ),

      getNode: sharedTool(
        sharedToolSpecs.getNode,
        async ({ pageId, nodeId }) => await client.getNode(pageId, nodeId),
      ),

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

      listShares: sharedTool(
        sharedToolSpecs.listShares,
        async () => await client.listShares(),
      ),

      listPageHistory: sharedTool(
        sharedToolSpecs.listPageHistory,
        async ({ pageId, cursor }) =>
          await client.listPageHistory(pageId, cursor),
      ),

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

      diffPageVersions: sharedTool(
        sharedToolSpecs.diffPageVersions,
        async ({ pageId, from, to }) =>
          await client.diffPageVersions(pageId, from, to),
      ),

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

      editPageText: sharedTool(
        sharedToolSpecs.editPageText,
        async ({ pageId, edits }) => await client.editPageText(pageId, edits),
      ),

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
          const parsedNode = parseNodeArg(node);
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
          const parsedNode = parseNodeArg(node);
          return await client.insertNode(pageId, parsedNode, {
            position,
            anchorNodeId,
            anchorText,
          });
        },
      }),

      deleteNode: sharedTool(
        sharedToolSpecs.deleteNode,
        async ({ pageId, nodeId }) => await client.deleteNode(pageId, nodeId),
      ),

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
          } else {
            // String -> JSON.parse (throwing on invalid); object passes through.
            doc = parseNodeArg(content, 'content was a string but not valid JSON');
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

      copyPageContent: sharedTool(
        sharedToolSpecs.copyPageContent,
        async ({ sourcePageId, targetPageId }) =>
          await client.copyPageContent(sourcePageId, targetPageId),
      ),

      importPageMarkdown: sharedTool(
        sharedToolSpecs.importPageMarkdown,
        async ({ pageId, markdown }) =>
          await client.importPageMarkdown(pageId, markdown),
      ),

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

      unsharePage: sharedTool(
        sharedToolSpecs.unsharePage,
        async ({ pageId }) => await client.unsharePage(pageId),
      ),

      restorePageVersion: sharedTool(
        sharedToolSpecs.restorePageVersion,
        async ({ historyId }) => await client.restorePageVersion(historyId),
      ),

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

/** A single hybrid-search hit: the minimal shape selectAccessibleHits needs. */
export interface SearchHitLike {
  pageId: string;
  title: string | null;
  content: string;
}

/**
 * Post-filter hybrid-search hits into the agent-facing result list. This is the
 * CASL leak guard for the in-process hybrid search: the hits come from a direct
 * pgvector + full-text query that does NOT get CASL for free, so an accessible
 * SPACE does not imply every page in it is accessible (restricted pages).
 *
 * Given `hits` (ordered by fused score desc), the `accessibleSet` of page ids
 * the user may read, and `cap`, it keeps the BEST (first) chunk per page, drops
 * any page not in `accessibleSet`, and caps the output at `cap`. Pure — no I/O.
 */
export function selectAccessibleHits(
  hits: readonly SearchHitLike[],
  accessibleSet: Set<string>,
  cap: number,
): { id: string; title: string; snippet: string }[] {
  const seen = new Set<string>();
  const results: { id: string; title: string; snippet: string }[] = [];
  for (const hit of hits) {
    if (!accessibleSet.has(hit.pageId)) continue;
    if (seen.has(hit.pageId)) continue;
    seen.add(hit.pageId);
    results.push({
      id: hit.pageId,
      title: hit.title ?? '',
      snippet: snippet(hit.content),
    });
    if (results.length >= cap) break;
  }
  return results;
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
