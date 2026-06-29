import { pathToFileURL } from 'node:url';

/**
 * Minimal structural type for the `DocmostClient` class we consume from the
 * ESM-only `@docmost/mcp` package. We only need the constructor + the read/write
 * methods used by the per-user tool adapter; the full client surface lives in
 * `packages/mcp/src/client.ts`. Signatures here mirror that file exactly.
 *
 * DRIFT GUARD: the method NAMES below are runtime-checked against the real
 * `DocmostClient` by `packages/mcp/test/unit/client-host-contract.test.mjs`
 * (which can import the ESM class directly). If you rename/remove a method here
 * or in client.ts, that test fails — so a stale mirror cannot silently ship a
 * runtime "x is not a function" into an agent tool call. Keep the two in sync.
 *
 * STAGED PLAN — full derivation `DocmostClientLike = <real DocmostClient type>`
 * (issue #193, layer 3) is intentionally NOT done; it stays a hand-mirror for
 * now because of two verified blockers across the ESM(mcp)/CJS(server) boundary:
 *   1. `@docmost/mcp` emits NO declaration files (its tsconfig has no
 *      `declaration`, package.json has no `types`/types-export) and the server
 *      tsconfig has no path mapping for it — the server only loads it via the
 *      runtime `import()` trick below, so there is no type to import today.
 *   2. The real client methods have inferred, CONCRETE return types; the in-app
 *      tool adapter reads results through loose `Record<string,unknown>` returns
 *      + `as` casts (e.g. `(result?.data ?? {}) as { title?: string }`).
 *      Deriving the exact type would make those casts non-overlapping ("may be a
 *      mistake") and break the build, and `Partial<DocmostClientLike>` test stubs
 *      would have to satisfy the full concrete surface.
 * To do it safely later (incrementally): (a) turn on `declaration: true` in
 * packages/mcp/tsconfig.json + add a `types` export condition and commit the
 * emitted `.d.ts`; (b) `import type { DocmostClient } from '@docmost/mcp'` here
 * and replace this interface with a `Pick<DocmostClient, ...>` of the consumed
 * methods; (c) audit every `as` cast in ai-chat-tools.service.ts against the now
 * concrete return types (double-cast through `unknown` only where genuinely
 * needed); (d) keep the runtime guard test as a belt-and-braces check. Until
 * then the guard test above is the cheap, behaviour-neutral protection.
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
  // Serialize a page + mirror its internal images into the blob sandbox; returns
  // ONLY a short anonymous URL (the body never enters the model context).
  stashPage(pageId: string): Promise<{
    uri: string;
    sha256: string;
    size: number;
    images: { mirrored: number; failed: number };
  }>;
}

export type DocmostClientConfig = {
  apiUrl: string;
  getToken: () => Promise<string>;
  // Provenance collab-token provider for content mutations (signed agent claim).
  getCollabToken?: () => Promise<string>;
  // Optional blob-sandbox sink for the stash tool. `put` stores a blob in the
  // host's in-RAM SandboxStore and returns the anonymous read URL + integrity.
  // The optional `has`/`evict` probes let stashPage keep its mirror counts
  // honest under the store's FIFO eviction (mirror of the package's sink type).
  sandbox?: {
    put: (
      buf: Buffer,
      mime: string,
    ) => { uri: string; sha256: string; size: number };
    has?: (uri: string) => boolean;
    evict?: (uri: string) => void;
  };
};

export interface DocmostClientCtor {
  new (config: DocmostClientConfig): DocmostClientLike;
}

/**
 * Local hand-mirror of the `SharedToolSpec` shape exported from
 * `@docmost/mcp` (packages/mcp/src/tool-specs.ts). Same approach as
 * `DocmostClientLike`: we do not import the ESM package's types directly across
 * the CJS/ESM boundary. The registry itself has no runtime deps, but keeping the
 * type local avoids coupling the server build to the package's type surface.
 *
 * `buildShape` is intentionally zod-agnostic: it returns a plain ZodRawShape
 * built with whatever zod namespace the caller passes (the server passes its own
 * zod v4; the MCP package passes its zod v3). See the registry module comment.
 */
export interface SharedToolSpec {
  mcpName: string;
  inAppKey: string;
  description: string;
  // Loose `z` on purpose: the registry is zod-agnostic so the server can pass
  // its own zod (v4) and the MCP package its own (v3) into the same builder.
  buildShape?: (z: any) => Record<string, unknown>;
}

interface DocmostMcpModule {
  DocmostClient: DocmostClientCtor;
  SHARED_TOOL_SPECS: Record<string, SharedToolSpec>;
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
  sharedToolSpecs: Record<string, SharedToolSpec>;
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
  if (!mod.SHARED_TOOL_SPECS) {
    // A stale @docmost/mcp build (missing the shared registry export) would
    // otherwise surface as a confusing TypeError deep in the tools service.
    throw new Error(
      '@docmost/mcp is stale: SHARED_TOOL_SPECS missing — rebuild the package (pnpm --filter @docmost/mcp build).',
    );
  }
  return {
    DocmostClient: mod.DocmostClient,
    sharedToolSpecs: mod.SHARED_TOOL_SPECS,
  };
}
