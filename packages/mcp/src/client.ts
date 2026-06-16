import FormData from "form-data";
import axios, { AxiosInstance } from "axios";
import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import {
  filterWorkspace,
  filterSpace,
  filterPage,
  filterComment,
  filterSearchResult,
} from "./lib/filters.js";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import * as Y from "yjs";
import WebSocket from "ws";
import { convertProseMirrorToMarkdown } from "./lib/markdown-converter.js";
import {
  updatePageContentRealtime,
  replacePageContent,
  markdownToProseMirror,
  mutatePageContent,
  buildCollabWsUrl,
  assertYjsEncodable,
} from "./lib/collaboration.js";
import { docmostExtensions } from "./lib/docmost-schema.js";
import {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
} from "./lib/markdown-document.js";
import {
  replaceNodeById,
  deleteNodeById,
  insertNodeRelative,
  buildOutline,
  getNodeByRef,
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
} from "./lib/node-ops.js";
import { withPageLock } from "./lib/page-lock.js";
import { applyTextEdits, TextEdit, TextEditResult } from "./lib/json-edit.js";
import { getCollabToken, performLogin } from "./lib/auth-utils.js";
import { diffDocs } from "./lib/diff.js";
import {
  blockText,
  walk,
  getList,
  insertMarkerAfter,
  setCalloutRange,
  noteItem,
  mdToInlineNodes,
  commentsToFootnotes,
} from "./lib/transforms.js";
import vm from "node:vm";

export class DocmostClient {
  private client: AxiosInstance;
  private token: string | null = null;
  private apiUrl: string;
  private email: string;
  private password: string;
  // In-flight login dedup: when the token expires, the 401 interceptor,
  // ensureAuthenticated, getCollabTokenWithReauth and the two multipart retries
  // can all call login() at once. Memoizing a single promise collapses that
  // thundering herd into ONE /auth/login request that everyone awaits.
  private loginPromise: Promise<void> | null = null;

  constructor(baseURL: string, email: string, password: string) {
    this.apiUrl = baseURL;
    this.email = email;
    this.password = password;
    this.client = axios.create({
      baseURL,
      // Default request timeout so a hung connection cannot wedge a per-page
      // lock or block the server indefinitely. Multipart uploads override this
      // with a longer per-request timeout.
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Re-authenticate transparently on a 401/403 once: the JWT authToken can
    // expire while the server is long-running, after which every cached-token
    // request would otherwise fail until a manual restart. On such a response,
    // clear the stale token, perform a fresh login, and replay the original
    // request exactly once (guarded by config._retry to avoid infinite loops;
    // the login request itself is never retried).
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const config = error.config;
        const status = error.response?.status;
        const isAuthError = status === 401 || status === 403;
        const isLoginRequest =
          typeof config?.url === "string" && config.url.includes("/auth/login");

        if (config && isAuthError && !config._retry && !isLoginRequest) {
          config._retry = true;
          // Drop the stale token + Authorization header before re-login.
          this.token = null;
          delete this.client.defaults.headers.common["Authorization"];
          try {
            await this.login();
          } catch (loginError) {
            // Re-login failed: surface the original error to the caller.
            return Promise.reject(error);
          }
          // Re-issue the original request with the freshly minted Bearer token.
          // Read it from the default header that login() just set, not from
          // this.token, to avoid a theoretical "Bearer null" if this.token was
          // cleared between login() resolving and this point.
          config.headers = config.headers || {};
          config.headers["Authorization"] =
            this.client.defaults.headers.common["Authorization"];
          return this.client.request(config);
        }

        return Promise.reject(error);
      },
    );
  }

  /** Application base URL (API URL without the /api suffix). */
  get appUrl(): string {
    return this.apiUrl.replace(/\/api\/?$/, "");
  }

  async login() {
    // Reuse an in-flight login if one is already running so concurrent callers
    // share a single /auth/login request instead of each issuing their own.
    if (!this.loginPromise) {
      this.loginPromise = performLogin(this.apiUrl, this.email, this.password)
        .then((token) => {
          this.token = token;
          this.client.defaults.headers.common["Authorization"] =
            `Bearer ${token}`;
        })
        .finally(() => {
          this.loginPromise = null;
        });
    }
    return this.loginPromise;
  }

  async ensureAuthenticated() {
    if (!this.token) {
      await this.login();
    }
  }

  /**
   * Fetch a collaboration token, transparently re-authenticating once on a
   * 401/403. getCollabToken() uses bare axios internally, so it is NOT covered
   * by this.client's response interceptor; this helper replicates that
   * behaviour for collab-token requests: ensure a token, try once, and on an
   * expired-token auth error perform a fresh login and retry exactly once.
   */
  private async getCollabTokenWithReauth(): Promise<string> {
    await this.ensureAuthenticated();
    try {
      return await getCollabToken(this.apiUrl, this.token!);
    } catch (e) {
      // getCollabToken wraps the AxiosError in a plain Error but attaches the
      // HTTP status as `.status`, so detect an auth failure via either the raw
      // AxiosError shape OR the attached status.
      const axiosStatus = axios.isAxiosError(e) ? e.response?.status : undefined;
      const attachedStatus = (e as any)?.status;
      const isAuthError =
        axiosStatus === 401 ||
        axiosStatus === 403 ||
        attachedStatus === 401 ||
        attachedStatus === 403;
      if (isAuthError) {
        await this.login();
        return await getCollabToken(this.apiUrl, this.token!);
      }
      throw e;
    }
  }

