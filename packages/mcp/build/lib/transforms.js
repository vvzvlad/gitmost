/**
 * Pure, network-free transform primitives for a ProseMirror/TipTap document
 * tree, plus one higher-level orchestration (commentsToFootnotes).
 *
 * A ProseMirror node here is a plain JSON object of the shape produced by
 * Docmost: `{ type, attrs?, content?, text?, marks? }`. Children live in the
 * `content` array; callouts, tables, lists all hold their children in
 * `content`, so a single recursive walk reaches them all.
 *
 * Conventions (matching node-ops.ts):
 *  - functions that produce a new document deep-clone their input and return a
 *    `{ doc, ... }` object; the caller's objects are never mutated.
 *  - functions are defensively null-safe.
 *  - `marks` arrays are preserved verbatim when fragments are split/reordered.
 */
import { blockPlainText } from "./node-ops.js";
import { canonicalizeFootnotes } from "./footnote-canonicalize.js";
import { footnoteContentKey, makeFootnoteDefinition, generateFootnoteId, } from "./footnote-authoring.js";
export { canonicalizeFootnotes } from "./footnote-canonicalize.js";
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
/**
 * Plain text of a node (re-export of node-ops' blockPlainText so transform
 * authors have a single import surface). Recurses through nested content.
 */
export function blockText(node) {
    return blockPlainText(node);
}
/**
 * Depth-first visit of every node in the tree, including the root and the
 * nested content of callouts, tables, lists, etc. `fn` is called once per node.
 * Null-safe: a nullish or non-object node is ignored.
 */
export function walk(node, fn) {
    if (!isObject(node))
        return;
    fn(node);
    if (Array.isArray(node.content)) {
        for (const child of node.content) {
            walk(child, fn);
        }
    }
}
/**
 * Find the FIRST node (depth-first) matching `predicate`, anywhere in the tree.
 * Works even when the node carries no `attrs.id` (it searches the raw tree, not
 * an id index). Returns the live node reference inside `doc` (NOT a clone), or
 * null when nothing matches. Typical use: `getList(doc, n => n.type ===
 * "orderedList")`.
 */
export function getList(doc, predicate) {
    let found = null;
    walk(doc, (node) => {
        if (found == null && predicate(node)) {
            found = node;
        }
    });
    return found;
}
/**
 * Textblocks that hold raw text but do NOT accept inline atom nodes. A
 * `footnoteReference` is `group:"inline", atom:true`; `codeBlock` is
 * `content:"text*"` (text only), so splicing a footnoteReference into it yields
 * an invalid document. (paragraph/heading/detailsSummary are `inline*` and DO
 * accept it; footnote definitions live inside a footnotesList which the
 * footnote inserter excludes via `beforeBlock`.)
 */
const INLINE_ATOM_FORBIDDEN_BLOCKS = new Set(["codeBlock"]);
/**
 * Footnote-notes subtrees the inline footnote inserter must never split into (at
 * any depth): a `footnotesList` and the `footnoteDefinition`s it holds. Anchoring
 * a reference inside one of these would later be dropped as an orphan by the
 * canonicalizer, taking the existing definition's text with it.
 */
const FOOTNOTE_NOTES_SUBTREES = new Set([
    "footnotesList",
    "footnoteDefinition",
]);
/** True if `node` IS, or contains at any depth, a footnotesList/footnoteDefinition. */
function containsFootnoteNotes(node) {
    if (!isObject(node))
        return false;
    if (FOOTNOTE_NOTES_SUBTREES.has(node.type))
        return true;
    if (Array.isArray(node.content)) {
        return node.content.some((c) => containsFootnoteNotes(c));
    }
    return false;
}
/**
 * Insert `marker` as a PLAIN (unmarked) text run right after the first
 * occurrence of `anchor`.
 *
 * The text run that contains the END of the anchor is SPLIT at the anchor end,
 * so all existing marks (links, bold, ...) on the surrounding text are
 * preserved, while the inserted marker run carries NO marks. The marker is
 * inserted as a leading-space-padded run (`" " + marker`) so it visually
 * separates from the preceding word.
 *
 * The anchor is matched against the concatenated plain text of each top-level
 * block (so an anchor that spans several text/mark runs still matches). The
 * insertion happens inside the inline content array that holds the anchor's
 * final character.
 *
 * Operates on a clone of `doc`; returns `{ doc, inserted }`. `inserted` is
 * false when the anchor text was not found in any in-scope block.
 */
