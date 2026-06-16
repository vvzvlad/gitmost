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
