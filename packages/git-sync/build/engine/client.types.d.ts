/**
 * The client seam. `pull.ts`/`push.ts` depend on a narrow STRUCTURAL interface
 * rather than any concrete client, because the gitmost server writes NATIVELY —
 * through repositories + collab `openDirectConnection`.
 *
 * `GitSyncClient` is that interface: the native datasource (server side)
 * implements it, and the engine only ever uses `Pick<GitSyncClient, ...>`
 * subsets of it. The signatures below MIRROR exactly the methods the engine's
 * `pull.ts`/`push.ts` actually call (arg shapes + the fields the engine reads
 * off each result), so a REST-style client is still structurally assignable and
 * the native adapter has a precise contract.
 */
/**
 * A page node as returned by `listSpaceTree` (the sidebar/tree walk, no body).
 * The engine layout (`buildVaultLayout`) consumes `PageNode` from `./layout`,
 * which only requires `id` (+ optional `title`/`slugId`/`parentPageId`); this
 * lite shape documents the fields the tree walk surfaces. Real tree nodes also
 * carry `position`, `icon`, `hasChildren` — kept open via the index signature.
 */
export interface GitSyncPageNodeLite {
    id: string;
    slugId?: string;
    title?: string;
    parentPageId?: string | null;
    hasChildren?: boolean;
    /** `listSpaceTree` nodes carry extra fields (position, icon, …). */
    [key: string]: unknown;
}
/**
 * The structural client the engine depends on. Only `Pick<GitSyncClient, ...>`
 * subsets are ever used:
 *   - pull reads:  `getPageJson` (+ the tree walk's `listSpaceTree`),
 *   - push writes: `importPageMarkdown` / `createPage` / `deletePage` /
 *                  `movePage` / `renamePage`,
 *   - continuous (phase B+): `listRecentSince` / `listTrash` / `restorePage`.
 */
export interface GitSyncClient {
    /**
     * Full tree of page nodes for the space (or the subtree rooted at
     * `rootPageId`), each WITHOUT body content. `complete` is `false` when the
     * walk was truncated / a fetch failed — the pull side suppresses absence
     * deletions on an incomplete tree (SPEC §8). Native impl returns
     * `complete: true` always (reads the DB, not a paginated REST endpoint).
     */
    listSpaceTree(spaceId: string, rootPageId?: string): Promise<{
        pages: GitSyncPageNodeLite[];
        complete: boolean;
    }>;
    /**
     * One page WITH its ProseMirror body content. `applyPullActions` reads
     * `id`, `slugId`, `title`, `parentPageId`, `spaceId` (for the file meta) and
     * `content` (to stabilize/serialize). `updatedAt` is carried for the
     * poll-suppression loop-guard.
     */
    getPageJson(pageId: string): Promise<{
        id: string;
        slugId: string;
        title: string;
        parentPageId: string | null;
        spaceId: string;
        updatedAt: string;
        content: unknown;
    }>;
    /**
     * Merge a page's body from a self-contained markdown file (meta + body). The
     * collab/Yjs write path (SPEC §2/§15.6) — never a raw jsonb overwrite.
     * `applyPushActions` reads only an optional `updatedAt` off the result
     * (via `extractUpdatedAt`, tolerant of extra fields).
     *
     * `baseMarkdown` is the last-synced version of the file (`refs/docmost/
     * last-pushed`), the common ancestor for a THREE-WAY merge against the live
     * doc so concurrent human edits survive (review #5). Optional/null -> 2-way.
     */
    importPageMarkdown(pageId: string, fullMarkdown: string, baseMarkdown?: string | null): Promise<{
        updatedAt?: string;
        [key: string]: unknown;
    }>;
    /**
     * Create a new page and return the assigned id at `data.id`
     * (`applyPushActions` reads `result.data.id`, then writes it back into the
     * file's meta). An optional top-level/`data.updatedAt` feeds the loop-guard.
     */
    createPage(title: string, content: string, spaceId: string, parentPageId?: string): Promise<{
        data: {
            id: string;
        };
        updatedAt?: string;
        [key: string]: unknown;
    }>;
    /** Soft-delete a page to Trash (SPEC §8). Result is not inspected. */
    deletePage(pageId: string): Promise<unknown>;
    /**
     * Reparent a page (and optionally set its fractional-index `position`). The
     * engine passes `position` UNDEFINED for now; the native impl computes a
     * default between siblings. Result is not inspected.
     */
    movePage(pageId: string, parentPageId: string | null, position?: string): Promise<unknown>;
    /** Change a page's title only (no body touch). Result is not inspected. */
    renamePage(pageId: string, title: string): Promise<unknown>;
    /**
     * Pages updated since `sinceIso` (the poll-safety reconciliation, SPEC §8).
     * `spaceId` may be undefined (all spaces); `hardPageCap` bounds the walk.
     */
    listRecentSince(spaceId: string | undefined, sinceIso: string | null, hardPageCap?: number): Promise<unknown[]>;
    /** List soft-deleted (trashed) pages for the space (deletion detection). */
    listTrash(spaceId: string): Promise<unknown[]>;
    /** Restore a soft-deleted page from Trash. Result is not inspected. */
    restorePage(pageId: string): Promise<unknown>;
}
