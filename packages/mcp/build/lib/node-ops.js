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
import { stripInlineMarkdown } from "./text-normalize.js";
/** Deep-clone a JSON-serializable value without mutating the original. */
function clone(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    // Fallback for environments without structuredClone.
    return JSON.parse(JSON.stringify(value));
}
/** True if `value` is a non-null object (and not an array). */
function isObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}
/** True if `node` carries the given id in `node.attrs.id`. */
function matchesId(node, nodeId) {
    return isObject(node) && isObject(node.attrs) && node.attrs.id === nodeId;
}
/**
 * Recursively concatenate all text contained in a node.
 *
 * Text nodes contribute their `text` string; container nodes contribute the
 * joined `blockPlainText` of their `content` children. Returns "" for nullish
 * or non-object inputs.
 */
export function blockPlainText(node) {
    if (!isObject(node))
        return "";
    let out = "";
    if (typeof node.text === "string") {
        out += node.text;
    }
    if (Array.isArray(node.content)) {
        for (const child of node.content) {
            out += blockPlainText(child);
        }
    }
    return out;
}
/** Truncate `text` to at most `n` chars, appending an ellipsis when cut. */
function truncate(text, n) {
    return text.length > n ? text.slice(0, n) + "…" : text;
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
export function buildOutline(doc) {
    if (!isObject(doc) || !Array.isArray(doc.content))
        return [];
    const out = [];
    for (let i = 0; i < doc.content.length; i++) {
        const block = doc.content[i];
        const type = isObject(block) ? block.type : undefined;
        const entry = {
            index: i,
            type,
            id: isObject(block) && isObject(block.attrs) ? block.attrs.id ?? null : null,
            firstText: truncate(blockPlainText(block), 100),
        };
        if (type === "heading") {
            entry.level = isObject(block.attrs) ? block.attrs.level ?? null : null;
        }
        else if (type === "table") {
            const headerRow = block.content?.[0]?.content ?? [];
            entry.rows = block.content?.length ?? 0;
            entry.cols = block.content?.[0]?.content?.length ?? 0;
            entry.header = headerRow.map((cell) => truncate(blockPlainText(cell), 40));
        }
        else if (typeof type === "string" && type.endsWith("List")) {
            entry.items = block.content?.length ?? 0;
        }
        out.push(entry);
    }
    return out;
}
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
export function getNodeByRef(doc, ref) {
    if (!isObject(doc))
        return null;
    // "#<n>": index into the top-level content array.
    const indexMatch = typeof ref === "string" ? ref.match(/^#(\d+)$/) : null;
    if (indexMatch) {
        const index = Number(indexMatch[1]);
        const block = Array.isArray(doc.content) ? doc.content[index] : undefined;
        if (!isObject(block))
            return null;
        return { node: clone(block), path: [index], type: block.type };
    }
    // Otherwise: depth-first search for the first node with attrs.id === ref.
    const search = (node, trail) => {
        if (!isObject(node))
            return null;
        if (Array.isArray(node.content)) {
            for (let i = 0; i < node.content.length; i++) {
                const child = node.content[i];
                const path = [...trail, i];
                if (matchesId(child, ref)) {
                    return { node: clone(child), path, type: child.type };
                }
                const hit = search(child, path);
                if (hit != null)
                    return hit;
            }
        }
        return null;
    };
    return search(doc, []);
}
/**
 * Replace EVERY node whose `attrs.id === nodeId` with a deep clone of
 * `newNode`, anywhere in the tree (including inside callouts and table cells).
 *
 * Operates on a clone of `doc`; returns `{ doc, replaced }` where `replaced`
 * is the number of nodes substituted. A fresh clone of `newNode` is used for
 * each match so they do not share references.
 */
export function replaceNodeById(doc, nodeId, newNode) {
    const out = clone(doc);
    let replaced = 0;
    // Walk a content array, replacing direct matches and recursing into the
    // (possibly new) children of non-matching nodes.
    const walkContent = (content) => {
        for (let i = 0; i < content.length; i++) {
            const child = content[i];
            if (matchesId(child, nodeId)) {
                content[i] = clone(newNode);
                replaced++;
                // Do not recurse into a freshly substituted node.
                continue;
            }
            if (isObject(child) && Array.isArray(child.content)) {
                walkContent(child.content);
            }
        }
    };
    if (isObject(out) && Array.isArray(out.content)) {
        walkContent(out.content);
    }
    return { doc: out, replaced };
}
/**
 * Remove EVERY node whose `attrs.id === nodeId` from its parent `content`
 * array, anywhere in the tree (recursive, including callouts and tables).
 *
 * Operates on a clone of `doc`; returns `{ doc, deleted }` where `deleted` is
 * the number of nodes removed.
 */
export function deleteNodeById(doc, nodeId) {
    const out = clone(doc);
    let deleted = 0;
    // Filter a content array in place, dropping matches and recursing into the
    // surviving children.
    const walkContent = (content) => {
        const kept = [];
        for (const child of content) {
            if (matchesId(child, nodeId)) {
                deleted++;
                continue;
            }
            if (isObject(child) && Array.isArray(child.content)) {
                child.content = walkContent(child.content);
            }
            kept.push(child);
        }
        return kept;
    };
    if (isObject(out) && Array.isArray(out.content)) {
        out.content = walkContent(out.content);
    }
    return { doc: out, deleted };
}
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
export function sanitizeForYjs(doc) {
    const out = clone(doc);
    // Drop every key whose value is strictly `undefined` from an attrs object.
    const stripUndefined = (attrs) => {
        if (!isObject(attrs))
            return;
        for (const key of Object.keys(attrs)) {
            if (attrs[key] === undefined) {
                delete attrs[key];
            }
        }
    };
    const walk = (node) => {
        if (!isObject(node))
            return;
        stripUndefined(node.attrs);
        if (Array.isArray(node.marks)) {
            for (const mark of node.marks) {
                if (isObject(mark))
                    stripUndefined(mark.attrs);
            }
        }
        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                walk(child);
            }
        }
    };
    walk(out);
    return out;
}
/**
 * Diagnostics helper: walk the tree and return a human-readable path string for
 * the FIRST attribute value (in any `node.attrs` or `mark.attrs`) that Yjs
 * cannot store — i.e. `undefined`, a `function`, a `symbol`, or a `bigint`
 * (e.g. `content[3].content[0].attrs.indent (undefined)`). Returns `null` when
 * every attribute is storable. Null-safe.
 */
