import { Injectable } from '@nestjs/common';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { User } from '@docmost/db/types/entity.types';
import { TokenService } from '../../auth/services/token.service';
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
  constructor(private readonly tokenService: TokenService) {}

  async forUser(
    user: User,
    sessionId: string,
    // workspaceId is accepted for symmetry with the rest of the chat pipeline
    // and to document the single-workspace assumption; the loopback client is
    // scoped by the user's JWT, not by an explicit workspace argument.
    _workspaceId: string,
  ): Promise<Record<string, Tool>> {
    const apiUrl =
      process.env.MCP_DOCMOST_API_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/api`;

    // BARE access JWT (the client adds the "Bearer " prefix and re-calls this
    // on a 401). Minted against the live session so jwt.strategy validates it
    // (§15[C1]).
    const getToken = () =>
      this.tokenService.generateAccessToken(user, sessionId);

    const { DocmostClient } = await loadDocmostMcp();
    const client: DocmostClientLike = new DocmostClient({ apiUrl, getToken });

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
