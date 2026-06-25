/**
 * Meta object as `exportPageBody` builds it (SPEC §4). Kept byte-for-byte
 * compatible so files produced here match `exportPageBody`'s output exactly.
 */
export interface PageMeta {
    version: 1;
    pageId: string;
    slugId: string;
    title: string;
    spaceId: string;
    parentPageId: string | null;
}
/**
 * Produce the self-contained `.md` file text for a page from its raw
 * ProseMirror `content` + identity meta, in the verified fixpoint form.
 *
 *   md1        = convertProseMirrorToMarkdown(content)
 *   doc2       = markdownToProseMirror(md1)            // one import...
 *   stableBody = convertProseMirrorToMarkdown(doc2)    // ...and re-export
 *   file       = serializeDocmostMarkdownBody(meta, stableBody)
 *
 * The single export->import->export pass is the verified fixpoint (SPEC §11):
 * idempotent for already-stable content, and the convergence point for the
 * known converter asymmetries.
 */
export declare function stabilizePageFile(content: unknown, meta: PageMeta): Promise<string>;
/**
 * The fixpoint markdown BODY for a page's ProseMirror `content`, WITHOUT any meta
 * envelope:
 *
 *   md1        = convertProseMirrorToMarkdown(content)   // export...
 *   doc2       = markdownToProseMirror(md1)              // ...import...
 *   stableBody = convertProseMirrorToMarkdown(doc2)      // ...re-export
 *
 * The single export->import->export pass is the verified fixpoint (SPEC §11):
 * idempotent for already-stable content, and the convergence point for the known
 * converter asymmetries. The native-Obsidian writer (`serializePageFile`) wraps
 * this body with a minimal `gitmost_id` frontmatter; determinism here is what
 * keeps re-pulls of an unchanged page byte-identical (no churn, loop-guard).
 */
export declare function stabilizePageBody(content: unknown): Promise<string>;