export function findUnstorableAttr(doc) {
    const isUnstorable = (value) => {
        if (value === undefined)
            return "undefined";
        const t = typeof value;
        if (t === "function")
            return "function";
        if (t === "symbol")
            return "symbol";
        if (t === "bigint")
            return "bigint";
        return null;
    };
    // Check an attrs object; return the offending sub-path or null.
    const checkAttrs = (attrs, basePath) => {
        if (!isObject(attrs))
            return null;
        for (const key of Object.keys(attrs)) {
            const kind = isUnstorable(attrs[key]);
            if (kind != null)
                return `${basePath}.${key} (${kind})`;
        }
        return null;
    };
    const walk = (node, path) => {
        if (!isObject(node))
            return null;
        const attrHit = checkAttrs(node.attrs, `${path}.attrs`);
        if (attrHit != null)
            return attrHit;
        if (Array.isArray(node.marks)) {
            for (let i = 0; i < node.marks.length; i++) {
                const markHit = checkAttrs(node.marks[i]?.attrs, `${path}.marks[${i}].attrs`);
                if (markHit != null)
                    return markHit;
            }
        }
        if (Array.isArray(node.content)) {
            for (let i = 0; i < node.content.length; i++) {
                const childHit = walk(node.content[i], `${path}.content[${i}]`);
                if (childHit != null)
                    return childHit;
            }
        }
        return null;
    };
    // The root doc node carries no useful index, so start the path at "doc".
    if (!isObject(doc))
        return null;
    const attrHit = checkAttrs(doc.attrs, "attrs");
    if (attrHit != null)
        return attrHit;
    if (Array.isArray(doc.content)) {
        for (let i = 0; i < doc.content.length; i++) {
            const childHit = walk(doc.content[i], `content[${i}]`);
            if (childHit != null)
                return childHit;
        }
    }
    return null;
}
/**
 * Table structural node types and the container each must live directly inside.
 * Used by `insertNodeRelative` to splice rows/cells into the correct ancestor
 * rather than blindly into the anchor's direct parent (which would corrupt the
 * table's nesting).
 */