  /**
   * Connect to the collaboration websocket, read the live doc, apply
   * `transform`, write the result, and wait for the server to persist it —
   * WITHOUT acquiring the per-page lock.
   *
   * This mirrors collaboration.mutatePageContent EXCEPT that it does not call
   * withPageLock. It exists solely so replaceImage can hold ONE withPageLock
   * across its scan -> upload -> write sequence: the per-page mutex is NOT
   * reentrant, so calling the normal (self-locking) mutatePageContent inside an
   * outer withPageLock for the same pageId would deadlock. The caller MUST hold
   * the page lock for the whole operation; this helper assumes that invariant.
   *
   * `transform` receives the live ProseMirror doc and returns the NEW full doc
   * to write, or `null` to abort with no write. Errors thrown by `transform`
   * propagate to the caller.
   */
  private mutateLiveContentUnlocked(
    pageId: string,
    collabToken: string,
    transform: (liveDoc: any) => any | null,
  ): Promise<any> {
    const CONNECT_TIMEOUT_MS = 25000;
    const PERSIST_TIMEOUT_MS = 20000;
    const ydoc = new Y.Doc();
    const wsUrl = buildCollabWsUrl(this.apiUrl);

    return new Promise<any>((resolve, reject) => {
      let provider: HocuspocusProvider | undefined;
      let applied = false; // onSynced may fire again on reconnect — apply once.
      let settled = false;
      let connectionLost = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let persistTimer: ReturnType<typeof setTimeout> | undefined;
      let unsyncedHandler: ((data: { number: number }) => void) | undefined;
      let lastWrittenDoc: any;

      const cleanup = () => {
        if (connectTimer) clearTimeout(connectTimer);
        if (persistTimer) clearTimeout(persistTimer);
        if (provider) {
          if (unsyncedHandler) {
            try {
              provider.off("unsyncedChanges", unsyncedHandler);
            } catch (err) {}
          }
          try {
            provider.destroy();
          } catch (err) {}
        }
      };

      const finish = (err: Error | null, value?: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };

      connectTimer = setTimeout(() => {
        finish(new Error("Connection timeout to collaboration server"));
      }, CONNECT_TIMEOUT_MS);

      const waitForPersistence = () => {
        if (settled) return;
        if (!provider) {
          finish(new Error("collab provider gone before persistence"));
          return;
        }
        if (provider.unsyncedChanges === 0) {
          finish(null, lastWrittenDoc);
          return;
        }
        persistTimer = setTimeout(() => {
          finish(
            new Error(
              "Timeout waiting for collaboration server to persist the update",
            ),
          );
        }, PERSIST_TIMEOUT_MS);
        unsyncedHandler = (data: { number: number }) => {
          if (data.number === 0 && !connectionLost) {
            finish(null, lastWrittenDoc);
          }
        };
        provider.on("unsyncedChanges", unsyncedHandler);
      };

      provider = new HocuspocusProvider({
        url: wsUrl,
        name: `page.${pageId}`,
        document: ydoc,
        token: collabToken,
        // @ts-ignore - Required for Node.js environment
        WebSocketPolyfill: WebSocket,
        onDisconnect: () => {
          connectionLost = true;
          finish(
            new Error(
              "Collaboration connection closed before the update was persisted/synced",
            ),
          );
        },
        onClose: () => {
          connectionLost = true;
          finish(
            new Error(
              "Collaboration connection closed before the update was persisted/synced",
            ),
          );
        },
        onSynced: () => {
          if (applied || settled) return;
          applied = true;

          // CRITICAL: keep everything between reading and writing the live doc
          // synchronous (no await) so no remote update can interleave.
          let newDoc: any;
          try {
            let liveDoc = TiptapTransformer.fromYdoc(ydoc, "default");
            if (
              !liveDoc ||
              typeof liveDoc !== "object" ||
              !Array.isArray(liveDoc.content)
            ) {
              liveDoc = { type: "doc", content: [] };
            }

            newDoc = transform(liveDoc);

            if (newDoc == null) {
              // Transform aborted — write nothing, return the live doc.
              lastWrittenDoc = liveDoc;
              finish(null, liveDoc);
              return;
            }

            const tempDoc = TiptapTransformer.toYdoc(
              newDoc,
              "default",
              docmostExtensions,
            );
            const fragment = ydoc.getXmlFragment("default");
            ydoc.transact(() => {
              if (fragment.length > 0) {
                fragment.delete(0, fragment.length);
              }
              Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(tempDoc));
            });
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)));
            return;
          }

          lastWrittenDoc = newDoc;
          waitForPersistence();
        },
        onAuthenticationFailed: () => {
          finish(
            new Error("Authentication failed for collaboration connection"),
          );
        },
      });
    });
  }

  /**
   * Generic pagination handler for Docmost API endpoints
   */
  async paginateAll<T = any>(
    endpoint: string,
    basePayload: Record<string, any> = {},
    limit: number = 100,
  ): Promise<T[]> {
    await this.ensureAuthenticated();

    const clampedLimit = Math.max(1, Math.min(100, limit));

    // Hard ceiling on the number of pages to fetch: guards against a server
    // that returns a perpetually-true hasNextPage (which would otherwise loop
    // forever and accumulate duplicates).
    const MAX_PAGES = 50;

    let page = 1;
    let allItems: T[] = [];
    let hasNextPage = true;

    while (hasNextPage && page <= MAX_PAGES) {
      const response = await this.client.post(endpoint, {
        ...basePayload,
        limit: clampedLimit,
        page,
      });

      const data = response.data;
      const items = data.data?.items || data.items || [];
      const meta = data.data?.meta || data.meta;

      allItems = allItems.concat(items);

      // Stop if the page is empty or shorter than the requested size: a full
      // page worth of items is the only situation where another page can exist,
      // so this defends against a stuck hasNextPage flag in addition to it.
      if (items.length === 0 || items.length < clampedLimit) {
        break;
      }

      hasNextPage = meta?.hasNextPage || false;
      page++;
    }

    // If the loop stopped because it hit the MAX_PAGES ceiling while the server
    // still reported more results (hasNextPage true and the last page was
    // full), the result set is truncated — warn so the caller is not silently
    // handed an incomplete list.
    if (hasNextPage && page > MAX_PAGES) {
      console.warn(
        `paginateAll: results from "${endpoint}" truncated at the ${MAX_PAGES}-page cap; more pages exist on the server`,
      );
    }

    return allItems;
  }

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
   * List most recent pages (bounded). Fetching the whole space can exceed
   * MCP response/time limits on large instances, so a single bounded page
   * of results is returned (default 50, max 100).
   */
  async listPages(spaceId?: string, limit: number = 50) {
    await this.ensureAuthenticated();
    const clampedLimit = Math.max(1, Math.min(100, limit));
    const payload: Record<string, any> = { limit: clampedLimit, page: 1 };
    if (spaceId) payload.spaceId = spaceId;
    const response = await this.client.post("/pages/recent", payload);
    const data = response.data;
    const items = data.data?.items || data.items || [];
    return items.map((page: any) => filterPage(page));
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

    // Paginate: the endpoint returns server-paged children, so posting only
    // { page: 1 } silently dropped every child beyond the first page. Loop on
    // meta.hasNextPage (with a MAX_PAGES ceiling like paginateAll, guarding
    // against a stuck hasNextPage flag) and accumulate all children.
    const MAX_PAGES = 50;
    let page = 1;
    let allItems: any[] = [];
    let hasNextPage = true;

    while (hasNextPage && page <= MAX_PAGES) {
      // Only send pageId when scoping to a page's children; omit it for roots.
      const payload: Record<string, any> = { spaceId, page };
      if (pageId) payload.pageId = pageId;

      const response = await this.client.post("/pages/sidebar-pages", payload);
      const data = response.data?.data ?? response.data;
      const items = data?.items || [];
      allItems = allItems.concat(items);

      hasNextPage = data?.meta?.hasNextPage || false;
      page++;
    }

    return allItems;
  }

  /**
   * Enumerate EVERY page in a space (or in a subtree, when rootPageId is given)
   * by walking the sidebar-pages tree.
   *
   * Starting set: the children of rootPageId when provided, otherwise the
   * space root pages. From there it does an iterative breadth-first walk: each
   * node is collected, and when node.hasChildren is true its direct children
   * are fetched via listSidebarPages(spaceId, node.id) and enqueued.
   *
   * This replaces the old "/pages/recent" enumeration, which is a bounded
   * recent-activity feed (~5000 cap) and therefore misses comments on older
   * pages that were never recently touched.
   *
   * Safeguards: a `visited` Set of page ids prevents re-processing a node
   * (cycles / duplicate references), and a hard node cap bounds pathological
   * trees so the walk always terminates.
   */
  private async enumerateSpacePages(
    spaceId: string,
    rootPageId?: string,
  ): Promise<any[]> {
    const MAX_NODES = 10000;
    const result: any[] = [];
    const visited = new Set<string>();

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

    return result;
  }

  /** Raw page info including the ProseMirror JSON content and slugId. */
  async getPageRaw(pageId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/info", { pageId });
    return response.data?.data ?? response.data;
  }

  async getPage(pageId: string) {
    await this.ensureAuthenticated();
    const resultData = await this.getPageRaw(pageId);

    let content = resultData.content
      ? convertProseMirrorToMarkdown(resultData.content)
      : "";

    // Always fetch subpages to provide context to the agent
    let subpages: any[] = [];
    try {
      subpages = await this.listSidebarPages(resultData.spaceId, pageId);
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
      data: filterPage(resultData, content, subpages),
      success: true,
    };
  }

  /** Page info + raw ProseMirror JSON content (lossless representation). */
  async getPageJson(pageId: string) {
    const data = await this.getPageRaw(pageId);
    return {
      id: data.id,
      slugId: data.slugId,
      title: data.title,
      parentPageId: data.parentPageId,
      spaceId: data.spaceId,
      updatedAt: data.updatedAt,
      content: data.content || { type: "doc", content: [] },
    };
  }

  /**
   * Compact outline of a page's top-level blocks (no full document body).
   * Cheap way to locate sections/tables and grab block ids before drilling in
   * with get_node / patch_node / insert_node.
   */
  async getOutline(pageId: string) {
    await this.ensureAuthenticated();
    const data = await this.getPageRaw(pageId);
    return {
      pageId,
      slugId: data.slugId,
      title: data.title,
      outline: buildOutline(data.content ?? { type: "doc", content: [] }),
    };
  }

  /**
   * Fetch a single node's full ProseMirror subtree (lossless) by reference:
   * a block id (headings/paragraphs/callouts/images), or `#<index>` to select
   * a top-level block by its outline index (the only way to reach tables/rows/
   * cells, which carry no id).
   */
  async getNode(pageId: string, nodeId: string) {
    await this.ensureAuthenticated();
    const data = await this.getPageRaw(pageId);
    const hit = getNodeByRef(
      data.content ?? { type: "doc", content: [] },
      nodeId,
    );
    if (!hit) {
      throw new Error(
        `get_node: no node found for "${nodeId}" on page ${pageId} (use a block id from get_outline, or "#<index>" for a top-level block such as a table)`,
      );
    }
    return {
      pageId,
      ref: nodeId,
      path: hit.path,
      type: hit.type,
      node: hit.node,
    };
  }

  /**
   * Read a table as a matrix. `tableRef` is `#<index>` (from get_outline) or a
   * block id of any node inside the table. Returns the cell texts plus a
   * parallel cellIds matrix (each cell's first paragraph id, or null) so a
   * caller can patch_node a cell for rich-formatted edits. Throws when no table
   * resolves for the reference.
   */
  async getTable(pageId: string, tableRef: string) {
    await this.ensureAuthenticated();
    const data = await this.getPageRaw(pageId);
    const t = readTable(data.content ?? { type: "doc", content: [] }, tableRef);
    if (!t) {
      throw new Error(
        `table_get: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from get_outline, or a block id inside the table)`,
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
    };
  }

  /**
   * Insert a row of plain-text cells into a table on the LIVE collab document.
   * `tableRef` is `#<index>` or a block id inside the target table. `cells` is
   * padded to the table's column count (more cells than columns throws); `index`
   * is a 0-based insert position (omit/out-of-range to append). Throws when no
   * table resolves for the reference.
   */
  async tableInsertRow(
    pageId: string,
    tableRef: string,
    cells: string[],
    index?: number,
  ) {
    await this.ensureAuthenticated();
    const collabToken = await this.getCollabTokenWithReauth();

    // Track insertion in an outer var, reset per-transform, so a collab retry
    // recomputes it cleanly (mirrors insertNode's pattern).
    let inserted = false;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      inserted = false;
      const { doc: nd, inserted: ins } = insertTableRow(
        liveDoc,
        tableRef,
        cells,
        index,
      );
      inserted = ins;
      if (!inserted) return null; // table not found -> skip the write entirely
      return nd;
    });

    if (!inserted) {
      throw new Error(
        `table_insert_row: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from get_outline, or a block id inside the table)`,
      );
    }
    return { success: true, table: tableRef, inserted: true };
  }

  /**
   * Delete the row at 0-based `index` from a table on the LIVE collab document.
   * `tableRef` is `#<index>` or a block id inside the target table. The helper's
   * out-of-range and last-row errors propagate; a missing table throws here.
   */
  async tableDeleteRow(pageId: string, tableRef: string, index: number) {
    await this.ensureAuthenticated();
    const collabToken = await this.getCollabTokenWithReauth();

    let deleted = false;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      deleted = false;
      const { doc: nd, deleted: del } = deleteTableRow(liveDoc, tableRef, index);
      deleted = del;
      if (!deleted) return null; // table not found -> skip the write entirely
      return nd;
    });

    if (!deleted) {
      throw new Error(
        `table_delete_row: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from get_outline, or a block id inside the table)`,
      );
    }
    return { success: true, table: tableRef, deleted: true };
  }

  /**
   * Set the plain-text content of cell `[row, col]` (0-based) in a table on the
   * LIVE collab document, replacing the cell's content with a single text
   * paragraph (the cell's first-paragraph id is preserved). `tableRef` is
   * `#<index>` or a block id inside the target table. The helper's out-of-range
   * error propagates; a missing table throws here.
   */
  async tableUpdateCell(
    pageId: string,
    tableRef: string,
    row: number,
    col: number,
    text: string,
  ) {
    await this.ensureAuthenticated();
    const collabToken = await this.getCollabTokenWithReauth();

    let updated = false;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      updated = false;
      const { doc: nd, updated: upd } = updateTableCell(
        liveDoc,
        tableRef,
        row,
        col,
        text,
      );
      updated = upd;
      if (!updated) return null; // table not found -> skip the write entirely
      return nd;
    });

    if (!updated) {
      throw new Error(
        `table_update_cell: no table found for "${tableRef}" on page ${pageId} (use "#<index>" from get_outline, or a block id inside the table)`,
      );
    }
    return { success: true, table: tableRef, row, col };
  }

  /**
   * Create a new page with title and content.
   * Uses the /pages/import workaround (the only endpoint accepting content),
   * then moves the page and restores the exact title: the import endpoint
   * derives the title from the FILENAME and replaces spaces with
   * underscores, so we explicitly re-set it via /pages/update afterwards.
   */
  async createPage(
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
  ) {
    await this.ensureAuthenticated();

    if (parentPageId) {
      try {
        await this.getPage(parentPageId);
      } catch (e) {
        throw new Error(`Parent page with ID ${parentPageId} not found.`);
      }
    }

    // 1. Create content via Import (using multipart/form-data).
    // Build a FRESH FormData per send attempt: a FormData body is a single-use
    // stream consumed on the first send, so it cannot be replayed by
    // this.client's response interceptor (replay fails with 'socket hang up').
    // Multipart re-auth is therefore done here with bare axios and an explicit
    // one-shot 401/403 retry that rebuilds the body.
    const fileContent = Buffer.from(content, "utf-8");
    const buildForm = () => {
      const form = new FormData();
      form.append("spaceId", spaceId);
      form.append("file", fileContent, {
        filename: `${title || "import"}.md`,
        contentType: "text/markdown",
      });
      return form;
    };

    const importUrl = `${this.apiUrl}/pages/import`;
    let response;
    try {
      // Call buildForm() ONCE per attempt and reuse the instance for both
      // getHeaders() and the body so the Content-Type boundary matches the body.
      const form = buildForm();
      // Read the Authorization header from this.client's defaults (set by
      // login(), only ever deleted — never set to null) instead of building
      // `Bearer ${this.token}`: a concurrent JSON 401 can null this.token
      // mid-flight, which would otherwise produce a literal "Bearer null".
      // ensureAuthenticated() above guarantees login() ran, so the default
      // header exists here.
      response = await axios.post(importUrl, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: this.client.defaults.headers.common["Authorization"],
        },
        timeout: 60000,
      });
    } catch (error) {
      // On an expired-token auth error, re-login and retry exactly once with a
      // freshly-rebuilt FormData (the previous one was already consumed).
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        await this.login();
        const form2 = buildForm();
        response = await axios.post(importUrl, form2, {
          headers: {
            ...form2.getHeaders(),
            Authorization:
              this.client.defaults.headers.common["Authorization"],
          },
          timeout: 60000,
        });
      } else {
        throw error;
      }
    }
    const newPageId = (response.data?.data ?? response.data).id;

    // 2. Move to parent if needed
    if (parentPageId) {
      await this.movePage(newPageId, parentPageId);
    }

    // 3. Restore the exact title (import mangles spaces into underscores)
    if (title) {
      await this.client.post("/pages/update", { pageId: newPageId, title });
    }

    return this.getPage(newPageId);
  }

  /**
   * Update a page's content from markdown and optionally its title.
   * NOTE: full re-import — block ids regenerate. For surgical changes
   * use editPageText / updatePageJson instead.
   */
  async updatePage(pageId: string, content: string, title?: string) {
    await this.ensureAuthenticated();

    if (title) {
      await this.client.post("/pages/update", { pageId, title });
    }

    let collabToken = "";
    try {
      collabToken = await this.getCollabTokenWithReauth();
      await updatePageContentRealtime(pageId, content, collabToken, this.apiUrl);
    } catch (error: any) {
      // Verbose diagnostics (incl. anything that could expose a token prefix)
      // are gated behind DEBUG; the thrown Error below carries no token data.
      if (process.env.DEBUG) {
        console.error(
          "Failed to update page content via realtime collaboration:",
          error,
        );
        const tokenPreview = collabToken
          ? collabToken.substring(0, 15) + "..."
          : "null";
        console.error(`Collab token preview: ${tokenPreview}`);
      }
      throw new Error(`Failed to update page content: ${error.message}`);
    }

    return {
      success: true,
      modified: true,
      message: "Page updated successfully.",
      pageId: pageId,
    };
  }

  /**
   * Validate a URL string against a scheme allowlist for a given context.
   *
   * The markdown link path enforces safe schemes via TipTap, but the raw
   * JSON path (updatePageJson) bypasses that — so this is the sanitization
   * choke point for ProseMirror JSON written directly by the caller.
   *
   * - "link":  reject javascript:, vbscript:, data: (any scheme that can
   *            execute or smuggle script when the href is clicked).
   * - "src":   allow only http(s):, mailto:, /api/files paths, or a
   *            scheme-less relative/absolute path; reject
   *            javascript:/vbscript:/data:/file:.
   */
  private isSafeUrl(url: unknown, context: "link" | "src"): boolean {
    if (typeof url !== "string") return false;
    const trimmed = url.trim();
    if (trimmed === "") return true; // empty href/src is harmless

    // Extract a leading "scheme:" if present. A scheme must start with a
    // letter and contain only letters/digits/+/-/. before the colon. Strip
    // whitespace and ASCII control chars first so a tab/newline embedded in
    // the scheme cannot smuggle a dangerous scheme past the check.
    const cleaned = trimmed.replace(/[\s\x00-\x1f]+/g, "");
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;

    const dangerous = new Set(["javascript", "vbscript", "data", "file"]);

    if (context === "link") {
      if (scheme === null) return true; // relative/anchor link is fine
      // For links, data: is also blocked (can carry script payloads).
      return !new Set(["javascript", "vbscript", "data"]).has(scheme);
    }

    // context === "src"
    if (scheme === null) return true; // relative/absolute path (incl. /api/files)
    if (dangerous.has(scheme)) return false;
    return scheme === "http" || scheme === "https" || scheme === "mailto";
  }

  /**
   * Recursively walk a ProseMirror doc and reject any unsafe URL on a link
   * mark href or on a media node's src/url. Media nodes covered: image,
   * attachment, video, plus embed (rendered as an iframe), youtube, drawio
   * and excalidraw — all of which carry a user-controlled URL that Docmost
   * renders. Throws a clear error on the first violation. A max-depth guard
   * turns an over-deep document into a clean error instead of a RangeError
   * stack overflow.
   */
  private validateDocUrls(node: any, depth: number = 0): void {
    const MAX_DEPTH = 200;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `document nesting exceeds the maximum depth of ${MAX_DEPTH}`,
      );
    }
    if (!node || typeof node !== "object") return;

    // Link marks on text nodes: validate the href.
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark && mark.type === "link" && mark.attrs) {
          if (!this.isSafeUrl(mark.attrs.href, "link")) {
            throw new Error(
              `unsafe link href rejected: "${mark.attrs.href}"`,
            );
          }
        }
      }
    }

    // Media nodes: validate src/url against the stricter src allowlist.
    // embed renders as an iframe (highest risk); youtube/drawio/excalidraw
    // likewise carry a user-controlled URL Docmost renders, so they get the
    // same scheme check as image/attachment/video.
    if (
      node.type === "image" ||
      node.type === "attachment" ||
      node.type === "video" ||
      node.type === "embed" ||
      node.type === "youtube" ||
      node.type === "drawio" ||
      node.type === "excalidraw" ||
      node.type === "audio" ||
      node.type === "pdf"
    ) {
      const attrs = node.attrs || {};
      for (const key of ["src", "url"]) {
        if (attrs[key] != null && !this.isSafeUrl(attrs[key], "src")) {
          throw new Error(
            `unsafe ${node.type} ${key} rejected: "${attrs[key]}"`,
          );
        }
      }
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        this.validateDocUrls(child, depth + 1);
      }
    }
  }

  /**
   * Recursively validate the STRUCTURE of a ProseMirror node (reuses the
   * recursion shape of validateDocUrls). Every node must be an object with a
   * string `type`; when present, `content` must be an array, `marks` must be
   * an array of objects each with a string `type`, and a text node's `text`
   * must be a string. Throws a clear "invalid ProseMirror document" error on
   * the first violation. A max-depth guard turns an over-deep document into a
   * clean error instead of a RangeError stack overflow.
   */
  private validateDocStructure(node: any, depth: number = 0): void {
    const MAX_DEPTH = 200;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `invalid ProseMirror document: nesting exceeds the maximum depth of ${MAX_DEPTH}`,
      );
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      throw new Error(
        "invalid ProseMirror document: every node must be an object with a string `type`",
      );
    }
    if ("text" in node && node.type === "text" && typeof node.text !== "string") {
      throw new Error(
        "invalid ProseMirror document: a text node must have a string `text`",
      );
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) {
        throw new Error(
          "invalid ProseMirror document: `marks` must be an array",
        );
      }
      for (const mark of node.marks) {
        if (!mark || typeof mark !== "object" || typeof mark.type !== "string") {
          throw new Error(
            "invalid ProseMirror document: every mark must be an object with a string `type`",
          );
        }
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) {
        throw new Error(
          "invalid ProseMirror document: `content` must be an array when present",
        );
      }
      for (const child of node.content) {
        this.validateDocStructure(child, depth + 1);
      }
    }
  }

  /**
   * Replace page content with a raw ProseMirror JSON document (lossless) and/or
   * update its title. Both `doc` and `title` are optional, but at least one must
   * be supplied:
   *  - `doc` provided   -> validate + full-overwrite the body (and update the
   *                        title too when `title` is also given).
   *  - `doc` omitted, `title` given -> title-only update; the body is NOT
   *                        touched/resent (no collab write happens).
   *  - neither given    -> throws (nothing to update).
   */
  async updatePageJson(pageId: string, doc?: any, title?: string) {
    await this.ensureAuthenticated();

    // Title-only / no-op handling: when no document is supplied, do NOT write
    // the body. Update the title if one was given; otherwise there is nothing
    // to do, so fail loudly rather than silently no-op.
    if (doc == null) {
      if (!title) {
        throw new Error(
          "update_page_json: nothing to update (provide content and/or title)",
        );
      }
      await this.client.post("/pages/update", { pageId, title });
      return {
        success: true,
        modified: true,
        message: "Page title updated (content left unchanged).",
        pageId,
      };
    }

    // Validate the document shape before a full overwrite: a malformed doc
    // would otherwise silently corrupt the page (full-overwrite is the
    // documented behaviour; no optimistic-concurrency is applied here).
    if (
      typeof doc !== "object" ||
      doc.type !== "doc" ||
      !Array.isArray(doc.content)
    ) {
      throw new Error(
        'content must be a ProseMirror document ({"type":"doc","content":[...]}) ' +
          "where content is an array of nodes each having a string `type`",
      );
    }

    // Recurse the WHOLE document so a malformed nested node (e.g. a node with a
    // non-string type, a non-array content/marks, or a text node missing its
    // string text) is rejected up front rather than silently corrupting the
    // page on overwrite.
    this.validateDocStructure(doc);

    // Sanitize URLs before writing. This closes the JSON-path bypass: unlike
    // the markdown link path (which TipTap sanitizes), raw JSON could otherwise
    // inject javascript:/data: link hrefs or media srcs straight into the doc.
    this.validateDocUrls(doc);

    if (title) {
      await this.client.post("/pages/update", { pageId, title });
    }

    const collabToken = await this.getCollabTokenWithReauth();
    await replacePageContent(pageId, doc, collabToken, this.apiUrl);

    return {
      success: true,
      modified: true,
      message: "Page content replaced from ProseMirror JSON.",
      pageId,
    };
  }

  /**
   * Export a page to a single self-contained Docmost-flavoured markdown file:
   * meta block + body (with inline comment anchors + diagrams) + comment
   * threads. Lossless round-trip target; see importPageMarkdown for the inverse.
   */
  async exportPageMarkdown(pageId: string): Promise<string> {
    await this.ensureAuthenticated();
    const page = await this.getPageRaw(pageId);
    const body = page.content
      ? convertProseMirrorToMarkdown(page.content)
      : "";
    let comments: any[] = [];
    try {
      comments = await this.listComments(pageId);
    } catch (e) {
      // A comments fetch failure must not lose the body; export with [] and let
      // the caller see the (empty) comments block. Log under DEBUG only.
      if (process.env.DEBUG) console.error("export: listComments failed", e);
    }
    const meta = {
      version: 1,
      pageId: page.id,
      slugId: page.slugId,
      title: page.title,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId ?? null,
    };
    return serializeDocmostMarkdown(meta, body, comments);
  }

  /**
   * Import a self-contained Docmost markdown file back into a page. Parses out
   * the meta + comments metadata blocks, converts the body to ProseMirror
   * (restoring comment marks + diagrams from their inline HTML), and replaces
   * the page content. Comment THREAD records are NOT written to the server in
   * this version — they are preserved in the file and the inline marks are
   * re-applied so the highlights survive; managing comment records stays with
   * the comment tools/UI.
   */
  async importPageMarkdown(pageId: string, fullMarkdown: string): Promise<any> {
    await this.ensureAuthenticated();
    const { meta, body, comments } = parseDocmostMarkdown(fullMarkdown);
    const doc = await markdownToProseMirror(body);
    const collabToken = await this.getCollabTokenWithReauth();
    await replacePageContent(pageId, doc, collabToken, this.apiUrl);
    // Collect distinct comment ids that actually became comment marks in the doc.
    const collectCommentIds = (node: any, acc: Set<string>): Set<string> => {
      if (!node || typeof node !== "object") return acc;
      if (Array.isArray(node.marks)) {
        for (const mk of node.marks) {
          if (mk && mk.type === "comment" && mk.attrs?.commentId) {
            acc.add(mk.attrs.commentId);
          }
        }
      }
      if (Array.isArray(node.content)) {
        for (const child of node.content) collectCommentIds(child, acc);
      }
      return acc;
    };
    // Count reflects the comment marks present in the written document, so an id
    // that only appears as inert text (e.g. inside a fenced code block) is not
    // counted because it never becomes a comment mark.
    const anchoredIds = collectCommentIds(doc, new Set<string>());
    const result: any = {
      success: true,
      pageId,
      anchoredCommentCount: anchoredIds.size,
      commentsInFile: Array.isArray(comments) ? comments.length : 0,
    };
    // Warn (non-fatal) if the file was exported from a DIFFERENT page.
    if (meta?.pageId && meta.pageId !== pageId) {
      result.warning = `File was exported from page ${meta.pageId} but is being imported into ${pageId}.`;
    }
    return result;
  }

  /**
   * Rename a page (change its title only) without touching or resending its
   * content. The slug is derived from the page record, not the body, so it is
   * left intact too.
   */
  async renamePage(pageId: string, title: string) {
    await this.ensureAuthenticated();
    await this.client.post("/pages/update", { pageId, title });
    return { success: true, pageId, title };
  }

  /**
   * Copy the WHOLE content of one page onto another, entirely server-side: the
   * source's ProseMirror document is read and written verbatim onto the target
   * via the live collab path, so the document never passes through the model.
   *
   * Only the target's BODY is replaced — its title and slug live on the page
   * record (not in the content), so they are untouched. The source page is not
   * modified at all.
   */
  async copyPageContent(sourcePageId: string, targetPageId: string) {
    await this.ensureAuthenticated();

    // A self-copy would be a no-op overwrite; reject it explicitly so a caller
    // mistake surfaces as a clear error rather than a silent round-trip.
    if (sourcePageId === targetPageId) {
      throw new Error(
        "copy_page_content: sourcePageId and targetPageId are the same page (no-op copy)",
      );
    }

    const source = await this.getPageRaw(sourcePageId);
    const content = source?.content;
    if (
      !content ||
      typeof content !== "object" ||
      content.type !== "doc" ||
      !Array.isArray(content.content)
    ) {
      throw new Error(
        `copy_page_content: source page ${sourcePageId} has no usable ProseMirror content to copy`,
      );
    }

    // Defense-in-depth: run the same URL-scheme sanitizer the JSON write path
    // uses, so copying never lands a javascript:/data: href/src on the target
    // (parity with updatePageJson; harmless for already-stored source content).
    this.validateDocUrls(content);

    const collabToken = await this.getCollabTokenWithReauth();
    await replacePageContent(targetPageId, content, collabToken, this.apiUrl);

    return {
      success: true,
      sourcePageId,
      targetPageId,
      copiedNodes: content.content.length,
    };
  }

  /**
   * Surgical text edits: find/replace inside text nodes of the live
   * document. Preserves all block ids, marks, callouts and tables.
   */
  async editPageText(pageId: string, edits: TextEdit[]) {
    await this.ensureAuthenticated();

    const collabToken = await this.getCollabTokenWithReauth();

    // Apply the edits against the LIVE synced document, not the debounced REST
    // snapshot, so concurrent human edits/comments are preserved. applyTextEdits
    // throws descriptive errors on zero/multiple matches — let them propagate.
    let results: TextEditResult[] | undefined;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      const r = applyTextEdits(liveDoc, edits);
      results = r.results;
      return r.doc;
    });

    return {
      success: true,
      pageId,
      edits: results,
      message: "Text edits applied (node ids and formatting preserved).",
    };
  }

  /**
   * Replace EVERY node whose attrs.id === nodeId (recursively, including nodes
   * nested in callouts/tables) with the supplied node. Operates on the LIVE
   * collab document so comments and concurrent edits are preserved.
   *
   * The replacement node's block id is preserved: if node.attrs is missing it
   * is created, and if node.attrs.id is missing it is set to nodeId so the
   * replacement keeps the same id it replaced. Throws if no node matches.
   */
  async patchNode(pageId: string, nodeId: string, node: any) {
    await this.ensureAuthenticated();

    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      throw new Error(
        "patch_node: `node` must be an object with a string `type`",
      );
    }
    // Preserve the block id WITHOUT mutating the caller's object: build a local
    // copy whose attrs.id === nodeId (so the swapped-in node keeps the id of the
    // node it replaces).
    const target = {
      ...node,
      attrs: {
        ...(node.attrs && typeof node.attrs === "object" ? node.attrs : {}),
      },
    };
    if (target.attrs.id == null) {
      target.attrs.id = nodeId;
    }

    const collabToken = await this.getCollabTokenWithReauth();

    // Track the replacement count in an outer var, reset per-transform, so a
    // collab retry recomputes it cleanly (mirrors replaceImage's pattern).
    let replaced = 0;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      replaced = 0;
      const { doc: nd, replaced: r } = replaceNodeById(liveDoc, nodeId, target);
      replaced = r;
      if (replaced === 0) return null; // no match -> skip the write entirely
      return nd;
    });

    if (replaced === 0) {
      throw new Error(
        `patch_node: no node with id "${nodeId}" found on page ${pageId}`,
      );
    }

    return { success: true, replaced, nodeId };
  }

  /**
   * Insert a node relative to an anchor (or append it at the top level).
   * Operates on the LIVE collab document so comments and concurrent edits are
   * preserved.
   *
   * opts.position:
   *  - "append": push the node at the end of the top-level content.
   *  - "before"/"after": insert the node as a sibling of the anchor, just
   *    before/after it. Exactly one of anchorNodeId / anchorText must be given;
   *    anchorNodeId locates a node anywhere by attrs.id, anchorText matches the
   *    first top-level block whose plain text includes it.
   *
   * Throws if the anchor cannot be found.
   */
  async insertNode(
    pageId: string,
    node: any,
    opts: {
      position: "before" | "after" | "append";
      anchorNodeId?: string;
      anchorText?: string;
    },
  ) {
    await this.ensureAuthenticated();

    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      throw new Error(
        "insert_node: `node` must be an object with a string `type`",
      );
    }
    if (
      !opts ||
      (opts.position !== "before" &&
        opts.position !== "after" &&
        opts.position !== "append")
    ) {
      throw new Error(
        'insert_node: `position` must be one of "before", "after", "append"',
      );
    }
    if (opts.position === "before" || opts.position === "after") {
      // before/after require EXACTLY ONE anchor (an id or a text fragment).
      const hasId =
        typeof opts.anchorNodeId === "string" && opts.anchorNodeId.length > 0;
      const hasText =
        typeof opts.anchorText === "string" && opts.anchorText.length > 0;
      if (hasId === hasText) {
        throw new Error(
          `insert_node: position "${opts.position}" requires exactly one of anchorNodeId or anchorText`,
        );
      }
    }

    const collabToken = await this.getCollabTokenWithReauth();

    // Track insertion in an outer var, reset per-transform, so a collab retry
    // recomputes it cleanly (mirrors replaceImage's pattern).
    let inserted = false;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      inserted = false;
      const { doc: nd, inserted: ins } = insertNodeRelative(liveDoc, node, opts);
      inserted = ins;
      if (!inserted) return null; // anchor not found -> skip the write entirely
      return nd;
    });

    if (!inserted) {
      const anchorDesc = opts.anchorNodeId
        ? `anchorNodeId "${opts.anchorNodeId}"`
        : `anchorText "${opts.anchorText}"`;
      throw new Error(
        `insert_node: anchor not found (${anchorDesc}) on page ${pageId}`,
      );
    }

    return { success: true, inserted: true, position: opts.position };
  }

  /**
   * Remove EVERY node whose attrs.id === nodeId (recursively, including nodes
   * nested in callouts/tables) from its parent content array. Operates on the
   * LIVE collab document so comments and concurrent edits are preserved.
   * Throws if no node matches.
   */
  async deleteNode(pageId: string, nodeId: string) {
    await this.ensureAuthenticated();

    const collabToken = await this.getCollabTokenWithReauth();

    // Track the deletion count in an outer var, reset per-transform, so a
    // collab retry recomputes it cleanly (mirrors replaceImage's pattern).
    let deleted = 0;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      deleted = 0;
      const { doc: nd, deleted: d } = deleteNodeById(liveDoc, nodeId);
      deleted = d;
      if (deleted === 0) return null; // no match -> skip the write entirely
      return nd;
    });

    if (deleted === 0) {
      throw new Error(
        `delete_node: no node with id "${nodeId}" found on page ${pageId}`,
      );
    }

    return { success: true, deleted, nodeId };
  }

  /** Build the public share URL for a page. */
  private shareUrl(shareKey: string, slugId: string): string {
    return `${this.appUrl}/share/${shareKey}/p/${slugId}`;
  }

  /** Share a page publicly (idempotent) and return the public URL. */
  async sharePage(pageId: string, searchIndexing: boolean = true) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/shares/create", {
      pageId,
      includeSubPages: false,
      searchIndexing,
    });
    const share = response.data?.data ?? response.data;
    const slugId = share.page?.slugId || (await this.getPageRaw(pageId)).slugId;
    return {
      shareId: share.id,
      key: share.key,
      pageId: share.pageId,
      publicUrl: this.shareUrl(share.key, slugId),
      searchIndexing: share.searchIndexing,
    };
  }

  /** List all public shares in the workspace with their URLs. */
  async listShares() {
    const shares = await this.paginateAll("/shares", {});
    return shares.map((s: any) => ({
      shareId: s.id,
      key: s.key,
      pageId: s.pageId,
      pageTitle: s.page?.title,
      publicUrl: s.page?.slugId ? this.shareUrl(s.key, s.page.slugId) : null,
      searchIndexing: s.searchIndexing,
      createdAt: s.createdAt,
    }));
  }

  /** Remove the public share of a page. */
  async unsharePage(pageId: string) {
    await this.ensureAuthenticated();
    const shares = await this.listShares();
    const share = shares.find((s: any) => s.pageId === pageId);
    if (!share) {
      throw new Error(`Page ${pageId} is not shared.`);
    }
    await this.client.post("/shares/delete", { shareId: share.shareId });
    return { success: true, removedShareId: share.shareId, pageId };
  }

  async search(query: string, spaceId?: string, limit?: number) {
    await this.ensureAuthenticated();
    const payload: Record<string, any> = { query, spaceId };
    // Clamp an optional caller-supplied limit into a sane 1..100 range before
    // forwarding it to the server; omit it entirely when not provided so the
    // server applies its own default.
    if (limit !== undefined) {
      payload.limit = Math.max(1, Math.min(100, limit));
    }
    const response = await this.client.post("/search", payload);

    // Normalize both response shapes: bare array and paginated { items: [...] }
    const data = response.data?.data;
    const items = Array.isArray(data) ? data : data?.items || [];
    const filteredItems = items.map((item: any) => filterSearchResult(item));

    return {
      items: filteredItems,
      success: response.data?.success || false,
    };
  }

  async movePage(
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ) {
    await this.ensureAuthenticated();
    // Docmost requires position >= 5 chars.
    const validPosition = position || "a00000";

    return this.client
      .post("/pages/move", {
        pageId,
        parentPageId,
        position: validPosition,
      })
      .then((res) => res.data);
  }

  async deletePage(pageId: string) {
    await this.ensureAuthenticated();
    return this.client
      .post("/pages/delete", { pageId })
      .then((res) => res.data);
  }

  // --- Comment methods (ported from upstream PR #3 by Max Nikitin) ---

  /**
   * Normalize a comment's `content` into a ProseMirror doc object before
   * markdown conversion. createComment/updateComment send content as a
   * JSON.stringify(...) STRING, and the server stores it as-is, so on read it
   * comes back as a string. convertProseMirrorToMarkdown returns "" for a
   * string, so parse it first (guarded — fall back to the raw value on any
   * parse failure so a non-JSON legacy value is still handled gracefully).
   */
  private parseCommentContent(content: any): any {
    if (typeof content !== "string") return content;
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  /** List all comments on a page (cursor-paginated), content as markdown. */
  async listComments(pageId: string) {
    await this.ensureAuthenticated();
    let allComments: any[] = [];
    let cursor: string | null = null;

    do {
      const payload: Record<string, any> = { pageId, limit: 100 };
      if (cursor) payload.cursor = cursor;

      const response = await this.client.post("/comments", payload);
      const data = response.data.data || response.data;
      const items = data.items || [];
      allComments = allComments.concat(items);
      cursor = data.meta?.nextCursor || null;
    } while (cursor);

    return allComments.map((comment: any) => {
      const markdown = comment.content
        ? convertProseMirrorToMarkdown(
            this.parseCommentContent(comment.content),
          )
        : "";
      return filterComment(comment, markdown);
    });
  }

  async getComment(commentId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments/info", { commentId });
    const comment = response.data.data || response.data;
    const markdown = comment.content
      ? convertProseMirrorToMarkdown(this.parseCommentContent(comment.content))
      : "";
    return {
      data: filterComment(comment, markdown),
      success: true,
    };
  }

  /** Create a page-level or inline comment; content is markdown. */
  async createComment(
    pageId: string,
    content: string,
    type: "page" | "inline" = "page",
    selection?: string,
    parentCommentId?: string,
  ) {
    await this.ensureAuthenticated();
    // Convert through the full Docmost schema (consistent with page paths)
    const jsonContent = await markdownToProseMirror(content);
    const payload: Record<string, any> = {
      pageId,
      content: JSON.stringify(jsonContent),
      type,
    };
    if (selection) payload.selection = selection;
    if (parentCommentId) payload.parentCommentId = parentCommentId;

    const response = await this.client.post("/comments/create", payload);
    const comment = response.data.data || response.data;
    const markdown = comment.content
      ? convertProseMirrorToMarkdown(this.parseCommentContent(comment.content))
      : content;
    const result: any = {
      data: filterComment(comment, markdown),
      success: true,
    };

    // Anchor the comment in the document. The /comments/create API records the
    // comment + its `selection` text, but it does NOT insert the comment MARK
    // into the page content, so without this the inline comment has no
    // highlight/anchor and is not clickable. Only top-level inline comments are
    // anchored: replies (parentCommentId set) inherit their parent's anchor,
    // and page-type comments have no text range.
    if (type === "inline" && selection && !parentCommentId && comment?.id) {
      const newCommentId: string = comment.id;
      let anchored = false;
      try {
        const collabToken = await this.getCollabTokenWithReauth();
        await mutatePageContent(
          pageId,
          collabToken,
          this.apiUrl,
          (liveDoc) => {
            const doc =
              liveDoc && liveDoc.type === "doc"
                ? liveDoc
                : { type: "doc", content: [] };

            // Find the FIRST text node containing the selection text, then
            // split it into before / marked / after, copying the node's
            // existing marks onto all three parts and adding the comment mark
            // only to the middle part. Returns true once a match is wrapped.
            const wrapInFirstMatch = (
              nodes: any[],
              depth: number,
            ): boolean => {
              const MAX_DEPTH = 200;
              if (depth > MAX_DEPTH || !Array.isArray(nodes)) return false;
              for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (!n || typeof n !== "object") continue;
                if (
                  n.type === "text" &&
                  typeof n.text === "string" &&
                  n.text.includes(selection)
                ) {
                  const idx = n.text.indexOf(selection);
                  const before = n.text.slice(0, idx);
                  const middleText = selection;
                  const after = n.text.slice(idx + selection.length);
                  const baseMarks = Array.isArray(n.marks) ? n.marks : [];
                  // Drop any pre-existing comment mark from the marks applied to
                  // the middle fragment so it ends up with exactly one comment
                  // mark (the new one) rather than two. Other fragments and the
                  // base marks list are left untouched.
                  const middleBaseMarks = baseMarks.filter(
                    (m: any) => !(m && m.type === "comment"),
                  );
                  const commentMark = {
                    type: "comment",
                    // The comment mark schema declares both commentId and
                    // resolved; include resolved:false for completeness.
                    attrs: { commentId: newCommentId, resolved: false },
                  };
                  const parts: any[] = [];
                  if (before.length > 0) {
                    parts.push({ ...n, text: before, marks: [...baseMarks] });
                  }
                  parts.push({
                    ...n,
                    text: middleText,
                    marks: [...middleBaseMarks, commentMark],
                  });
                  if (after.length > 0) {
                    parts.push({ ...n, text: after, marks: [...baseMarks] });
                  }
                  nodes.splice(i, 1, ...parts);
                  return true;
                }
                if (Array.isArray(n.content)) {
                  if (wrapInFirstMatch(n.content, depth + 1)) return true;
                }
              }
              return false;
            };

            if (Array.isArray(doc.content) && wrapInFirstMatch(doc.content, 0)) {
              anchored = true;
              return doc;
            }
            // Selection text not found: do NOT fail (the comment already
            // exists). Abort the write so nothing changes.
            return null;
          },
        );
      } catch (e) {
        // The comment record already exists; an anchoring failure must not turn
        // a successful create into an error. Report anchored:false instead.
        if (process.env.DEBUG) {
          console.error("Failed to anchor inline comment mark:", e);
        }
        anchored = false;
      }
      result.anchored = anchored;
    }

    return result;
  }

  async updateComment(commentId: string, content: string) {
    await this.ensureAuthenticated();
    const jsonContent = await markdownToProseMirror(content);
    await this.client.post("/comments/update", {
      commentId,
      content: JSON.stringify(jsonContent),
    });
    return {
      success: true,
      commentId,
      message: "Comment updated successfully.",
    };
  }

  async deleteComment(commentId: string) {
    await this.ensureAuthenticated();
    return this.client
      .post("/comments/delete", { commentId })
      .then((res) => res.data);
  }

  /**
   * Check for new comments across pages in a space (optionally scoped to a
   * subtree): pages updated after `since` are scanned and their comments
   * filtered by createdAt > since.
   */
  async checkNewComments(spaceId: string, since: string, parentPageId?: string) {
    await this.ensureAuthenticated();

    const sinceDate = new Date(since);

    // Reject an unparseable `since`: comparing against an Invalid Date silently
    // yields zero new comments (every `>` against NaN is false), which would
    // mask a malformed input as "nothing new" instead of erroring.
    if (Number.isNaN(sinceDate.getTime())) {
      throw new Error(
        `checkNewComments: invalid "since" date "${since}"; expected an ISO-8601 timestamp`,
      );
    }

    // 1. Enumerate the FULL set of pages in scope by walking the sidebar-pages
    // tree (a complete page index), NOT the bounded "/pages/recent" feed which
    // caps at ~5000 recent items and silently misses comments on older pages.
    //
    // Subtree scope: when parentPageId is given, the scope is that page ITSELF
    // plus every descendant (enumerateSpacePages walks its children). Otherwise
    // the scope is the whole space (all roots and their descendants).
    //
    // NOTE: do NOT pre-filter by page.updatedAt — creating a comment does not
    // bump it (verified on a live server), so such a filter silently misses
    // comments on pages that were not otherwise edited. The complete tree walk
    // already restricts the scope correctly, so no recent-feed allow-list is
    // needed any more.
    let pagesInScope: any[];
    if (parentPageId) {
      const subtree = await this.enumerateSpacePages(spaceId, parentPageId);
      // Include the parent page node itself alongside its descendants. Fetch it
      // so its title/id are available even though it is not returned by its own
      // children listing.
      let parentNode: any = { id: parentPageId };
      try {
        parentNode = await this.getPageRaw(parentPageId);
      } catch (e: any) {
        // Fall back to a minimal node if the parent can't be fetched; its
        // comments are still attempted below (the fetch there is non-fatal).
      }
      pagesInScope = [parentNode, ...subtree];
    } else {
      pagesInScope = await this.enumerateSpacePages(spaceId);
    }

    // 2. Fetch comments for each page, keep ones created after since
    const results: any[] = [];
    for (const page of pagesInScope) {
      try {
        const comments = await this.listComments(page.id);
        const newComments = comments.filter(
          (c: any) => new Date(c.createdAt) > sinceDate,
        );
        if (newComments.length > 0) {
          results.push({
            pageId: page.id,
            pageTitle: page.title,
            comments: newComments,
          });
        }
      } catch (e: any) {
        // Skip pages with errors (e.g. deleted between calls)
      }
    }

    const totalNewComments = results.reduce(
      (sum, r) => sum + r.comments.length,
      0,
    );

    // enumerateSpacePages caps traversal at 10000 nodes; flag when that cap was
    // hit so the caller knows the scan may be incomplete (some pages skipped).
    const truncated = pagesInScope.length >= 10000;

    return {
      since,
      scope: parentPageId ? `subtree of ${parentPageId}` : `space ${spaceId}`,
      checkedPages: pagesInScope.length,
      pagesWithNewComments: results.length,
      totalNewComments,
      truncated,
      comments: results,
    };
  }

  // --- Image upload / embedding ---

  /** Map a file extension to a supported image MIME type (throws otherwise). */
  private imageMimeFromPath(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };
    const mime = map[ext];
    if (!mime) {
      throw new Error(
        `unsupported image type ${ext || "(none)"}; supported: png, jpg, jpeg, gif, webp, svg`,
      );
    }
    return mime;
  }

  /** Build a Docmost ProseMirror image node from an uploaded attachment. */
  private buildImageNode(
    att: { id: string; fileName: string; fileSize?: number },
    align?: "left" | "center" | "right",
    alt?: string,
  ): any {
    // Clean file URL, matching Docmost's native behaviour. No cache-busting
    // query: the server serves the bare URL correctly, and replacement creates
    // a new attachment id (a new URL) which busts caches naturally.
    const src = `/api/files/${att.id}/${att.fileName}`;
    const node: any = {
      type: "image",
      attrs: {
        src,
        attachmentId: att.id,
        // Default to null when the server omits fileSize so the attr is never
        // undefined (undefined would be dropped on serialization / break the
        // ProseMirror image schema which expects size present).
        size: att.fileSize ?? null,
        align: align || "center",
        width: null,
      },
    };
    if (alt) node.attrs.alt = alt;
    return node;
  }

  /**
   * Upload a local image file as an attachment of a page and return the
   * attachment metadata plus a ready-to-insert ProseMirror image node.
   */
  async uploadImage(pageId: string, filePath: string) {
    await this.ensureAuthenticated();

    // HOST-FS TRUST BOUNDARY: filePath comes from the MCP caller and points at
    // the server host's local filesystem, so it must be validated BEFORE any
    // bytes are read. Without these guards a caller could (a) read an arbitrary
    // file via path traversal, (b) follow a symlink to a sensitive target, or
    // (c) exhaust memory by reading a huge file. Order matters: validate the
    // extension, then stat (regular-file + size cap), and only then read.

    // (a) Extension allowlist first — cheap, and rejects non-images up front.
    const mime = this.imageMimeFromPath(filePath);

    // (b) Stat the path: it must be a regular file (rejects directories, FIFOs,
    // devices, sockets) and stay under the size cap. statSync follows symlinks,
    // so a symlink is only accepted when its TARGET is a regular file within
    // the cap — the intended behaviour for a local image path.
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB
    let stat;
    try {
      stat = statSync(filePath);
    } catch (e: any) {
      throw new Error(`Cannot stat image file at "${filePath}": ${e.message}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: "${filePath}"`);
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image too large: ${stat.size} bytes exceeds the ${MAX_IMAGE_BYTES}-byte cap`,
      );
    }

    // (c) Only now read the bytes.
    let fileBuffer: Buffer;
    try {
      fileBuffer = readFileSync(filePath);
    } catch (e: any) {
      throw new Error(`Cannot read image file at "${filePath}": ${e.message}`);
    }

    // Build a FRESH FormData for every send attempt. A FormData body is a
    // single-use stream that is CONSUMED on the first send, so it cannot be
    // replayed by this.client's response interceptor (replaying a consumed
    // stream fails with 'socket hang up'). Multipart re-auth is therefore done
    // here with bare axios and an explicit one-shot 401/403 retry that rebuilds
    // the body. Field order matters: text fields must precede the file part so
    // the server reads them; the server always generates a fresh attachment id.
    const buildForm = () => {
      const form = new FormData();
      form.append("pageId", pageId);
      form.append("file", fileBuffer, {
        filename: basename(filePath),
        contentType: mime,
      });
      return form;
    };

    const url = `${this.apiUrl}/files/upload`;
    let response;
    try {
      // Call buildForm() ONCE per attempt and reuse the instance for both
      // getHeaders() and the body so the Content-Type boundary matches the body.
      const form = buildForm();
      // Read the Authorization header from this.client's defaults (set by
      // login(), only ever deleted — never set to null) instead of building
      // `Bearer ${this.token}`: a concurrent JSON 401 can null this.token
      // mid-flight, which would otherwise produce a literal "Bearer null".
      // ensureAuthenticated() above guarantees login() ran, so the default
      // header exists here. A 60s timeout keeps a hung upload from wedging the
      // per-page lock (replaceImage holds withPageLock across this call).
      response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: this.client.defaults.headers.common["Authorization"],
        },
        timeout: 60000,
      });
    } catch (error) {
      // On an expired-token auth error, re-login and retry exactly once with a
      // freshly-rebuilt FormData (the previous one was already consumed).
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        await this.login();
        const form2 = buildForm();
        response = await axios.post(url, form2, {
          headers: {
            ...form2.getHeaders(),
            Authorization:
              this.client.defaults.headers.common["Authorization"],
          },
          timeout: 60000,
        });
      } else if (axios.isAxiosError(error)) {
        // Keep the thrown message free of the raw response body (it may echo
        // request data or server internals); surface only status/statusText.
        // The full body is logged under DEBUG for diagnostics.
        if (process.env.DEBUG) {
          console.error(
            "Image upload failed; response body:",
            JSON.stringify(error.response?.data),
          );
        }
        throw new Error(
          `Image upload failed: ${error.response?.status} ${error.response?.statusText}`,
        );
      } else {
        throw error;
      }
    }
    // The attachment may arrive bare or wrapped in a { data } envelope.
    const att = response.data?.data ?? response.data;
    if (!att?.id || !att?.fileName) {
      throw new Error(
        "Unexpected /files/upload response: " + JSON.stringify(response.data),
      );
    }

    // Some Docmost versions omit fileSize from the upload response. Fall back
    // to the local stat size (the bytes we just uploaded) so callers never get
    // an undefined size.
    const localSize = stat.size;
    const resolvedSize = att.fileSize ?? localSize;

    return {
      attachmentId: att.id,
      fileName: att.fileName,
      fileSize: resolvedSize,
      src: `/api/files/${att.id}/${att.fileName}`,
      imageNode: this.buildImageNode({ ...att, fileSize: resolvedSize }),
    };
  }

  /**
   * Upload a local image and insert it into a page in one step.
   * By default the image is appended at the end. With replaceText, the first
   * top-level block whose text contains the string is replaced; with afterText,
   * the image is inserted right after the first matching block. All other
   * block ids are preserved (only one top-level block is added or swapped).
   */
  async insertImage(
    pageId: string,
    filePath: string,
    opts: {
      align?: "left" | "center" | "right";
      alt?: string;
      replaceText?: string;
      afterText?: string;
    } = {},
  ) {
    const up = await this.uploadImage(pageId, filePath);
    // Reuse the node from uploadImage (clean /api/files/<id>/<file> src), then
    // apply align/alt onto a shallow attrs copy.
    const node: any = { ...up.imageNode, attrs: { ...up.imageNode.attrs } };
    if (opts.align) node.attrs.align = opts.align;
    if (opts.alt) node.attrs.alt = opts.alt;

    const collabToken = await this.getCollabTokenWithReauth();

    // Recursively collect the plain text of a top-level block.
    const blockText = (n: any): string => {
      let out = "";
      if (n.type === "text") out += n.text || "";
      for (const child of n.content || []) out += blockText(child);
      return out;
    };

    // Insert into the LIVE synced document, not the debounced REST snapshot, so
    // concurrent edits/comments/images are preserved and parallel insert_image
    // calls (serialized by the per-page lock) each see the previous insertion.
    let placement: "replaced" | "after" | "appended" | undefined;
    await mutatePageContent(pageId, collabToken, this.apiUrl, (liveDoc) => {
      const doc =
        liveDoc && liveDoc.type === "doc"
          ? liveDoc
          : { type: "doc", content: [] };
      if (!Array.isArray(doc.content)) doc.content = [];

      if (opts.replaceText) {
        // Ambiguity guard (mirrors editPageText): count matching top-level
        // blocks first, so a non-unique fragment cannot silently replace the
        // wrong block (e.g. text that also appears inside a callout/table).
        const matches = doc.content.filter((b: any) =>
          blockText(b).includes(opts.replaceText!),
        );
        if (matches.length === 0) {
          throw new Error(`replaceText not found: "${opts.replaceText}"`);
        }
        if (matches.length > 1) {
          throw new Error(
            `replaceText "${opts.replaceText}" matches ${matches.length} blocks; use a longer unique fragment`,
          );
        }
        const idx = doc.content.findIndex((b: any) =>
          blockText(b).includes(opts.replaceText!),
        );
        // Data-loss guard: replaceText swaps the WHOLE top-level block, so if
        // the fragment only appears nested inside a container (table, callout,
        // list, blockquote) the entire structure would be destroyed. Refuse
        // when the matched block is a container rather than a leaf
        // paragraph/heading and point the caller at a safer tool.
        const CONTAINER_TYPES = new Set([
          "table",
          "callout",
          "bulletList",
          "orderedList",
          "taskList",
          "blockquote",
        ]);
        const matchedBlock = doc.content[idx];
        if (matchedBlock && CONTAINER_TYPES.has(matchedBlock.type)) {
          throw new Error(
            `replaceText matched a ${matchedBlock.type} container block; replacing it would destroy the whole structure. ` +
              `Use afterText to insert near it, or update_page_json for surgical edits.`,
          );
        }
        doc.content.splice(idx, 1, node);
        placement = "replaced";
      } else if (opts.afterText) {
        // Ambiguity guard (mirrors editPageText): refuse a non-unique fragment.
        const matches = doc.content.filter((b: any) =>
          blockText(b).includes(opts.afterText!),
        );
        if (matches.length === 0) {
          throw new Error(`afterText not found: "${opts.afterText}"`);
        }
        if (matches.length > 1) {
          throw new Error(
            `afterText "${opts.afterText}" matches ${matches.length} blocks; use a longer unique fragment`,
          );
        }
        const idx = doc.content.findIndex((b: any) =>
          blockText(b).includes(opts.afterText!),
        );
        doc.content.splice(idx + 1, 0, node);
        placement = "after";
      } else {
        doc.content.push(node);
        placement = "appended";
      }

      return doc;
    });

    return {
      success: true,
      pageId,
      attachmentId: up.attachmentId,
      src: up.src,
      placement,
    };
  }

  /**
   * Replace an existing image in a page with a new file. Uploads the new file as
   * a brand-new attachment, which yields a fresh clean URL that both renders
   * correctly and busts browser caches (the URL changed). Finds every image node
   * whose attrs.attachmentId === oldAttachmentId (recursively, incl. nodes nested
   * in callouts/tables) and repoints its src/attachmentId/size, preserving
   * comments, alignment and alt. Operates on the live collab document so comments
   * and concurrent edits are preserved. Throws if no matching image is found.
   *
   * The OLD attachment is left in place as an unreferenced orphan: Docmost
   * exposes NO HTTP API to delete a single content attachment (verified against
   * the attachment controller/service and by probing the live API — deletion
   * happens only by cascade when the page, space or user is removed). This is the
   * same outcome as Docmost's own editor when an image is removed/replaced.
   * In-place byte overwrite is deliberately NOT used because some Docmost
   * versions corrupt the attachment (HTTP 500) when its bytes are overwritten.
   */
  async replaceImage(
    pageId: string,
    oldAttachmentId: string,
    filePath: string,
    opts: { align?: "left" | "center" | "right"; alt?: string } = {},
  ) {
    const collabToken = await this.getCollabTokenWithReauth();

    // Hold ONE per-page lock for the WHOLE operation (scan -> upload -> write).
    // Previously the scan and the write were two separate mutatePageContent
    // calls, each acquiring + releasing the lock, with the upload happening in
    // the UNLOCKED gap between them. A concurrent op could interleave there: it
    // could remove the target image so the write pass matches nothing, leaving
    // the freshly-uploaded attachment as an un-deletable orphan (Docmost has no
    // API to delete a single content attachment). Acquiring the lock once and
    // using the non-locking collab helper inside (the per-page mutex is NOT
    // reentrant, so the self-locking mutatePageContent would deadlock here)
    // closes that TOCTOU window. uploadImage hits /files/upload over plain HTTP
    // and does not touch the page lock, so it is safe to call while held.
    return withPageLock(pageId, async () => {
      // STEP 1: read-only live check. Scan the live document for any image node
      // matching oldAttachmentId BEFORE uploading anything, so a wrong/stale id
      // throws without ever creating an orphan attachment.
      let matchFound = false;
      const scan = (nodes: any[]) => {
        for (const node of nodes) {
          if (!node) continue;
          if (
            node.type === "image" &&
            node.attrs &&
            node.attrs.attachmentId === oldAttachmentId
          ) {
            matchFound = true;
          }
          if (Array.isArray(node.content)) scan(node.content);
        }
      };

      await this.mutateLiveContentUnlocked(pageId, collabToken, (liveDoc) => {
        matchFound = false; // reset per-transform (collab may retry the read).
        const doc =
          liveDoc && liveDoc.type === "doc"
            ? liveDoc
            : { type: "doc", content: [] };
        if (Array.isArray(doc.content)) scan(doc.content);
        return null; // read-only: never write on the check pass.
      });

      if (!matchFound) {
        throw new Error(
          `replace_image: no image with attachmentId "${oldAttachmentId}" found on page ${pageId}`,
        );
      }

      // STEP 2: a match exists — upload the new file as a FRESH attachment (new
      // id, new clean URL) and repoint every matching node in a second pass.
      // Still inside the SAME lock, so no other op can have changed the page
      // since the scan.
      const up = await this.uploadImage(pageId, filePath);

      let replaced = 0;

      // Swap the source of one image node, preserving align/alt/title/geometry.
      const repoint = (node: any) => {
        node.attrs = {
          ...node.attrs,
          src: up.src,
          attachmentId: up.attachmentId,
          // Default to null when fileSize is unknown so the attr is never
          // undefined.
          size: up.fileSize ?? null,
        };
        if (opts.align) node.attrs.align = opts.align;
        if (opts.alt !== undefined) node.attrs.alt = opts.alt;
        replaced++;
      };

      // Recursively repoint every image node (incl. ones nested in callouts/tables).
      const walk = (nodes: any[]) => {
        for (const node of nodes) {
          if (!node) continue;
          if (
            node.type === "image" &&
            node.attrs &&
            node.attrs.attachmentId === oldAttachmentId
          ) {
            repoint(node);
          }
          if (Array.isArray(node.content)) walk(node.content);
        }
      };

      await this.mutateLiveContentUnlocked(pageId, collabToken, (liveDoc) => {
        // Reset per-transform so collab retries recompute cleanly (no double-count).
        replaced = 0;
        const doc =
          liveDoc && liveDoc.type === "doc"
            ? liveDoc
            : { type: "doc", content: [] };
        if (!Array.isArray(doc.content)) doc.content = [];
        walk(doc.content);
        if (replaced === 0) return null; // no match -> skip the write entirely
        return doc;
      });

      if (replaced === 0) {
        // The pass-1 SCAN found the target (matchFound was true) and we already
        // uploaded the new attachment, but pass-2 matched nothing — a concurrent
        // editor must have removed the node between the two passes. Do NOT throw
        // here (that would leak the just-uploaded attachment AND report failure);
        // instead report success with the upload flagged as an unreferenced
        // orphan so the caller knows. (The early throw above still covers the
        // case where pass-1 finds nothing, before any upload happens.)
        return {
          success: true,
          replaced: 0,
          pageId,
          oldAttachmentId,
          newAttachmentId: up.attachmentId,
          src: up.src,
          orphanedAttachmentId: up.attachmentId,
          warning:
            "target image was removed concurrently; uploaded attachment is unreferenced",
        };
      }

      return {
        success: true,
        pageId,
        replaced,
        oldAttachmentId,
        newAttachmentId: up.attachmentId,
        src: up.src,
      };
    });
  }

  // --- Page history / diff / transform ---

  /**
   * List the saved versions (history snapshots) of a page, newest first.
   * Docmost auto-snapshots on every save. Returns one cursor-paginated page of
   * results: `{ items, nextCursor }`. The history record's id field is `id`.
   */
  async listPageHistory(pageId: string, cursor?: string) {
    await this.ensureAuthenticated();
    const payload: Record<string, any> = { pageId };
    if (cursor) payload.cursor = cursor;
    const response = await this.client.post("/pages/history", payload);
    const data = response.data?.data ?? response.data;
    return {
      items: data?.items ?? [],
      nextCursor: data?.meta?.nextCursor ?? null,
    };
  }

  /**
   * Fetch a single page-history version including its lossless ProseMirror
   * `content`. The version also carries pageId/title/createdAt.
   */
  async getPageHistory(historyId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/history/info", {
      historyId,
    });
    return response.data?.data ?? response.data;
  }

  /**
   * "Restore" a version: Docmost has NO restore endpoint, so we take the
   * version's `content` and write it as the page's current content via the live
   * collab path (which itself creates a new history snapshot). Returns the
   * affected pageId and the source historyId.
   */
  async restorePageVersion(historyId: string) {
    await this.ensureAuthenticated();
    const version = await this.getPageHistory(historyId);
    if (
      !version ||
      !version.pageId ||
      !version.content ||
      typeof version.content !== "object"
    ) {
      throw new Error(
        `restore_page_version: history ${historyId} has no usable content`,
      );
    }
    // Defense-in-depth: sanitize URLs in the restored content (parity with the
    // JSON write path) before writing it back.
    this.validateDocUrls(version.content);
    const collabToken = await this.getCollabTokenWithReauth();
    await mutatePageContent(
      version.pageId,
      collabToken,
      this.apiUrl,
      () => version.content,
    );
    return { pageId: version.pageId, restoredFrom: historyId };
  }

  /**
   * Diff two versions of a page and return a Docmost-equivalent change set.
   * `from`/`to` each resolve to a ProseMirror doc:
   *   - null / undefined / "current" -> the page's CURRENT content;
   *   - any other string             -> that historyId's content.
   * Returns the diff plus the resolved version metadata for each side.
   */
  async diffPageVersions(pageId: string, from?: string, to?: string) {
    await this.ensureAuthenticated();

    const isCurrent = (v?: string) =>
      v == null || v === "" || v === "current";

    const resolveSide = async (
      v?: string,
    ): Promise<{ doc: any; meta: any }> => {
      if (isCurrent(v)) {
        const raw = await this.getPageRaw(pageId);
        return {
          doc: raw.content || { type: "doc", content: [] },
          meta: {
            kind: "current",
            pageId,
            title: raw.title,
            updatedAt: raw.updatedAt,
          },
        };
      }
      const version = await this.getPageHistory(v as string);
      return {
        doc: version.content || { type: "doc", content: [] },
        meta: {
          kind: "history",
          historyId: version.id,
          pageId: version.pageId,
          title: version.title,
          createdAt: version.createdAt,
        },
      };
    };

    const fromSide = await resolveSide(from);
    const toSide = await resolveSide(to);
    const diff = diffDocs(fromSide.doc, toSide.doc);
    return { from: fromSide.meta, to: toSide.meta, diff };
  }

  /**
   * Edit a page by running an arbitrary user-supplied JS transform against the
   * live document, with a diff preview + page-history safety net.
   *
   * The transform string is evaluated as `(doc, ctx) => doc` inside a node:vm
   * sandbox: it gets ONLY `{ doc, ctx, structuredClone, console }` as globals,
   * a 5s timeout, and NO access to require/process/fs/network. It must return a
   * `{ type: "doc" }` node, which is validated structurally before any write.
   *
   * `ctx` exposes:
   *   - comments: the page's comments (fetched before the live read);
   *   - log: an array the transform can push diagnostics to (via console.log);
   *   - consume(id): mark a comment id as consumed (for deleteComments);
   *   - helpers: the transforms.ts primitives + commentsToFootnotes.
   *
   * Footnote convention used by the helpers: footnote markers are plain "[N]"
   * text in the body, and the notes are an orderedList under a heading whose
   * text is "Примечания переводчика".
   *
   * dryRun (default true): read the page's current content, run the transform,
   * and return `{ pushed:false, diff, log }` WITHOUT opening the collab socket.
   * Otherwise the transform runs atomically inside mutatePageContent, optionally
   * deletes consumed comments, and returns the new historyId + diff + log.
   */
  async transformPage(
    pageId: string,
    transformJs: string,
    opts: { dryRun?: boolean; deleteComments?: boolean } = {},
  ) {
    const dryRun = opts.dryRun ?? true;
    const deleteComments = opts.deleteComments ?? false;

    await this.ensureAuthenticated();
    const comments = await this.listComments(pageId);

    // ctx handed to the sandbox. consume() records ids; helpers are the pure
    // transform primitives. log is captured from console.log inside the sandbox.
    const ctx = {
      comments,
      log: [] as string[],
      consumed: new Set<string>(),
      consume(id: string) {
        this.consumed.add(id);
      },
      helpers: {
        blockText,
        walk,
        getList,
        insertMarkerAfter,
        setCalloutRange,
        noteItem,
        mdToInlineNodes,
        commentsToFootnotes,
      },
    };

    // Captured oldDoc / newDoc for the diff (set inside runTransform).
    let oldDoc: any;
    let newDoc: any;

    // SYNCHRONOUS transform runner — safe to call inside mutatePageContent's
    // onSynced (no await between the live read and the write).
    const runTransform = (liveDoc: any): any => {
      oldDoc = structuredClone(liveDoc);
      const sandbox: Record<string, any> = {
        doc: structuredClone(liveDoc),
        ctx,
        structuredClone,
        console: {
          log: (...a: any[]) => ctx.log.push(a.map((x) => String(x)).join(" ")),
        },
      };
      // Wrap the provided string in parentheses so both an expression-arrow
      // (`(doc, ctx) => {...}`) and a parenthesized function work. Run it in a
      // fresh context with no require/process/module so the transform cannot
      // touch fs/network/process. 5s wall-clock timeout.
      let fn: any;
      try {
        fn = vm.runInNewContext("(" + transformJs + ")", sandbox, {
          timeout: 5000,
        });
      } catch (e: any) {
        throw new Error(`transform did not compile: ${e?.message ?? e}`);
      }
      if (typeof fn !== "function") {
        throw new Error("transform must evaluate to a function (doc, ctx) => doc");
      }
      const result = vm.runInNewContext(
        "f(d, c)",
        { f: fn, d: sandbox.doc, c: ctx },
        { timeout: 5000 },
      );
      if (
        !result ||
        typeof result !== "object" ||
        result.type !== "doc" ||
        !Array.isArray(result.content)
      ) {
        throw new Error(
          'transform must return a ProseMirror doc node ({ type:"doc", content:[...] })',
        );
      }
      // Validate the returned doc before it can be written.
      this.validateDocStructure(result);
      this.validateDocUrls(result);
      newDoc = result;
      return result;
    };

    if (dryRun) {
      // Preview only: run against the current REST snapshot, never open the
      // socket. oldDoc/newDoc are captured by runTransform.
      const raw = await this.getPageRaw(pageId);
      const current = raw.content || { type: "doc", content: [] };
      runTransform(current);
      // Exercise the same Yjs encoder the apply path uses, so the preview
      // fails with the SAME descriptive error when the doc is not encodable
      // instead of returning a misleadingly-green diff.
      assertYjsEncodable(newDoc);
      return {
        pushed: false,
        diff: diffDocs(oldDoc, newDoc),
        log: ctx.log,
      };
    }

    // Apply atomically against the live doc.
    const collabToken = await this.getCollabTokenWithReauth();
    await mutatePageContent(pageId, collabToken, this.apiUrl, runTransform);

    // Optionally delete consumed comments (best-effort; a delete failure must
    // not undo the successful write).
    const deletedComments: string[] = [];
    if (deleteComments) {
      for (const id of ctx.consumed) {
        try {
          await this.deleteComment(id);
          deletedComments.push(id);
        } catch (e) {
          if (process.env.DEBUG) {
            console.error(`transform: failed to delete comment ${id}:`, e);
          }
        }
      }
    }

    // Fetch the newest historyId (Docmost snapshots on the write above).
    let historyId: string | null = null;
    try {
      const hist = await this.listPageHistory(pageId);
      historyId = hist.items?.[0]?.id ?? null;
    } catch (e) {
      if (process.env.DEBUG) {
        console.error("transform: failed to fetch history id:", e);
      }
    }

    return {
      pushed: true,
      historyId,
      diff: diffDocs(oldDoc, newDoc),
      deletedComments,
      log: ctx.log,
    };
  }
}