export function insertMarkerAfter(doc, anchor, marker, opts = {}) {
    // A plain marker is a leading-space-padded unmarked text run.
    return insertNodesAfterAnchor(doc, anchor, () => [{ type: "text", text: " " + marker }], opts);
}
/**
 * Mark-safe insertion CORE: split the inline text run that holds the END of
 * `anchor` (preserving the surrounding marks) and splice the nodes produced by
 * `makeMiddle()` in at the split point. `insertMarkerAfter` (plain text marker)
 * and `insertInlineFootnote` (a `footnoteReference` node) are both thin callers —
 * the only difference is WHAT is inserted (a space-padded text run vs. a node
 * that should hug the preceding word), which is exactly what `makeMiddle`
 * decides. Operates on a clone; returns `{ doc, inserted }`.
 */
function insertNodesAfterAnchor(doc, anchor, makeMiddle, opts = {}) {
    const out = clone(doc);
    if (!isObject(out) || !Array.isArray(out.content) || !anchor) {
        return { doc: out, inserted: false };
    }
    const limit = typeof opts.beforeBlock === "number"
        ? Math.min(opts.beforeBlock, out.content.length)
        : out.content.length;
    for (let b = 0; b < limit; b++) {
        const block = out.content[b];
        if (!isObject(block))
            continue;
        // Quick reject: skip blocks whose plain text cannot contain the anchor.
        if (!blockPlainText(block).includes(anchor))
            continue;
        // Walk the inline content arrays inside this block, tracking a running
        // character offset so we can locate the inline array + text run that holds
        // the END of the anchor's first occurrence.
        let inserted = false;
        let offset = 0; // characters of plain text seen so far in this block
        const anchorEnd = (() => blockPlainText(block).indexOf(anchor) + anchor.length)();
        // Recurse into inline-bearing containers (paragraph, heading, table cell,
        // callout child paragraphs, ...). We only split inside an array of inline
        // nodes (text/inline atoms); the FIRST array whose cumulative range covers
        // anchorEnd receives the split + marker.
        const visit = (container) => {
            if (inserted || !isObject(container) || !Array.isArray(container.content)) {
                return;
            }
            // Skip a forbidden subtree entirely (e.g. footnotesList/footnoteDefinition):
            // never split into it, but keep `offset` aligned for any sibling text after
            // it within this block.
            if (opts.skipSubtreeTypes && opts.skipSubtreeTypes.has(container.type)) {
                offset += blockPlainText(container).length;
                return;
            }
            const inline = container.content;
            // Detect whether this array is an inline array (contains text nodes).
            const hasText = inline.some((n) => isObject(n) && n.type === "text");
            if (hasText) {
                // Refuse a textblock whose content spec cannot hold the inserted nodes
                // (e.g. a codeBlock for an inline atom). Keep `offset` aligned for any
                // sibling textblocks in this same block, then bail so the search falls
                // through to the next candidate block.
                if (opts.forbidBlockTypes && opts.forbidBlockTypes.has(container.type)) {
                    offset += blockPlainText(container).length;
                    return;
                }
                for (let i = 0; i < inline.length; i++) {
                    const n = inline[i];
                    const len = isObject(n) ? blockPlainText(n).length : 0;
                    const runStart = offset;
                    const runEnd = offset + len;
                    // The run that contains the anchor end (anchorEnd lands inside this
                    // run, i.e. runStart < anchorEnd <= runEnd) is the split point.
                    if (!inserted &&
                        isObject(n) &&
                        n.type === "text" &&
                        typeof n.text === "string" &&
                        anchorEnd > runStart &&
                        anchorEnd <= runEnd) {
                        const cut = anchorEnd - runStart; // split index within this text run
                        const before = n.text.slice(0, cut);
                        const after = n.text.slice(cut);
                        const marks = Array.isArray(n.marks) ? n.marks : [];
                        const parts = [];
                        if (before.length > 0) {
                            parts.push({ ...n, text: before, marks: [...marks] });
                        }
                        // The inserted nodes are caller-decided (a space-padded marker run,
                        // or a node that hugs the word). They carry no copied marks.
                        parts.push(...makeMiddle());
                        if (after.length > 0) {
                            parts.push({ ...n, text: after, marks: [...marks] });
                        }
                        inline.splice(i, 1, ...parts);
                        inserted = true;
                        return;
                    }
                    offset = runEnd;
                }
            }
            else {
                // Not an inline array: recurse into children (e.g. callout -> paragraph).
                for (const child of inline) {
                    visit(child);
                    if (inserted)
                        return;
                }
            }
        };
        visit(block);
        if (inserted) {
            return { doc: out, inserted: true };
        }
        // If the block matched in plain text but we could not split (e.g. anchor
        // lands inside an atom), fall through to the next block rather than failing.
    }
    return { doc: out, inserted: false };
}
/**
 * In the disclaimer callout, replace a `[1]…[K]` range marker with `[1]…[n]`.
 *
 * Docmost translations use a callout that states the footnote range, e.g.
 * "[1]…[5]". When the number of notes changes, this rewrites the trailing
 * number of any `[1]…[K]` (or `[1]...[K]`, ASCII ellipsis) occurrence found in a
 * callout's text nodes to `[1]…[n]`. Operates on a clone; returns
 * `{ doc, changed }` where `changed` is the number of text nodes rewritten.
 */