const STRUCTURAL_TYPES = new Set(["tableRow", "tableCell", "tableHeader"]);
const REQUIRED_CONTAINER = {
    tableRow: "table",
    tableCell: "tableRow",
    tableHeader: "tableRow",
};
/**
 * Find the index of the first TOP-LEVEL block whose plain text includes the
 * anchor, with a markdown-stripping FALLBACK. Returns -1 when none matches.
 *
 * Two passes preserve "exact wins globally":
 *  - Pass 1: first block containing the verbatim `anchorText`.
 *  - Pass 2 (only if pass 1 found nothing): first block containing the
 *    markdown-stripped anchor, when stripping actually changed it.
 */
function findAnchorTextIndex(content, anchorText) {
    if (!Array.isArray(content))
        return -1;
    // Pass 1: exact.
    for (let i = 0; i < content.length; i++) {
        if (blockPlainText(content[i]).includes(anchorText))
            return i;
    }
    // Pass 2: markdown-stripped fallback.
    const a = stripInlineMarkdown(anchorText);
    if (a !== anchorText && a.length > 0) {
        for (let i = 0; i < content.length; i++) {
            if (blockPlainText(content[i]).includes(a))
                return i;
        }
    }
    return -1;
}
/**
 * Locate an anchor and return its ancestor chain (from `doc` down to and
 * including the matched node). Each chain entry is `{ node, index }` where
 * `index` is the node's position inside its parent's `content` array (the root
 * doc has index -1). Returns `null` when the anchor cannot be resolved.
 */
