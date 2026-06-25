/**
 * Pure, network-free helpers for manipulating a ProseMirror/TipTap document
 * tree by node id.
 *
 * A ProseMirror node here is a plain JSON object of the shape produced by
 * Docmost: `{ type, attrs?, content?, text?, marks? }`. Children live in the
 * `content` array; a node carries a stable id in `attrs.id`. Callouts and
 * table cells hold their children in `content` just like any other block, so a
 * single recursive walk reaches them all.
 *
 * Every exported function operates on a DEEP CLONE of the input document and
 * returns the new document. The input doc and any `newNode`/`node` argument are
 * never mutated. All functions are defensively null-safe: missing/!Array
 * `content`, non-object nodes, and absent `attrs` are tolerated.
 */
/**
 * Recursively concatenate all text contained in a node.
 *
 * Text nodes contribute their `text` string; container nodes contribute the
 * joined `blockPlainText` of their `content` children. Returns "" for nullish
 * or non-object inputs.
 */
export declare function blockPlainText(node: any): string;
/** One compact outline entry for a single top-level block. */
export interface OutlineEntry {
    index: number;
    type: string | undefined;
    id: string | null;
    firstText: string;
    /** Present for headings only. */
    level?: number | null;
    /** Present for tables only. */
    rows?: number;
    cols?: number;
    header?: string[];
    /** Present for list blocks only (bulletList/orderedList/taskList). */
    items?: number;
}
/**
 * Build a COMPACT outline of the TOP-LEVEL blocks of `doc` (the entries in
 * `doc.content`). Deliberately does NOT recurse into paragraphs, list items, or
 * table cells — compactness is the point; use `getNodeByRef` to drill into a
 * specific block.
 *
 * Each entry carries `{ index, type, id, firstText }`, plus type-specific
 * extras: headings add `level`; tables add `rows`/`cols` and the first row's
 * cell texts as `header`; list blocks (types ending in "List") add `items`.
 * `firstText` is the block's plain text truncated to 100 chars. Null-safe:
 * a missing or non-object doc/content yields `[]`.
 */
export declare function buildOutline(doc: any): OutlineEntry[];
/**
 * Resolve a single node by reference and return `{ node, path, type }`, or
 * `null` when nothing matches.
 *
 * - `ref` of the form `#<n>` (e.g. `#2`) selects the TOP-LEVEL block at index
 *   `n` in `doc.content`. This is the only way to address table/tableRow/
 *   tableCell nodes, which carry no `attrs.id`.
 * - Otherwise `ref` is treated as a block id: the FIRST node anywhere in the
 *   tree with `attrs.id === ref` is returned.
 *
 * `path` is the array of child indices from the doc root down to the node
 * (so a top-level block is `[index]`). The returned `node` is a DEEP CLONE,
 * so callers can mutate it without touching the input doc. Null-safe.
 */
export declare function getNodeByRef(doc: any, ref: string): {
    node: any;
    path: number[];
    type: string | undefined;
} | null;
/**
 * Replace EVERY node whose `attrs.id === nodeId` with a deep clone of
 * `newNode`, anywhere in the tree (including inside callouts and table cells).
 *
 * Operates on a clone of `doc`; returns `{ doc, replaced }` where `replaced`
 * is the number of nodes substituted. A fresh clone of `newNode` is used for
 * each match so they do not share references.
 */
export declare function replaceNodeById(doc: any, nodeId: string, newNode: any): {
    doc: any;
    replaced: number;
};
/**
 * Remove EVERY node whose `attrs.id === nodeId` from its parent `content`
 * array, anywhere in the tree (recursive, including callouts and tables).
 *
 * Operates on a clone of `doc`; returns `{ doc, deleted }` where `deleted` is
 * the number of nodes removed.
 */
export declare function deleteNodeById(doc: any, nodeId: string): {
    doc: any;
    deleted: number;
};
/**
 * Deep-clone `doc` and strip every node/mark attribute whose value is strictly
 * `undefined`, so the result is safe to hand to Yjs (which throws an opaque
 * "Unexpected content type" when asked to store an `undefined` attribute value).
 *
 * Only `undefined` keys are removed; `null`, `false`, `0`, and `""` are all
 * legitimate JSON-storable values and are preserved. Operates on a clone and
 * returns it; the input is never mutated. Defensively null-safe like the rest
 * of the file.
 */
