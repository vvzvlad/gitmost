import { pathToFileURL } from 'node:url';

/**
 * Minimal structural type for the `DocmostClient` class we consume from the
 * ESM-only `@docmost/mcp` package. We only need the constructor + the read/write
 * methods used by the per-user tool adapter; the full client surface lives in
 * `packages/mcp/src/client.ts`. Signatures here mirror that file exactly.
 */
export interface DocmostClientLike {
  // --- read ---
  search(
    query: string,
    spaceId?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; success: boolean }>;
  getPage(
    pageId: string,
  ): Promise<{ data: Record<string, unknown>; success: boolean }>;
  getWorkspace(): Promise<{ data: Record<string, unknown>; success: boolean }>;
  getSpaces(): Promise<unknown[]>;
  listPages(
    spaceId?: string,
    limit?: number,
    tree?: boolean,
  ): Promise<unknown[]>;
  listSidebarPages(spaceId: string, pageId?: string): Promise<unknown[]>;
  getOutline(pageId: string): Promise<Record<string, unknown>>;
  getPageJson(pageId: string): Promise<Record<string, unknown>>;
  getNode(pageId: string, nodeId: string): Promise<Record<string, unknown>>;
  getTable(pageId: string, tableRef: string): Promise<Record<string, unknown>>;
  listComments(pageId: string): Promise<unknown[]>;
  getComment(
    commentId: string,
  ): Promise<{ data: Record<string, unknown>; success: boolean }>;
  checkNewComments(
    spaceId: string,
    since: string,
    parentPageId?: string,
  ): Promise<unknown>;
  listShares(): Promise<unknown[]>;
  listPageHistory(
    pageId: string,
    cursor?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  getPageHistory(historyId: string): Promise<Record<string, unknown>>;
  diffPageVersions(
    pageId: string,
    from?: string,
    to?: string,
  ): Promise<Record<string, unknown>>;
  exportPageMarkdown(pageId: string): Promise<string>;
  // --- write (page) ---
  createPage(
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
  ): Promise<{ data: Record<string, unknown>; success: boolean }>;
  // Markdown content update via the collab path (carries provenance via the
  // collab-token provider). Optionally also updates the title.
  updatePage(
    pageId: string,
    content: string,
    title?: string,
  ): Promise<Record<string, unknown>>;
  // Title-only rename via REST.
  renamePage(
    pageId: string,
    title: string,
  ): Promise<Record<string, unknown>>;
  // Move via REST. parentPageId null => move to space root.
  movePage(
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ): Promise<unknown>;
  // SOFT delete only (POST /pages/delete with { pageId }). NEVER permanent.
  deletePage(pageId: string): Promise<unknown>;
  editPageText(
    pageId: string,
    edits: Array<{ find: string; replace: string; replaceAll?: boolean }>,
  ): Promise<Record<string, unknown>>;
  patchNode(
    pageId: string,
    nodeId: string,
    node: unknown,
  ): Promise<Record<string, unknown>>;
  insertNode(
    pageId: string,
    node: unknown,
    opts: {
      position: 'before' | 'after' | 'append';
      anchorNodeId?: string;
      anchorText?: string;
    },
  ): Promise<Record<string, unknown>>;
  deleteNode(
    pageId: string,
    nodeId: string,
  ): Promise<Record<string, unknown>>;
  updatePageJson(
    pageId: string,
    doc?: unknown,
    title?: string,
  ): Promise<Record<string, unknown>>;
  tableInsertRow(
    pageId: string,
    tableRef: string,
    cells: string[],
    index?: number,
  ): Promise<Record<string, unknown>>;
  tableDeleteRow(
    pageId: string,
    tableRef: string,
    index: number,
  ): Promise<Record<string, unknown>>;
  tableUpdateCell(
    pageId: string,
    tableRef: string,
    row: number,
    col: number,
    text: string,
  ): Promise<Record<string, unknown>>;
  copyPageContent(
    sourcePageId: string,
    targetPageId: string,
  ): Promise<Record<string, unknown>>;
  importPageMarkdown(
    pageId: string,
    fullMarkdown: string,
  ): Promise<Record<string, unknown>>;
  sharePage(
    pageId: string,
    searchIndexing?: boolean,
  ): Promise<Record<string, unknown>>;
  unsharePage(pageId: string): Promise<Record<string, unknown>>;
  restorePageVersion(historyId: string): Promise<Record<string, unknown>>;
  // The opts type declares deleteComments? to match the real client signature,
  // but the agent tool NEVER sets it (comment deletion stays unreachable).
  transformPage(
    pageId: string,
    transformJs: string,
    opts?: { dryRun?: boolean; deleteComments?: boolean },
  ): Promise<Record<string, unknown>>;
  // --- write (comment) ---
  createComment(
    pageId: string,
    content: string,
    type?: 'page' | 'inline',
    selection?: string,
    parentCommentId?: string,
  ): Promise<{ data: Record<string, unknown>; success: boolean }>;
  resolveComment(
    commentId: string,
    resolved: boolean,
  ): Promise<Record<string, unknown>>;
}

export type DocmostClientConfig = {
  apiUrl: string;
  getToken: () => Promise<string>;
  // Provenance collab-token provider for content mutations (signed agent claim).
  getCollabToken?: () => Promise<string>;
};

export interface DocmostClientCtor {
  new (config: DocmostClientConfig): DocmostClientLike;
}

interface DocmostMcpModule {
  DocmostClient: DocmostClientCtor;
}

// TS with module:commonjs downlevels a literal `import()` to `require()`, which
// cannot load the ESM-only `@docmost/mcp` package. Indirect through Function so
// the real dynamic `import()` survives compilation and can load ESM from
// CommonJS at runtime (same trick as integrations/mcp/mcp.service.ts).
const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

// Memoize the in-flight/loaded module so the dynamic import runs at most once.
let modulePromise: Promise<DocmostMcpModule> | null = null;

/**
 * Lazily load the ESM-only `@docmost/mcp` package and return its
 * `DocmostClient` constructor. Resolves the package entry to an absolute path,
 * then imports it as a `file://` URL so the package "exports" map is honoured
 * without bare-specifier resolution-base fragility.
 */
export async function loadDocmostMcp(): Promise<{
  DocmostClient: DocmostClientCtor;
}> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const entry = require.resolve('@docmost/mcp');
      const mod = (await esmImport(
        pathToFileURL(entry).href,
      )) as DocmostMcpModule;
      return mod;
    })().catch((err) => {
      // Do not cache a rejected import — allow the next call to retry.
      modulePromise = null;
      throw err;
    });
  }
  const mod = await modulePromise;
  return { DocmostClient: mod.DocmostClient };
}