export function setCalloutRange(doc, n) {
    const out = clone(doc);
    let changed = 0;
    // Match "[1]" + (… or ...) + "[<digits>]"; rewrite the last number to n.
    const rangeRe = /(\[1\]\s*(?:…|\.\.\.)\s*\[)\d+(\])/g;
    walk(out, (node) => {
        if (node.type === "callout") {
            walk(node, (inner) => {
                if (inner.type === "text" &&
                    typeof inner.text === "string" &&
                    rangeRe.test(inner.text)) {
                    rangeRe.lastIndex = 0;
                    inner.text = inner.text.replace(rangeRe, `$1${n}$2`);
                    changed++;
                }
                rangeRe.lastIndex = 0;
            });
        }
    });
    return { doc: out, changed };
}
/**
 * Generate a short random id for a new block's `attrs.id`. Docmost uses nanoid;
 * a base36 random string is sufficient here (uniqueness within one document).
 */
function freshId() {
    return (Math.random().toString(36).slice(2, 12) +
        Math.random().toString(36).slice(2, 6));
}
/**
 * Wrap inline ProseMirror nodes in a list item:
 *   { type:"listItem", content:[{ type:"paragraph", attrs:{id}, content: inlineNodes }] }
 * with a fresh random block id on the paragraph. The inline nodes are cloned so
 * the result shares no references with the caller's input.
 */
export function noteItem(inlineNodes) {
    const content = Array.isArray(inlineNodes) ? clone(inlineNodes) : [];
    return {
        type: "listItem",
        content: [
            {
                type: "paragraph",
                attrs: { id: freshId() },
                content,
            },
        ],
    };
}
/**
 * Wrap inline ProseMirror nodes in a real footnoteDefinition node keyed by id:
 *   { type:"footnoteDefinition", attrs:{id}, content:[{ type:"paragraph", content }] }
 * (mirrors the editor-ext / docmost-schema FootnoteDefinition node).
 *
 * Built on the shared `makeFootnoteDefinition` factory (footnote-authoring.ts);
 * the only extra is a fresh block id on the inner paragraph (Docmost stamps one,
 * and the canonicalizer preserves attrs as-is). Single factory, one place to
 * change the definition shape.
 */
export function footnoteDefinition(id, inlineNodes) {
    const node = makeFootnoteDefinition(id, inlineNodes);
    node.content[0].attrs = { id: freshId() };
    return node;
}
/**
 * Replace every `[N]` body marker and `\u0000FN<i>\u0000` comment placeholder in
 * an inline content array with a real `footnoteReference` node, in reading
 * order. `onMarker` is called for each replaced marker (with the original `[N]`
 * number or the placeholder index) and returns the fresh footnote id to attach
 * to the inserted node. Mutates `inline` in place.
 */