export declare function sanitizeForYjs(doc: any): any;
/**
 * Diagnostics helper: walk the tree and return a human-readable path string for
 * the FIRST attribute value (in any `node.attrs` or `mark.attrs`) that Yjs
 * cannot store — i.e. `undefined`, a `function`, a `symbol`, or a `bigint`
 * (e.g. `content[3].content[0].attrs.indent (undefined)`). Returns `null` when
 * every attribute is storable. Null-safe.
 */
export declare function findUnstorableAttr(doc: any): string | null;
/** Options controlling where `insertNodeRelative` places the new node. */
export interface InsertOptions {
    position: "before" | "after" | "append";
    /** Resolve the anchor by node id anywhere in the tree (preferred). */
    anchorNodeId?: string;
    /** Fallback: first TOP-LEVEL block whose plain text includes this string. */
    anchorText?: string;
}
/**
 * Insert a deep clone of `node` relative to an anchor.
 *
 * - position "append": push the node onto the top-level `doc.content`.
 * - position "before"/"after": locate the anchor and splice the node into the
 *   anchor's parent `content` array immediately before / after it.
 *
 * Anchor resolution for before/after:
 *   - if `anchorNodeId` is given, find the node with `attrs.id === anchorNodeId`
 *     anywhere in the tree (recursive);
 *   - otherwise, if `anchorText` is given, scan only TOP-LEVEL `doc.content`
 *     blocks and pick the first whose `blockPlainText` includes `anchorText`.
 *
 * Operates on a clone of `doc`; returns `{ doc, inserted }`. `inserted` is
 * false when the anchor could not be resolved (the doc is returned unchanged
 * apart from being cloned).
 */
export declare function insertNodeRelative(doc: any, node: any, opts: InsertOptions): {
    doc: any;
    inserted: boolean;
};
/**
 * Read a table as a matrix. Returns null when `tableRef` resolves to no table.
 *
 * - `rows`/`cols`: the table's row count and the column count of its FIRST row.
 *   Tables may be ragged (rows of differing length), so `cols` reflects only
 *   row 0; use the per-row length of `cells`/`cellIds` for each row's actual
 *   width.
 * - `cells`: `string[][]` of each cell's `blockPlainText`.
 * - `cellIds`: `(string|null)[][]` of each cell's FIRST paragraph id (or null),
 *   so callers can `patch_node` a cell for rich-formatted edits.
 * - `path`: index path of the table within the doc.
 */
export declare function readTable(doc: any, tableRef: string): {
    rows: number;
    cols: number;
    cells: string[][];
    cellIds: (string | null)[][];
    path: number[];
} | null;
/**
 * Insert a row of plain-text cells into a table. Returns `{ doc, inserted }`.
 *
 * The row is padded to the table's column count (`cells[i] ?? ""`); supplying
 * MORE cells than columns throws. Each new cell copies `colwidth` for its
 * column from the header row when present, gets a fresh-id paragraph, and a
 * `colspan:1, rowspan:1` attrs. `index` (when an integer in `[0, rows]`) splices
 * the row there; otherwise the row is appended at the end.
 */
export declare function insertTableRow(doc: any, tableRef: string, cells: string[], index?: number): {
    doc: any;
    inserted: boolean;
};
/**
 * Delete the row at 0-based `index` from a table. Returns `{ doc, deleted }`.
 * `deleted` is false only when the table cannot be located. Throws on an
 * out-of-range index, and refuses to delete the table's only row.
 */
export declare function deleteTableRow(doc: any, tableRef: string, index: number): {
    doc: any;
    deleted: boolean;
};
/**
 * Set the plain-text content of cell `[row, col]` (0-based) to `text`. Returns
 * `{ doc, updated }`; `updated` is false only when the table cannot be located.
 * Throws when `row`/`col` is out of range. The cell's own attrs (colspan/
 * rowspan/colwidth) are preserved; its content becomes a single text paragraph
 * that reuses the cell's existing first-paragraph id when present, else a fresh
 * one.
 */
export declare function updateTableCell(doc: any, tableRef: string, row: number, col: number, text: string): {
    doc: any;
    updated: boolean;
};