function findAnchorChain(doc, opts) {
    if (!isObject(doc))
        return null;
    // DFS by id anywhere in the tree, accumulating the path.
    if (opts.anchorNodeId != null) {
        const targetId = opts.anchorNodeId;
        const search = (node, index, trail) => {
            if (!isObject(node))
                return null;
            const here = [...trail, { node, index }];
            if (matchesId(node, targetId))
                return here;
            if (Array.isArray(node.content)) {
                for (let i = 0; i < node.content.length; i++) {
                    const hit = search(node.content[i], i, here);
                    if (hit != null)
                        return hit;
                }
            }
            return null;
        };
        return search(doc, -1, []);
    }
    // By text: only top-level blocks are scanned (same rule as the JSON path).
    // Exact match wins; a markdown-stripped fallback is tried only on a miss.
    if (opts.anchorText != null && Array.isArray(doc.content)) {
        const i = findAnchorTextIndex(doc.content, opts.anchorText);
        if (i !== -1) {
            return [
                { node: doc, index: -1 },
                { node: doc.content[i], index: i },
            ];
        }
    }
    return null;
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
export function insertNodeRelative(doc, node, opts) {
    const out = clone(doc);
    const fresh = clone(node);
    // Defensive: stay null-safe like the other exports — a missing opts means
    // there is nothing actionable to do.
    if (!isObject(opts))
        return { doc: out, inserted: false };
    const isStructural = isObject(node) && STRUCTURAL_TYPES.has(node.type);
    // "append": top-level push.
    if (opts.position === "append") {
        // Structural table nodes (tableRow/tableCell/tableHeader) cannot live at the
        // top level — appending one would produce invalid nesting.
        if (isStructural) {
            throw new Error(`insert_node: cannot append a ${node.type} at the top level; use ` +
                `position before/after with an anchor inside the target table`);
        }
        if (isObject(out)) {
            if (!Array.isArray(out.content))
                out.content = [];
            out.content.push(fresh);
            return { doc: out, inserted: true };
        }
        return { doc: out, inserted: false };
    }
    const offset = opts.position === "after" ? 1 : 0;
    // Structural insert (before/after a tableRow/tableCell/tableHeader): splice
    // into the nearest enclosing table/tableRow rather than the anchor's direct
    // parent, so the row/cell lands at the correct level of the table.
    if (isStructural) {
        const containerType = REQUIRED_CONTAINER[node.type];
        const chain = findAnchorChain(out, opts);
        // Anchor not resolved at all — keep the existing "anchor not found" path.
        if (chain == null)
            return { doc: out, inserted: false };
        // Find the DEEPEST ancestor (including the anchor itself) of the required
        // container type.
        let containerIdx = -1;
        for (let i = chain.length - 1; i >= 0; i--) {
            if (isObject(chain[i].node) && chain[i].node.type === containerType) {
                containerIdx = i;
                break;
            }
        }
        if (containerIdx === -1) {
            throw new Error(`insert_node: cannot insert a ${node.type} here — the anchor is not ` +
                `inside a ${containerType}. Anchor on a cell's text or a block id ` +
                `that lives inside the target table.`);
        }
        const container = chain[containerIdx].node;
        if (!Array.isArray(container.content))
            container.content = [];
        if (containerIdx === chain.length - 1) {
            // The matched container IS the anchor node itself (e.g. anchorText
            // resolved to the table block): append/prepend within it.
            const at = opts.position === "after" ? container.content.length : 0;
            container.content.splice(at, 0, fresh);
        }
        else {
            // The immediate child on the path leading to the anchor is the row/cell
            // to splice next to.
            const enclosingChildIndex = chain[containerIdx + 1].index;
            container.content.splice(enclosingChildIndex + offset, 0, fresh);
        }
        return { doc: out, inserted: true };
    }
    // Resolve by id anywhere in the tree: splice into the parent content array.
    if (opts.anchorNodeId != null) {
        let inserted = false;
        const walkContent = (content) => {
            for (let i = 0; i < content.length; i++) {
                const child = content[i];
                if (matchesId(child, opts.anchorNodeId)) {
                    content.splice(i + offset, 0, fresh);
                    inserted = true;
                    return;
                }
                if (isObject(child) && Array.isArray(child.content)) {
                    walkContent(child.content);
                    if (inserted)
                        return;
                }
            }
        };
        if (isObject(out) && Array.isArray(out.content)) {
            walkContent(out.content);
        }
        return { doc: out, inserted };
    }
    // Resolve by text: only top-level doc.content blocks are scanned. Exact
    // match wins; a markdown-stripped fallback is tried only on a miss.
    if (opts.anchorText != null && isObject(out) && Array.isArray(out.content)) {
        const i = findAnchorTextIndex(out.content, opts.anchorText);
        if (i !== -1) {
            out.content.splice(i + offset, 0, fresh);
            return { doc: out, inserted: true };
        }
    }
    return { doc: out, inserted: false };
}
// ===========================================================================
// Table editing helpers
//
// A Docmost table is a ProseMirror subtree with NO ids on the structural nodes:
//   table   -> { type:"table",     content:[tableRow...] }
//   row     -> { type:"tableRow",  content:[tableCell|tableHeader...] }
//   cell    -> { type:"tableCell"|"tableHeader", attrs:{colspan,rowspan,colwidth},
//                content:[paragraph...] }
//   para    -> { type:"paragraph", attrs:{id,indent}, content:[textNode...] }
// Only paragraphs/headings carry an `attrs.id`, so a cell is addressed via the
// id of the paragraph inside it. The helpers below all operate on a DEEP CLONE
// of the input doc (via `clone`) and never mutate their inputs.
// ===========================================================================
/**
 * Collect EVERY `attrs.id` present anywhere in `node` into `used`. Used to seed
 * `makeFreshId` so generated paragraph ids never collide with existing ones.
 */
function collectIds(node, used) {
    if (!isObject(node))
        return;
    if (isObject(node.attrs) && typeof node.attrs.id === "string") {
        used.add(node.attrs.id);
    }
    if (Array.isArray(node.content)) {
        for (const child of node.content)
            collectIds(child, used);
    }
}
/**
 * Fresh-id generator: returns a random Docmost-style id (12 chars from
 * lowercase `a-z0-9`) that is not already in `used`, and records it. On the
 * rare collision the id is regenerated. Callers rely on uniqueness, not on the
 * exact string, so randomness is fine — and unlike a module-local counter it
 * needs no reset and cannot become predictable across calls.
 */
function makeFreshId(used) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id;
    do {
        id = "";
        for (let i = 0; i < 12; i++) {
            id += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
    } while (used.has(id) || id === "");
    used.add(id);
    return id;
}
/**
 * Resolve a table reference against an ALREADY-CLONED doc and return the LIVE
 * table node (a reference inside `rootClone`, so the caller may mutate it) plus
 * its index path. Returns null when no table matches.
 *
 * - `#<n>`: the top-level block at index `n`, only if its `type === "table"`.
 * - otherwise: DFS for the node with `attrs.id === tableRef`, then walk UP its
 *   ancestor chain to the nearest `type === "table"` ancestor.
 */
function locateTable(rootClone, tableRef) {
    if (!isObject(rootClone))
        return null;
    // "#<n>": index into the top-level content array; must be a table.
    const indexMatch = typeof tableRef === "string" ? tableRef.match(/^#(\d+)$/) : null;
    if (indexMatch) {
        const index = Number(indexMatch[1]);
        const block = Array.isArray(rootClone.content)
            ? rootClone.content[index]
            : undefined;
        if (isObject(block) && block.type === "table") {
            return { table: block, path: [index] };
        }
        return null;
    }
    // Otherwise: DFS for attrs.id === tableRef, tracking the ancestor chain, then
    // climb to the nearest enclosing table.
    const search = (node, trail) => {
        if (!isObject(node))
            return null;
        if (Array.isArray(node.content)) {
            for (let i = 0; i < node.content.length; i++) {
                const child = node.content[i];
                const here = [...trail, { node: child, index: i }];
                if (matchesId(child, tableRef)) {
                    // Walk UP to the nearest table ancestor (including the match itself).
                    for (let j = here.length - 1; j >= 0; j--) {
                        if (isObject(here[j].node) && here[j].node.type === "table") {
                            return {
                                table: here[j].node,
                                path: here.slice(0, j + 1).map((e) => e.index),
                            };
                        }
                    }
                    return null; // id found but no enclosing table
                }
                const hit = search(child, here);
                if (hit != null)
                    return hit;
            }
        }
        return null;
    };
    return search(rootClone, []);
}
/** Build the plain-text → single-paragraph cell content used by all writers. */
function makeCellParagraph(id, text) {
    return {
        type: "paragraph",
        attrs: { id, indent: 0 },
        // Empty string → a paragraph with an empty content array.
        content: text ? [{ type: "text", text }] : [],
    };
}
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
export function readTable(doc, tableRef) {
    const root = clone(doc);
    const located = locateTable(root, tableRef);
    if (located == null)
        return null;
    const { table, path } = located;
    const rowNodes = Array.isArray(table.content) ? table.content : [];
    const rows = rowNodes.length;
    const cols = rowNodes[0]?.content?.length ?? 0;
    const cells = [];
    const cellIds = [];
    for (const rowNode of rowNodes) {
        const cellNodes = Array.isArray(rowNode?.content) ? rowNode.content : [];
        const rowText = [];
        const rowIds = [];
        for (const cellNode of cellNodes) {
            rowText.push(blockPlainText(cellNode));
            // The cell's first paragraph carries the id used for patch_node.
            const firstPara = Array.isArray(cellNode?.content)
                ? cellNode.content[0]
                : undefined;
            const id = isObject(firstPara) && isObject(firstPara.attrs)
                ? firstPara.attrs.id ?? null
                : null;
            rowIds.push(id);
        }
        cells.push(rowText);
        cellIds.push(rowIds);
    }
    return { rows, cols, cells, cellIds, path };
}
/**
 * Insert a row of plain-text cells into a table. Returns `{ doc, inserted }`.
 *
 * The row is padded to the table's column count (`cells[i] ?? ""`); supplying
 * MORE cells than columns throws. Each new cell copies `colwidth` for its
 * column from the header row when present, gets a fresh-id paragraph, and a
 * `colspan:1, rowspan:1` attrs. `index` (when an integer in `[0, rows]`) splices
 * the row there; otherwise the row is appended at the end.
 */
export function insertTableRow(doc, tableRef, cells, index) {
    const out = clone(doc);
    const located = locateTable(out, tableRef);
    if (located == null)
        return { doc: out, inserted: false };
    const { table } = located;
    if (!Array.isArray(table.content))
        table.content = [];
    const rows = table.content.length;
    const headerRow = table.content[0];
    const headerCells = Array.isArray(headerRow?.content) ? headerRow.content : [];
    // Column count is the WIDEST existing row, so the guard below stays
    // meaningful for ragged tables and the new row matches the table's width.
    // Fall back to the supplied cell count only when the table has no rows.
    let colCount = 0;
    for (const r of table.content) {
        if (isObject(r) && Array.isArray(r.content))
            colCount = Math.max(colCount, r.content.length);
    }
    if (colCount === 0)
        colCount = Array.isArray(cells) ? cells.length : 0;
    if (Array.isArray(cells) && cells.length > colCount) {
        throw new Error(`table_insert_row: got ${cells.length} cell(s) but the table has ${colCount} column(s)`);
    }
    // Resolve the landing index up front so the cell-type decision and the splice
    // below agree: a valid integer in [0, rows] splices there, else we append.
    const landingIndex = typeof index === "number" && Number.isInteger(index) && index >= 0 && index <= rows
        ? index
        : rows;
    // Seed the id generator with every id already in the doc so the new cell
    // paragraph ids are unique within the whole document.
    const used = new Set();
    collectIds(out, used);
    const newCells = [];
    for (let i = 0; i < colCount; i++) {
        const text = (Array.isArray(cells) ? cells[i] : undefined) ?? "";
        const attrs = { colspan: 1, rowspan: 1 };
        // Copy this column's colwidth from the header row's cell when present.
        const colwidth = headerCells[i]?.attrs?.colwidth;
        if (colwidth !== undefined)
            attrs.colwidth = colwidth;
        // A row landing at index 0 becomes the new header row, so inherit the
        // current header cell's type per column (Docmost uses "tableHeader" there);
        // every other position is a plain data cell.
        const cellType = landingIndex === 0 ? headerCells[i]?.type ?? "tableCell" : "tableCell";
        newCells.push({
            type: cellType,
            attrs,
            content: [makeCellParagraph(makeFreshId(used), text)],
        });
    }
    const newRow = { type: "tableRow", content: newCells };
    // Splice at the resolved landing index (append when index was omitted/invalid).
    table.content.splice(landingIndex, 0, newRow);
    return { doc: out, inserted: true };
}
/**
 * Delete the row at 0-based `index` from a table. Returns `{ doc, deleted }`.
 * `deleted` is false only when the table cannot be located. Throws on an
 * out-of-range index, and refuses to delete the table's only row.
 */
export function deleteTableRow(doc, tableRef, index) {
    const out = clone(doc);
    const located = locateTable(out, tableRef);
    if (located == null)
        return { doc: out, deleted: false };
    const { table } = located;
    if (!Array.isArray(table.content))
        table.content = [];
    const rows = table.content.length;
    if (!Number.isInteger(index) || index < 0 || index >= rows) {
        throw new Error(`table_delete_row: row index ${index} out of range (table has ${rows} row(s))`);
    }
    if (rows <= 1) {
        throw new Error("table_delete_row: refusing to delete the only row of the table");
    }
    table.content.splice(index, 1);
    return { doc: out, deleted: true };
}
/**
 * Set the plain-text content of cell `[row, col]` (0-based) to `text`. Returns
 * `{ doc, updated }`; `updated` is false only when the table cannot be located.
 * Throws when `row`/`col` is out of range. The cell's own attrs (colspan/
 * rowspan/colwidth) are preserved; its content becomes a single text paragraph
 * that reuses the cell's existing first-paragraph id when present, else a fresh
 * one.
 */
export function updateTableCell(doc, tableRef, row, col, text) {
    const out = clone(doc);
    const located = locateTable(out, tableRef);
    if (located == null)
        return { doc: out, updated: false };
    const { table } = located;
    const rowNodes = Array.isArray(table.content) ? table.content : [];
    const rows = rowNodes.length;
    const rowNode = rowNodes[row];
    const cols = isObject(rowNode) && Array.isArray(rowNode.content)
        ? rowNode.content.length
        : 0;
    if (!Number.isInteger(row) ||
        row < 0 ||
        row >= rows ||
        !Number.isInteger(col) ||
        col < 0 ||
        col >= cols) {
        throw new Error(`table_update_cell: cell [${row},${col}] out of range`);
    }
    const cellNode = rowNode.content[col];
    // Reuse the cell's existing first-paragraph id, or mint a fresh unique one.
    const existingPara = Array.isArray(cellNode?.content)
        ? cellNode.content[0]
        : undefined;
    let id = isObject(existingPara) && isObject(existingPara.attrs)
        ? existingPara.attrs.id
        : undefined;
    if (typeof id !== "string" || id.length === 0) {
        const used = new Set();
        collectIds(out, used);
        id = makeFreshId(used);
    }
    cellNode.content = [makeCellParagraph(id, text)];
    return { doc: out, updated: true };
}