function replaceMarkersWithReferences(inline, onMarker) {
    const re = /\[(\d+)\]|\u0000FN(\d+)\u0000/g;
    for (let i = 0; i < inline.length; i++) {
        const n = inline[i];
        if (!isObject(n) || n.type !== "text" || typeof n.text !== "string") {
            continue;
        }
        if (!re.test(n.text))
            continue;
        re.lastIndex = 0;
        const marks = Array.isArray(n.marks) ? n.marks : [];
        const parts = [];
        let last = 0;
        let m;
        while ((m = re.exec(n.text)) !== null) {
            if (m.index > last) {
                parts.push({ ...n, text: n.text.slice(last, m.index), marks: [...marks] });
            }
            const oldNum = m[1] != null ? Number(m[1]) : undefined;
            const phIdx = m[2] != null ? Number(m[2]) : undefined;
            const fnId = onMarker({ oldNum, phIdx });
            parts.push({ type: "footnoteReference", attrs: { id: fnId } });
            last = m.index + m[0].length;
        }
        if (last < n.text.length) {
            parts.push({ ...n, text: n.text.slice(last), marks: [...marks] });
        }
        // Drop any zero-length text runs the slicing may have produced.
        const cleaned = parts.filter((p) => p.type !== "text" || (typeof p.text === "string" && p.text.length > 0));
        inline.splice(i, 1, ...cleaned);
        i += cleaned.length - 1;
    }
}
/**
 * Convert a comment's markdown (e.g. `**Lead.** body...`) into inline
 * ProseMirror nodes.
 *
 * A leading `комментарий: ` (case-insensitive) or `N. ` numeric prefix is
 * stripped first. Then a minimal bold-split is applied: a leading
 * `**bold lead**` run becomes a text node with a bold mark, and the remainder
 * becomes a plain text node. This keeps the conversion synchronous (the
 * transform sandbox runs synchronously) and dependency-free; the existing
 * async markdownToProseMirror is intentionally NOT used here.
 */
export function mdToInlineNodes(markdown) {
    let md = typeof markdown === "string" ? markdown : "";
    // Strip a leading "комментарий: " prefix (case-insensitive) or a "N. " prefix.
    md = md.replace(/^\s*комментарий\s*:\s*/i, "");
    md = md.replace(/^\s*\d+\.\s+/, "");
    md = md.trim();
    if (md === "")
        return [];
    const nodes = [];
    // Leading bold lead: **...** at the very start.
    const leadMatch = /^\*\*([^*]+)\*\*\s*/.exec(md);
    if (leadMatch) {
        const leadText = leadMatch[1];
        nodes.push({
            type: "text",
            text: leadText,
            marks: [{ type: "bold" }],
        });
        const rest = md.slice(leadMatch[0].length);
        if (rest.length > 0) {
            // Preserve the separating space that followed the bold lead.
            const sep = /^\*\*[^*]+\*\*(\s*)/.exec(md);
            const spacing = sep ? sep[1] : "";
            nodes.push({ type: "text", text: spacing + rest });
        }
        return nodes;
    }
    // No bold lead: emit the whole thing as a single plain text node, with any
    // remaining **bold** spans split out inline.
    return splitInlineBold(md);
}
/**
 * Split a string with inline `**bold**` spans into text nodes, bolding the
 * spans. Used as the no-lead fallback in mdToInlineNodes.
 */
function splitInlineBold(text) {
    const nodes = [];
    const re = /\*\*([^*]+)\*\*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
            nodes.push({ type: "text", text: text.slice(last, m.index) });
        }
        nodes.push({ type: "text", text: m[1], marks: [{ type: "bold" }] });
        last = m.index + m[0].length;
    }
    if (last < text.length) {
        nodes.push({ type: "text", text: text.slice(last) });
    }
    return nodes.length > 0 ? nodes : [{ type: "text", text }];
}
/**
 * Turn inline comments into numbered footnotes.
 *
 * For each inline comment that carries a `selection`:
 *   1. insert a placeholder marker (a NUL-delimited "\u0000FN<i>\u0000"
 *      sentinel) right after the selection text in the BODY (before the
 *      notes heading);
 *   2. build a note list item from the comment's markdown content.
 *
 * Then RENUMBER every footnote marker in the body by reading order: existing
 * `[N]` markers and the new "\u0000FN<i>\u0000" placeholders are both replaced by a
 * sequential `[seq]`, and the notes orderedList is reordered so each note lines
 * up with its marker's reading-order position. Finally the disclaimer callout
 * range is synced to the new note count.
 *
 * Returns `{ doc, consumed }` where `consumed` lists the ids of comments that
 * were successfully anchored (their selection was found and a placeholder
 * inserted). Operates on a clone of `doc`.
 */
