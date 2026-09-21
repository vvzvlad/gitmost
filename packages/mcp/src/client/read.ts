// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import axios, { AxiosInstance } from "axios";
import {
  filterWorkspace,
  filterSpace,
  filterPage,
  filterComment,
  filterSearchResult,
} from "../lib/filters.js";
import {
  convertProseMirrorToMarkdown,
  type ConvertProseMirrorToMarkdownOptions,
} from "../lib/markdown-converter.js";
import {
  GetPageConversionCache,
  hashConvertOptions,
} from "./getpage-cache.js";
import {
  collectInternalFileNodes,
  normalizeFileUrl,
  resolveInternalFilePath,
} from "../lib/internal-file-urls.js";
import { buildPageTree } from "../lib/tree.js";
import {
  replaceNodeById,
  replaceNodeByIdWithMany,
  reassignCollidingBlockIds,
  deleteNodeById,
  assertUnambiguousMatch,
  insertNodeRelative,
  insertNodesRelative,
  blockPlainText,
  buildOutline,
  getNodeByRef,
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
  findInvalidNode,
} from "@docmost/prosemirror-markdown";
import {
  importMarkdownFragment,
  canBeDocChild,
  findUnrepresentableTableAttrs,
} from "../lib/markdown-fragment.js";
import { searchInDoc, SearchOptions } from "../lib/page-search.js";
import {
  blockText,
  walk,
  getList,
  insertMarkerAfter,
  setCalloutRange,
  noteItem,
  mdToInlineNodes,
  commentsToFootnotes,
  canonicalizeFootnotes,
  insertInlineFootnote,
  mergeFootnoteDefinitions,
} from "../lib/transforms.js";

// Public method surface of ReadMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements IReadMixin` fails to compile on drift.
export interface IReadMixin {
  getWorkspace(): any;
  getSpaces(): any;
  listPages(spaceId?: string, limit?: number, tree?: boolean): any;
  getTree(spaceId: string, rootPageId?: string, maxDepth?: number): any;
  getPageContext(pageId: string): any;
  listSidebarPages(spaceId: string, pageId?: string): any;
  getPage(pageId: string, format?: "markdown" | "text"): any;
  getPageJson(pageId: string): any;
  getOutline(pageId: string): any;
  getNode(pageId: string, nodeId: string, format?: "markdown" | "json"): any;
  searchInPage(pageId: string, query: string, opts?: SearchOptions): any;
  getTable(pageId: string, tableRef: string): any;
  search(query: string, spaceId?: string, limit?: number, opts?: { parentPageId?: string; titleOnly?: boolean; offset?: number; match?: "auto" | "word" | "prefix" | "substring" }): any;
}

