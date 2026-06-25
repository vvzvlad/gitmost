/**
 * Headless, Docmost-equivalent document diff.
 *
 * Docmost's history editor computes a change set with the exact pipeline below
 * (recreateTransform -> ChangeSet.addSteps -> simplifyChanges) and renders it as
 * editor decorations. This module runs the SAME computation but serializes the
 * result to text + integrity counts instead of decorations, so a diff can be
 * previewed without a browser.
 *
 * recreateTransform here comes from @fellow/prosemirror-recreate-transform, the
 * maintained published fork of the MIT prosemirror-recreate-steps source that
 * Docmost vendors in @docmost/editor-ext; it exposes the identical
 * recreateTransform(fromDoc, toDoc, { complexSteps, wordDiffs, simplifyDiff })
 * signature.
 *
 * If recreateTransform / the changeset throws on a pathological document pair,
 * we fall back to a coarse block-level text diff so the tool never hard-fails.
 */
/** A single inserted/deleted change with its containing-block context. */
export interface DiffChange {
    op: "insert" | "delete";
    /** Lead (plain) text of the block that contains the change, for context. */
    block: string;
    /** The inserted or deleted text. */
    text: string;
}
/** Integrity counts as [old, new] tuples; footnoteMarkers as [oldList, newList]. */
export interface DiffIntegrity {
    images: [number, number];
    links: [number, number];
    tables: [number, number];
    callouts: [number, number];
    footnoteMarkers: [number[], number[]];
}
export interface DiffResult {
    summary: {
        inserted: number;
        deleted: number;
        blocksChanged: number;
    };
    integrity: DiffIntegrity;
    changes: DiffChange[];
    /** Human-readable unified-ish summary. */
    markdown: string;
}
/**
 * Diff two ProseMirror JSON documents the way Docmost's history editor does and
 * serialize the result to text + integrity counts.
 *
 * @param oldDocJson the earlier document
 * @param newDocJson the later document
 * @param notesHeading heading delimiting body from notes for footnote counting
 */
export declare function diffDocs(oldDocJson: any, newDocJson: any, notesHeading?: string): DiffResult;