export function commentsToFootnotes(doc, comments, opts = {}) {
    let working = clone(doc);
    const notesHeading = opts.notesHeading ?? "Примечания переводчика";
    const top = Array.isArray(working.content) ? working.content : [];
    const notesIdx = top.findIndex((n) => isObject(n) && n.type === "heading" && blockText(n).trim() === notesHeading);
    if (notesIdx < 0) {
        throw new Error(`heading "${notesHeading}" not found`);
    }
    // The notes orderedList lives at or after the heading.
    const notesList = top
        .slice(notesIdx)
        .find((n) => isObject(n) && n.type === "orderedList");
    if (!notesList) {
        throw new Error("notes orderedList not found");
    }
    const consumed = [];
    const noteInlineByPh = new Map();
    (Array.isArray(comments) ? comments : []).forEach((c, i) => {
        if (!c || !c.selection)
            return;
        // Collision-proof sentinel delimited by NUL control chars, which never occur
        // in real Docmost prose - so the marker regex cannot mistake any body text
        // (e.g. "Press F1 for help", model "FN2") for a placeholder. The NUL is
        // transient: the placeholder is inserted here and replaced by a
        // footnoteReference node below; it never persists in a returned document.
        const ph = `\u0000FN${i}\u0000`;
        // insertMarkerAfter returns a NEW cloned doc; reassign `working`.
        const r = insertMarkerAfter(working, c.selection.trimEnd(), ph, {
            beforeBlock: notesIdx,
        });
        if (!r.inserted)
            return;
        working = r.doc;
        noteInlineByPh.set(ph, mdToInlineNodes(c.content));
        consumed.push(c.id);
    });
    // Re-resolve references into the (possibly re-cloned) working doc.
    const top2 = Array.isArray(working.content) ? working.content : [];
    const notesIdx2 = top2.findIndex((n) => isObject(n) && n.type === "heading" && blockText(n).trim() === notesHeading);
    const oldListIndex = top2.findIndex((n) => isObject(n) && n.type === "orderedList");
    const notesList2 = oldListIndex >= 0 ? top2[oldListIndex] : null;
    if (!notesList2) {
        throw new Error("notes orderedList not found");
    }
    // Inline content of each existing note (listItem -> paragraph -> inline).
    const oldNoteInline = (Array.isArray(notesList2.content)
        ? notesList2.content
        : []).map((item) => {
        const para = isObject(item) && Array.isArray(item.content)
            ? item.content.find((c) => isObject(c) && c.type === "paragraph")
            : null;
        return para && Array.isArray(para.content) ? para.content : [];
    });
    // Walk the body in reading order, turning each "[N]" / placeholder marker into
    // a real footnoteReference node and collecting its definition inline content.
    const definitions = [];
    const disclaimerRangeRe = /(\[1\]\s*(?:…|\.\.\.)\s*\[)\d+(\])/;
    // Recursively visit inline arrays inside a block (paragraph, heading, callout
    // child paragraphs, table cells, ...), preserving document reading order.
    const visitInlineArrays = (container) => {
        if (!isObject(container) || !Array.isArray(container.content))
            return;
        const hasText = container.content.some((n) => isObject(n) && n.type === "text");
        if (hasText) {
            replaceMarkersWithReferences(container.content, ({ oldNum, phIdx }) => {
                const fnId = freshId();
                if (oldNum != null) {
                    const inline = oldNoteInline[oldNum - 1];
                    // Every existing body marker MUST map to a real note. An out-of-range
                    // marker means the document is internally inconsistent; fail loudly.
                    if (inline === undefined) {
                        throw new Error(`footnote [${oldNum}] has no matching note (notes list has ${oldNoteInline.length} items); document is inconsistent`);
                    }
                    definitions.push(footnoteDefinition(fnId, inline));
                }
                else {
                    const inline = noteInlineByPh.get(`\u0000FN${phIdx}\u0000`) || [];
                    definitions.push(footnoteDefinition(fnId, inline));
                }
                return fnId;
            });
        }
        else {
            for (const child of container.content)
                visitInlineArrays(child);
        }
    };
    const notesBoundary = notesIdx2 >= 0 ? notesIdx2 : oldListIndex;
    for (let i = 0; i < notesBoundary; i++) {
        // Skip ONLY the disclaimer callout: its "[1]...[K]" range is NOT a footnote
        // marker and is synced separately by setCalloutRange.
        if (isObject(top2[i]) &&
            top2[i].type === "callout" &&
            disclaimerRangeRe.test(blockText(top2[i]))) {
            continue;
        }
        visitInlineArrays(top2[i]);
    }
    // Replace the old orderedList with a real footnotesList of the collected
    // definitions (reading order). If there are no definitions, drop the list.
    if (definitions.length > 0) {
        top2[oldListIndex] = {
            type: "footnotesList",
            content: definitions,
        };
    }
    else {
        top2.splice(oldListIndex, 1);
    }
    // Sync the disclaimer callout range to the new note count.
    const synced = setCalloutRange(working, definitions.length);
    return { doc: synced.doc, consumed };
}
/**
 * AUTHOR-INLINE footnote insertion. The caller supplies WHERE (anchorText) and
 * WHAT (markdown text); numbering and the bottom list are derived server-side by
 * `canonicalizeFootnotes`. The caller never sees or edits `footnotesList`, never
 * assigns a number, and cannot desync — orphans / out-of-order lists / raw
 * `[^id]` markdown are structurally impossible.
 *
 * Content DEDUP (#3 in the issue): if an existing definition has the SAME
 * normalized content key, its id is REUSED (the new reference points at it: one
 * number, one definition, several references). Otherwise a fresh uuid id is
 * minted and a new definition added. Conservative — only an exact content match
 * merges.
 *
 * Mechanics: the `footnoteReference` node is inserted DIRECTLY at the anchor via
 * the same mark-safe split as `insertMarkerAfter` (the shared
 * `insertNodesAfterAnchor` core), so it hugs the preceding word with no text
 * sentinel round-trip. The whole document is then canonicalized.
 *
 * Operates on a clone of `doc`. When the anchor is not found, returns the input
 * unchanged with `inserted:false`.
 */