export function ReadMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & IReadMixin> & TBase {
  abstract class ReadMixin extends Base implements IReadMixin {
  async getWorkspace() {
    await this.ensureAuthenticated();
    const response = await this.client.post("/workspace/info", {});
    return {
      data: filterWorkspace(response.data?.data ?? response.data),
      success: response.data.success,
    };
  }


  async getSpaces() {
    const spaces = await this.paginateAll("/spaces", {});
    return spaces.map((space) => filterSpace(space));
  }

  /**
   * List pages in one of two modes.
   *
   * Default (`tree` false): most recent pages by updatedAt (descending),
   * bounded. Fetching the whole space can exceed MCP response/time limits on
   * large instances, so a single bounded page of results is returned (default
   * 50, max 100) via the `/pages/recent` feed.
   *
   * Tree (`tree` true): DEPRECATED — prefer `getTree`, which shares this exact
   * code path (a single `/pages/tree` request via `enumerateSpacePages` +
   * `buildPageTree`) but returns the compact `{pageId, title, children?,
   * hasChildren?}` shape and supports `rootPageId`/`maxDepth`. This tree mode is
   * kept for backward compatibility; it REQUIRES `spaceId` (a page tree is
   * scoped to one space) and IGNORES `limit` — the whole hierarchy is returned.
   * It fetches the tree via `enumerateSpacePages`, which on the fork server
   * resolves to a single `/pages/tree` request returning the whole
   * permission-filtered flat page set (soft-deleted pages excluded
   * server-side); the cursor-BFS in `enumerateSpacePages` is only a fallback for
   * stock upstream servers that lack `/pages/tree`.
   */
  async listPages(spaceId?: string, limit: number = 50, tree: boolean = false) {
    await this.ensureAuthenticated();

    if (tree) {
      if (!spaceId) {
        throw new Error(
          "listPages: tree mode requires a spaceId (a page tree is scoped to one space). Pass spaceId, or omit tree to get the recent-pages list.",
        );
      }
      // #486: propagate `truncated` (same pattern as check_new_comments). The old
      // code dropped it, so a caller handed an INCOMPLETE tree (the stdio-fallback
      // BFS hit its node cap) had no way to know pages were missing. Return the
      // tree alongside the flag; the primary /pages/tree path is uncapped so this
      // is false there.
      // #534: spaceId is required here; wrap so a bad-spaceId 404 (from the
      // /pages/tree seed inside enumerateSpacePages) becomes an actionable hint.
      return this.withSpaceAccessDiagnostics(spaceId, "listPages", async () => {
        const { pages, truncated } = await this.enumerateSpacePages(spaceId);
        return { tree: buildPageTree(pages), truncated };
      });
    }

    const clampedLimit = Math.max(1, Math.min(100, limit));
    const payload: Record<string, any> = { limit: clampedLimit, page: 1 };
    if (spaceId) payload.spaceId = spaceId;
    // #534: only the WITH-spaceId recent path can 404 on space access; wrap it so
    // that 404 is rewritten. Without a spaceId there is no space to diagnose, so
    // the wrapper is inert (run the request directly).
    const runRecent = async () => {
      const response = await this.client.post("/pages/recent", payload);
      const data = response.data;
      const items = data.data?.items || data.items || [];
      return items.map((page: any) => filterPage(page));
    };
    return spaceId
      ? this.withSpaceAccessDiagnostics(spaceId, "listPages", runRecent)
      : runRecent();
  }

  /**
   * Fetch a space's page hierarchy (or one subtree) as a nested tree in a SINGLE
   * request — the #443 `getTree` tool. Shares its whole code path with
   * `listPages(tree:true)`: `enumerateSpacePages` issues one `POST /pages/tree`
   * (with the cursor-BFS only as a fallback for stock upstream servers that lack
   * the endpoint), then `buildPageTree` nests the flat, permission-filtered,
   * position-ordered list. No second tree fetch, no per-node BFS.
   *
   *  - `rootPageId` — restrict to that page's subtree; the server seeds the CTE
   *    with the page itself, so the result is exactly ONE root (the page and its
   *    descendants). Omit it for the whole space.
   *  - `maxDepth` — trim the response to that many levels (roots = depth 1) to
   *    save tokens; the server still returns everything in one request, the cut
   *    is applied in `buildPageTree` AFTER the full tree is built. A node whose
   *    children were cut carries `hasChildren: true` (source of truth = the flat
   *    item's server `hasChildren`) so the caller can descend with a follow-up
   *    `getTree(spaceId, rootPageId=that node)` call.
   *
   * Output nodes are `{pageId, title, children?, hasChildren?}` — only the UUID
   * `pageId` is exposed (never `slugId`/`icon`/`position`). Requires `spaceId`
   * (a page tree is scoped to one space).
   */
  async getTree(spaceId: string, rootPageId?: string, maxDepth?: number) {
    await this.ensureAuthenticated();
    if (!spaceId) {
      throw new Error(
        "getTree: spaceId is required (a page tree is scoped to one space).",
      );
    }
    // #534: the 404 for a bad/inaccessible spaceId surfaces from the
    // `/pages/tree` seeding step inside enumerateSpacePages (which is NOT in a
    // try/catch of its own for that case) — wrap the whole body so it is caught
    // and rewritten into an actionable "spaceId not accessible" message. Only the
    // space membership check can 404 here (rootPageId 403/200), see the
    // wrap-allowlist invariant on withSpaceAccessDiagnostics.
    return this.withSpaceAccessDiagnostics(spaceId, "getTree", async () => {
      const { pages } = await this.enumerateSpacePages(spaceId, rootPageId);
      return buildPageTree(pages, { shape: "getTree", maxDepth });
    });
  }

  /**
   * "Where am I / what's around" for a single page — the #443 `getPageContext`
   * tool. Metadata only (no page content), using exactly TWO server requests:
   *
   *   1. `POST /pages/breadcrumbs` — a recursive CTE that walks UP from the page.
   *      The server returns the chain root->page order (it `.reverse()`s the
   *      child-first walk before responding), INCLUDING the page itself as the
   *      LAST element. So the last element is the page and everything before it
   *      is the ancestor chain root->parent. This carries the page's own title
   *      and spaceId, so no extra page-info fetch is needed for a UUID input.
   *   2. `listSidebarPages(spaceId, pageId)` — the page's DIRECT children,
   *      cursor-paginated (a page with >20 children returns ALL of them, no
   *      dupes) and in sidebar `position` order, each carrying `hasChildren`.
   *
   * The input may be a slugId (agents copy them from URLs); it is run through
   * `resolvePageId` first, exactly like the other page tools. A UUID input adds
   * no request there (short-circuit), keeping the total at two; a slugId input
   * adds one unavoidable resolve round-trip.
   *
   * INVARIANT: only the UUID `pageId` is exposed anywhere — server `id` is
   * mapped to `pageId` and `slugId` is never leaked. A nonexistent/inaccessible
   * pageId makes the server 404/403, which propagates as a clear tool error
   * (never a hollow empty object).
   */
  async getPageContext(pageId: string) {
    await this.ensureAuthenticated();

    // Resolve a possibly-slugId input to the canonical UUID (no round-trip for a
    // UUID). Errors here (bad/inaccessible id) propagate as a clear tool error.
    const pageUuid = await this.resolvePageId(pageId);

    // Request 1: the ancestor chain, root->page, page included as the LAST item.
    const response = await this.client.post("/pages/breadcrumbs", {
      pageId: pageUuid,
    });
    const chain: any[] = (response.data?.data ?? response.data) ?? [];
    if (!Array.isArray(chain) || chain.length === 0) {
      // The endpoint always includes the page itself, so an empty chain means
      // the page is gone/inaccessible — surface a clear error, not {}.
      throw new Error(`getPageContext: page "${pageId}" not found or inaccessible`);
    }

    // Split: the last element is the page, the rest (root->parent) are the
    // breadcrumbs. A root page has no ancestors -> breadcrumbs is [].
    const self = chain[chain.length - 1];
    const ancestors = chain.slice(0, -1);

    const page = {
      pageId: self.id,
      title: self.title,
      spaceId: self.spaceId,
    };
    const breadcrumbs = ancestors.map((n: any) => ({
      pageId: n.id,
      title: n.title,
    }));

    // Request 2: direct children in sidebar order, each with hasChildren.
    const childItems = await this.listSidebarPages(self.spaceId, pageUuid);
    const children = childItems.map((c: any) => ({
      pageId: c.id,
      title: c.title,
      hasChildren: Boolean(c.hasChildren),
    }));

    return { page, breadcrumbs, children };
  }

  /**
   * List sidebar pages for a space. With no pageId the request returns the
   * space ROOT pages; with a pageId it returns the direct CHILDREN of that
   * page. pageId is therefore optional and is only included in the POST body
   * when provided (an empty/undefined pageId would otherwise change the
   * semantics on the server).
   */
  async listSidebarPages(spaceId: string, pageId?: string) {
    await this.ensureAuthenticated();

    // Paginate via the server-issued cursor. The server switched from OFFSET
    // (`page`) to CURSOR (`cursor`/`nextCursor`) pagination, and the global
    // ValidationPipe(whitelist:true) SILENTLY STRIPS the obsolete `page` field
    // — so the old offset loop got the SAME first page every time (with
    // hasNextPage stuck true) and dropped every child beyond the first page.
    const MAX_PAGES = 50;
    let cursor: string | undefined;
    let allItems: any[] = [];
    let truncated = false;

    for (let i = 0; i < MAX_PAGES; i++) {
      // limit: 100 is the server-side Max; cuts request count 5x vs the default 20.
      const payload: Record<string, any> = { spaceId, limit: 100 };
      // Only send pageId when scoping to a page's children; omit it for roots.
      if (pageId) payload.pageId = pageId;
      if (cursor) payload.cursor = cursor;

      const data = (await this.client.post("/pages/sidebar-pages", payload)).data
        ?.data;
      allItems = allItems.concat(data?.items ?? []);

      // Advance strictly via the server-issued cursor; a missing/repeated cursor
      // means the protocol drifted again — stop instead of looping on page one.
      const next = data?.meta?.hasNextPage ? data?.meta?.nextCursor : null;
      if (!next || next === cursor) break;
      cursor = next;

      // Reaching the ceiling with more pages still available means the child
      // list is truncated (mirrors paginateAll).
      if (i === MAX_PAGES - 1) truncated = true;
    }

    // Warn on real truncation (ceiling hit while the server still had pages) so
    // the caller is not silently handed an incomplete child list.
    if (truncated) {
      console.warn(
        `listSidebarPages: children of "${pageId ?? spaceId}" truncated at the ${MAX_PAGES}-page cap; more pages exist on the server`,
      );
    }

    return allItems;
  }

  /**
   * Enumerate EVERY page in a space (or in a subtree, when rootPageId is given).
   *
   * Primary path (fork server): a SINGLE `POST /pages/tree` returns the whole
   * space (or a subtree) as a flat, permission-filtered list in one request, in
   * the exact node shape buildPageTree consumes. This replaces the old
   * per-node BFS, which issued N sidebar requests and — after the server moved
   * to cursor pagination — silently lost every child past the first sidebar
   * page (the obsolete `page` param was stripped by ValidationPipe).
   *
   * The subtree variant (rootPageId given) INCLUDES the root node itself
   * (getPageAndDescendants seeds with id = rootPageId), unlike the old BFS
   * which started from the root's children.
   *
   * Fallback path (stdio mode may target STOCK upstream Docmost, which lacks
   * `/pages/tree`): on a 404/405 it falls back to the cursor-based BFS below,
   * walking direct children via the fixed cursor listSidebarPages. Safeguards:
   * a `visited` Set of page ids prevents re-processing a node (cycles /
   * duplicate references), and a hard node cap bounds pathological trees so the
   * walk always terminates.
   *
   * Returns `{ pages, truncated }`. `truncated` is true ONLY when the fallback
   * BFS stopped at its MAX_NODES cap — the primary /pages/tree path is uncapped
   * and always returns the complete set, so it never reports truncation.
   */
  protected async enumerateSpacePages(
    spaceId: string,
    rootPageId?: string,
  ): Promise<{ pages: any[]; truncated: boolean }> {
    await this.ensureAuthenticated();

    // Single request replaces the whole BFS: /pages/tree returns the full
    // permission-filtered flat page set of a space (or a subtree) at once. This
    // path is uncapped, so it is never truncated.
    const payload = rootPageId ? { pageId: rootPageId } : { spaceId };
    try {
      const response = await this.client.post("/pages/tree", payload);
      const pages = (response.data?.data ?? response.data)?.items ?? [];
      return { pages, truncated: false };
    } catch (e: any) {
      // Only fall back when the endpoint is absent (stock upstream Docmost);
      // any other error is a genuine failure and must propagate.
      if (
        !axios.isAxiosError(e) ||
        (e.response?.status !== 404 && e.response?.status !== 405)
      ) {
        throw e;
      }
    }

    // Fallback: cursor-based breadth-first walk via listSidebarPages.
    const MAX_NODES = 10000;
    const result: any[] = [];
    const visited = new Set<string>();

    // Seed with the root node itself when scoping to a subtree, so its own
    // comments aren't dropped: the primary /pages/tree seeds
    // getPageAndDescendants with id = rootPageId (root included), but
    // listSidebarPages(spaceId, rootPageId) returns only the root's CHILDREN.
    // The `visited` set below prevents a double-add if the root also appears
    // among the children. getPageRaw returns a page whose id/title/spaceId are
    // exactly what buildPageTree and checkNewComments consume.
    if (rootPageId) {
      try {
        const root = await this.getPageRaw(rootPageId);
        if (root?.id) {
          result.push(root);
          visited.add(root.id);
        }
      } catch {
        // Non-fatal: if the root can't be read, fall through to children-only.
      }
    }

    // Seed the queue with the starting level (subtree children or roots).
    const queue: any[] = await this.listSidebarPages(spaceId, rootPageId);

    while (queue.length > 0 && result.length < MAX_NODES) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || !node.id) continue;

      // Skip already-seen ids to guard against cycles / duplicate references.
      if (visited.has(node.id)) continue;
      visited.add(node.id);

      result.push(node);

      if (node.hasChildren) {
        try {
          const children = await this.listSidebarPages(spaceId, node.id);
          for (const child of children) queue.push(child);
        } catch (e: any) {
          // A failure fetching one node's children must not abort the whole
          // walk: skip this branch and keep enumerating the rest.
        }
      }
    }

    // Truncated only when the cap was hit with the queue still non-empty (real
    // truncation, not a natural end at exactly MAX_NODES).
    return {
      pages: result,
      truncated: result.length >= MAX_NODES && queue.length > 0,
    };
  }

  /** Raw page info including the ProseMirror JSON content and slugId. */

  /**
   * Overridable seam over convertProseMirrorToMarkdown (issue #479). Production
   * just delegates; it exists as a method so a unit test can spy on it and
   * assert the conversion is genuinely SKIPPED on a getPage cache HIT (the whole
   * point of the cache) — an ESM named import cannot be intercepted otherwise.
   */
  protected convertPageMarkdown(
    content: any,
    options: ConvertProseMirrorToMarkdownOptions,
  ): string {
    return convertProseMirrorToMarkdown(content, options);
  }

  async getPage(pageId: string, format: "markdown" | "text" = "markdown") {
    await this.ensureAuthenticated();

    // #502 `format:"text"`: a flat, deterministic, machine-diffable rendering
    // (block-per-line, inline marks/comment anchors dropped, non-text nodes ->
    // stable placeholders like `[image]` / `[table RxC]`). The server produces
    // it via its `jsonToText` path (the SAME serializer that feeds search), so
    // there is no second serializer here — we just request it and pass the
    // string through. Distinct from the markdown default: no PM->markdown walk,
    // no markdown conversion cache, and no `{{SUBPAGES}}` substitution (the text
    // renderer emits no such placeholder). Use it to diff a page you wrote as a
    // config/prose against what was stored.
    if (format === "text") {
      // #647 §F — surface baseHash here too so a text read can also seed a write.
      const textData = await this.getPageRaw(pageId, "text", {
        includeContentHash: true,
      });
      let subpages: any[] = [];
      try {
        subpages = await this.listSidebarPages(textData.spaceId, textData.id);
      } catch (e: any) {
        console.warn("Failed to fetch subpages:", e);
      }
      const textContent =
        typeof textData.content === "string" ? textData.content : "";
      return {
        data: { ...filterPage(textData, textContent, subpages), baseHash: textData.contentHash },
        success: true,
      };
    }

    // #647 §E/§F — request the coherent contentHash. When the collab doc is
    // loaded, the server returns the LIVE content under it, so getPage reflects
    // unflushed edits (read-your-own-writes) instead of the debounce-stale DB row.
    const resultData = await this.getPageRaw(pageId, undefined, {
      includeContentHash: true,
    });

    // Agent read: hide resolved-comment anchors so the agent sees only active
    // discussions. Active anchors are kept. (The lossless exportPageMarkdown
    // round-trip deliberately does NOT pass this flag — resolved anchors there
    // must be preserved.)
    //
    // Content-addressed conversion cache (issue #479): the PM->Markdown walk is
    // the dominant cost of this hot read op. Key on the page's canonical UUID +
    // a VERSION token + a hash of the conversion options. A hit returns the cached
    // markdown and skips the walk; a miss converts and stores. The cached value is
    // the conversion output BEFORE the {{SUBPAGES}} substitution below, which uses
    // live subpage data and stays outside the cache — so the final result is
    // byte-identical to the uncached path.
    //
    // #647 refinement A — the version token is the server's `contentHash` when
    // present, NOT `updatedAt`. On the live branch the server serves fresh content
    // under a DEBOUNCE-STALE `updatedAt`, so keying by `updatedAt` would cache the
    // fresh markdown under the old key and the NEXT read (updatedAt still unmoved)
    // would hit that entry and serve stale markdown — getPage would not be RYOW.
    // `contentHash` changes exactly when the content changes, so it is the correct
    // cache-invalidation key. `updatedAt` remains the fallback for any caller/
    // server that does not surface a hash (older server, unexpected shape).
    const convertOptions = { dropResolvedCommentAnchors: true };
    let content = "";
    if (resultData.content) {
      // Prefer the content-coherent hash; fall back to updatedAt.
      const versionToken =
        typeof resultData.contentHash === "string" && resultData.contentHash
          ? resultData.contentHash
          : typeof resultData.updatedAt === "string"
            ? resultData.updatedAt
            : null;
      // Only cache when we have a stable identity+version for the key. If either
      // is missing (unexpected server shape), fall back to converting uncached
      // rather than keying on a partial tuple.
      const cacheable = typeof resultData.id === "string" && versionToken != null;
      const cacheKey = cacheable
        ? GetPageConversionCache.key(
            resultData.id,
            versionToken as string,
            hashConvertOptions(convertOptions),
          )
        : null;

      const cached = cacheKey ? this.getPageCache.get(cacheKey) : undefined;
      if (cached !== undefined) {
        content = cached;
        this.onMetricFn?.("mcp_getpage_cache_hits_total", 1);
      } else {
        // Goes through the convertPageMarkdown seam (not the raw import) so a
        // test can assert the conversion is SKIPPED on a hit (issue #479 F2).
        content = this.convertPageMarkdown(resultData.content, convertOptions);
        if (cacheKey) this.getPageCache.set(cacheKey, content);
        // A non-cacheable page (missing id/updatedAt) is still a genuine
        // conversion, so it counts as a miss for an honest hit-rate.
        this.onMetricFn?.("mcp_getpage_cache_misses_total", 1);
      }
    }

    // Always fetch subpages to provide context to the agent.
    //
    // NOT parallelizable with the page fetch (issue #479 asked to check): the
    // sidebar-pages endpoint REQUIRES spaceId in its POST body, and spaceId is
    // only known FROM this page fetch's response (resolvePageId yields the UUID
    // but never the spaceId). So `Promise.all([pageFetch, subpagesFetch])` would
    // have to invent a spaceId it does not have — the two calls are inherently
    // sequential. Correctness wins; the conversion cache above is the real speedup.
    let subpages: any[] = [];
    try {
      // `pageId` may be a slugId, but the sidebar-pages endpoint requires the
      // UUID; `resultData.id` holds the resolved UUID returned by getPageRaw.
      subpages = await this.listSidebarPages(resultData.spaceId, resultData.id);
    } catch (e: any) {
      console.warn("Failed to fetch subpages:", e);
    }

    // Resolve subpages if the placeholder exists
    if (content && content.includes("{{SUBPAGES}}")) {
      if (subpages && subpages.length > 0) {
        const list = subpages
          .map((p: any) => `- [${p.title}](page:${p.id})`)
          .join("\n");
        content = content.replace("{{SUBPAGES}}", `### Subpages\n${list}`);
      } else {
        content = content.replace("{{SUBPAGES}}", "");
      }
    }

    return {
      // #647 §F — surface the coherent contentHash as `baseHash` so the agent can
      // read → hash → write (updatePageJson / updatePageMarkdown). The in-app
      // projection in tool-specs must carry it through too (B3-crit, §14).
      data: { ...filterPage(resultData, content, subpages), baseHash: resultData.contentHash },
      success: true,
    };
  }

  /** Page info + raw ProseMirror JSON content (lossless representation). */
  async getPageJson(pageId: string) {
    // #647 §F — request the coherent contentHash and return it as `baseHash`.
    // The agent passes this opaque hash straight back to updatePageJson /
    // updatePageMarkdown; the server-side write-CAS applies the write only if the
    // page still hashes to it (else 409 → re-read + retry). Because the flag is
    // set, when the collab doc is loaded the server also returns the LIVE content
    // here (read-your-own-writes) coherently with the hash.
    const data = await this.getPageRaw(pageId, undefined, {
      includeContentHash: true,
    });
    return {
      id: data.id,
      slugId: data.slugId,
      title: data.title,
      parentPageId: data.parentPageId,
      spaceId: data.spaceId,
      updatedAt: data.updatedAt,
      content: data.content || { type: "doc", content: [] },
      // Opaque write-CAS base hash (undefined only against an older server that
      // does not surface it — updatePageJson then reports baseHash is required).
      baseHash: data.contentHash,
    };
  }

  /**
   * Fetch an INTERNAL Docmost file (authed loopback) for sandbox mirroring.
   * `src` is normalized to `/api/files/<id>/<file>`; `this.client.baseURL`
   * already ends in `/api`, so we strip the leading `/api` and request the
   * relative path with the client's Authorization header. Returns the raw bytes
   * and the response Content-Type (mime), defaulting to octet-stream.
   *
   * The fetch is size-bounded (hard 64 MiB ceiling) purely to protect memory;
   * the authoritative per-blob cap is enforced by the sandbox `put`. The path is
   * resolved via resolveInternalFilePath, which REJECTS (throws) any traversal
   * or percent-encoded src that would let an attacker-controlled `attrs.src`
   * escape `/api/files/` and reach another internal endpoint (SSRF). That throw
   * happens before this.client.get, so a malicious src is counted as a failed
   * mirror — it never reaches the network.
   */

  /**
   * Compact outline of a page's top-level blocks (no full document body).
   * Cheap way to locate sections/tables and grab block ids before drilling in
   * with getNode / patchNode / insertNode.
   */
  async getOutline(pageId: string) {
    await this.ensureAuthenticated();
    // #654 — read-your-own-writes: if this client wrote to the page within its
    // RYOW window, hint the server to serve the LIVE (acked-but-maybe-unflushed)
    // content instead of the debounce-stale DB row, then run the SAME extraction.
    const preferLive = this.shouldPreferLive(pageId);
    const data = await this.getPageRaw(pageId, undefined, { preferLive });
    const freshness = this.ryowFreshness(preferLive, data);
    return {
      pageId,
      slugId: data.slugId,
      title: data.title,
      outline: buildOutline(data.content ?? { type: "doc", content: [] }),
      ...(freshness ? { freshness } : {}),
    };
  }

  /**
   * Fetch a single block for editing by reference: a block id (block ids live on
   * paragraphs and headings; a few container nodes carry one too), or `#<index>`
   * to select a top-level block by its outline index (the only way to reach an
   * id-less block: tables, lists, quotes, dividers, callouts, images, code
   * blocks).
   *
   * `format` (#413):
   *  - `"markdown"` (DEFAULT): serialize the block via the canonical converter
   *    (`{type:"doc",content:[node]}` -> `convertProseMirrorToMarkdown`) — a read
   *    "for editing": pair it with `patchNode({markdown})` to rewrite the block.
   *    Comment anchors (`<span data-comment-id>`, INCLUDING resolved ones) are
   *    NOT stripped here (unlike getPage): losing them on write-back would
   *    orphan the thread. Returns `{ ..., format:"markdown", markdown }`.
   *  - `"json"`: return the raw ProseMirror subtree as-is (lossless; the previous
   *    default). Returns `{ ..., format:"json", node }`.
   *
   * AUTO fallback: a type that cannot be a document top-level child is NOT
   * expressible as a standalone markdown document, so a `"markdown"` request for
   * such a node transparently falls back to JSON with a `format:"json"` field. The
   * check derives from the schema's `doc` contentMatch, so it tracks the schema.
   */
  async getNode(
    pageId: string,
    nodeId: string,
    format: "markdown" | "json" = "markdown",
  ) {
    await this.ensureAuthenticated();
    // #654 — read-your-own-writes: prefer the live doc when we just wrote (below).
    const preferLive = this.shouldPreferLive(pageId);
    const data = await this.getPageRaw(pageId, undefined, { preferLive });
    const freshness = this.ryowFreshness(preferLive, data);
    const hit = getNodeByRef(
      data.content ?? { type: "doc", content: [] },
      nodeId,
    );
    if (!hit) {
      throw new Error(
        `getNode: no node found for "${nodeId}" on page ${pageId} (use a block id from getOutline, or "#<index>" for a top-level block such as a table)`,
      );
    }

    // JSON requested (or a non-top-level type that markdown cannot represent as a
    // standalone document): return the subtree verbatim.
    if (format === "json" || !canBeDocChild(hit.type)) {
      return {
        pageId,
        ref: nodeId,
        path: hit.path,
        type: hit.type,
        format: "json" as const,
        node: hit.node,
        ...(freshness ? { freshness } : {}),
      };
    }

    // Markdown: wrap the node as a one-block doc and run the canonical converter.
    // Comment anchors are DELIBERATELY preserved (converter default) so a
    // getNode(markdown) -> edit -> patchNode(markdown) round trip does not orphan
    // a comment thread; this differs from getPage, which strips them.
    const markdown = convertProseMirrorToMarkdown({
      type: "doc",
      content: [hit.node],
    });
    return {
      pageId,
      ref: nodeId,
      path: hit.path,
      type: hit.type,
      format: "markdown" as const,
      markdown,
      ...(freshness ? { freshness } : {}),
    };
  }

  /**
   * Find every occurrence of `query` on a page IN MEMORY, over the plain text of
   * each text container (reusing the same `getPageRaw` fetch as the other read
   * tools) — no server search endpoint, no whole-document round-trip through the
   * model. Returns `{ total, truncated, matches }`; each match carries a ref for
   * getNode/patchNode (the `#<index>` form resolves with getNode but NOT
   * patchNode — see SearchMatch.nodeId), plus the top-level block index and a
   * short context window used to build a unique text `selection` for
   * createComment (createComment has no nodeId param). The pure engine
   * (`searchInDoc`) owns the traversal, glue, the RE2 ReDoS-safe regex engine
   * and the empty-query / invalid-or-unsupported-regex errors.
   */
  async searchInPage(pageId: string, query: string, opts: SearchOptions = {}) {
    await this.ensureAuthenticated();
    // #654 — read-your-own-writes: prefer the live doc when we just wrote.
    const preferLive = this.shouldPreferLive(pageId);
    const data = await this.getPageRaw(pageId, undefined, { preferLive });
    const freshness = this.ryowFreshness(preferLive, data);
    const result = searchInDoc(
      data.content ?? { type: "doc", content: [] },
      query,
      opts,
    );
    return { pageId, query, ...result, ...(freshness ? { freshness } : {}) };
  }

  /**
   * Read a table as a matrix. `tableRef` is `#<index>` (from getOutline) or a
   * block id of any node inside the table. Returns the cell texts plus a
   * parallel cellIds matrix (each cell's first paragraph id, or null) so a
   * caller can patchNode a cell for rich-formatted edits. Throws when no table
   * resolves for the reference.
   */
  async getTable(pageId: string, tableRef: string) {
    await this.ensureAuthenticated();
    // #654 — read-your-own-writes: prefer the live doc when we just wrote.
    const preferLive = this.shouldPreferLive(pageId);
    const data = await this.getPageRaw(pageId, undefined, { preferLive });
    const freshness = this.ryowFreshness(preferLive, data);
    const t = readTable(data.content ?? { type: "doc", content: [] }, tableRef);
    if (!t) {
      throw new Error(
        `tableGet: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from getOutline, or a block id inside the table)`,
      );
    }
    return {
      pageId,
      table: tableRef,
      rows: t.rows,
      cols: t.cols,
      path: t.path,
      cells: t.cells,
      cellIds: t.cellIds,
      ...(freshness ? { freshness } : {}),
    };
  }

  /**
   * Insert a row of plain-text cells into a table on the LIVE collab document.
   * `tableRef` is `#<index>` or a block id inside the target table. `cells` is
   * padded to the table's column count (more cells than columns throws); `index`
   * is a 0-based insert position (omit/out-of-range to append). Throws when no
   * table resolves for the reference.
   */

  async search(
    query: string,
    spaceId?: string,
    limit?: number,
    opts: {
      parentPageId?: string;
      titleOnly?: boolean;
      offset?: number;
      match?: "auto" | "word" | "prefix" | "substring";
    } = {},
  ) {
    await this.ensureAuthenticated();
    // #529 unified engine: the query is parsed SERVER-SIDE (operators
    // "phrase"/+/-, OR default, RU+EN morphology, match=auto). We forward the RAW
    // query plus flags. `substring: true` is kept as a back-compat hint for a
    // stock upstream server (whitelist:true strips the unknown #529 fields and it
    // degrades to plain FTS — see the tool-registration comment).
    const payload: Record<string, any> = {
      query,
      spaceId,
      substring: true,
    };
    if (opts.parentPageId) payload.parentPageId = opts.parentPageId;
    if (opts.titleOnly) payload.titleOnly = true;
    if (opts.match) payload.match = opts.match;
    // Clamp an optional caller-supplied limit into the lookup range (1..50)
    // before forwarding; omit it when not provided so the server default applies.
    if (limit !== undefined) {
      payload.limit = Math.max(1, Math.min(50, limit));
    }

    if (opts.offset !== undefined) {
      payload.offset = Math.max(0, Math.floor(opts.offset));
    }

    const runSearch = async () => {
      const response = await this.client.post("/search", payload);

      // Normalize both response shapes: bare array and paginated { items: [...] }.
      const data = response.data?.data;
      const items = Array.isArray(data) ? data : data?.items || [];
      const filteredItems = items.map((item: any) => filterSearchResult(item));

      // Surface the #529 pagination envelope when present (a stock upstream has
      // none — the fields are simply undefined and the caller sees just `items`).
      const envelope = Array.isArray(data) ? undefined : data;
      return {
        items: filteredItems,
        total: envelope?.total,
        hasMore: envelope?.hasMore,
        truncatedAtCap: envelope?.truncatedAtCap,
        offset: envelope?.offset,
        success: response.data?.success || false,
      };
    };

    // #534: a search scoped to a spaceId 404s when that space is inaccessible;
    // wrap only that case so the 404 becomes an actionable hint. A workspace-wide
    // search (no spaceId) has no space to diagnose — run it directly (inert).
    return spaceId
      ? this.withSpaceAccessDiagnostics(spaceId, "search", runSearch)
      : runSearch();
  }

  }
  return ReadMixin;
}
