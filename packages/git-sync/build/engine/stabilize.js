/**
 * Normalize-on-write helper (SPEC §11 "Резолюция").
 *
 * git diffs byte-for-byte, so writing a page in a NON-fixpoint markdown form
 * would make the next pull re-export it to a slightly different (but stable)
 * form and produce a phantom diff -> churny commits. The converter has a couple
 * of known one-pass asymmetries (a block image after a paragraph adds an empty
 * paragraph; a diagram materializes `data-align`), all of which converge to a
 * fixpoint after ONE `export -> import -> export` round-trip.
 *
 * So at write time we run exactly that one pass and persist the fixpoint form.
 * Already-stable content is unaffected (the pass is idempotent), so re-pulls of
 * unchanged pages produce identical bytes and git sees no diff.
 */
import { convertProseMirrorToMarkdown, markdownToProseMirror, serializeDocmostMarkdownBody, } from "../lib/index.js";
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
export async function stabilizePageFile(content, meta) {
    // The meta shape is exactly what `exportPageBody` writes; cast to the lib's
    // DocmostMdMeta (a superset with optional fields) for the serializer.
    return serializeDocmostMarkdownBody(meta, await stabilizePageBody(content));
}
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
export async function stabilizePageBody(content) {
    const md1 = convertProseMirrorToMarkdown(content);
    const doc2 = await markdownToProseMirror(md1);
    return convertProseMirrorToMarkdown(doc2);
}