export function insertInlineFootnote(doc, opts) {
    const inline = mdToInlineNodes(opts.text ?? "");
    // footnoteContentKey only reads `.content`, so key off the inline array
    // directly instead of building a throwaway definition node.
    const key = footnoteContentKey({ content: inline });
    // Content dedup: reuse an existing definition's id when its key matches.
    let footnoteId = null;
    let reused = false;
    if (key !== "") {
        walk(doc, (n) => {
            if (footnoteId == null &&
                isObject(n) &&
                n.type === "footnoteDefinition" &&
                n.attrs &&
                typeof n.attrs.id === "string" &&
                n.attrs.id !== "" &&
                footnoteContentKey(n) === key) {
                footnoteId = n.attrs.id;
                reused = true;
            }
        });
    }
    if (footnoteId == null)
        footnoteId = generateFootnoteId();
    // Insert the footnoteReference node directly after the anchor (mark-safe
    // split); it hugs the preceding word with no leading space. Two guards keep the
    // inline atom out of the notes section and out of blocks that cannot hold it:
    //  - beforeBlock bounds the search to the BODY, before the first top-level block
    //    that IS or CONTAINS (at any depth) a footnotesList/footnoteDefinition — so
    //    a NESTED list or a bare definition also bounds the search, not just a
    //    top-level list;
    //  - skipSubtreeTypes refuses to descend into any footnotesList/footnoteDefinition
    //    subtree, so a reference is never glued inside an existing definition (which
    //    the canonicalizer would then drop as an orphan, losing that definition's
    //    prose); and forbidBlockTypes refuses codeBlocks (an inline atom there is a
    //    schema-invalid doc; insert_footnote skips validateDocStructure).
    // When the only anchor match is in such a place, the insert is refused and the
    // write aborts cleanly (inserted:false) instead of destroying content.
    const boundaryIdx = Array.isArray(doc?.content)
        ? doc.content.findIndex((n) => containsFootnoteNotes(n))
        : -1;
    const r = insertNodesAfterAnchor(doc, (opts.anchorText ?? "").trimEnd(), () => [{ type: "footnoteReference", attrs: { id: footnoteId } }], {
        ...(boundaryIdx >= 0 ? { beforeBlock: boundaryIdx } : {}),
        forbidBlockTypes: INLINE_ATOM_FORBIDDEN_BLOCKS,
        skipSubtreeTypes: FOOTNOTE_NOTES_SUBTREES,
    });
    if (!r.inserted) {
        return { doc: clone(doc), inserted: false, footnoteId, reused };
    }
    let working = r.doc;
    // Add a NEW definition (canonicalize will order/place it); a reused id needs
    // no new definition (the existing one is shared).
    if (!reused) {
        appendDefinition(working, makeFootnoteDefinition(footnoteId, inline));
    }
    // Derive numbering + the single bottom list deterministically.
    working = canonicalizeFootnotes(working);
    return { doc: working, inserted: true, footnoteId, reused };
}
/**
 * Append a definition node so the canonicalizer can order/place it: into the
 * first existing footnotesList, or a new trailing list when none exists.
 */
function appendDefinition(doc, defNode) {
    const existingList = getList(doc, (n) => isObject(n) && n.type === "footnotesList");
    if (existingList && Array.isArray(existingList.content)) {
        existingList.content.push(defNode);
        return;
    }
    if (Array.isArray(doc.content)) {
        doc.content.push({ type: "footnotesList", content: [defNode] });
    }
}
