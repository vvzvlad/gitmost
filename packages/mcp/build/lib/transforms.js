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
            const inline = container.content;
            // Detect whether this array is an inline array (contains text nodes).
            const hasText = inline.some((n) => isObject(n) && n.type === "text");
            if (hasText) {
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
                        // Marker is a PLAIN run: no marks copied. Leading space separates it.
                        parts.push({ type: "text", text: " " + marker });
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
    const noteByPh = new Map();
    (Array.isArray(comments) ? comments : []).forEach((c, i) => {
        if (!c || !c.selection)
            return;
        // Collision-proof sentinel delimited by NUL control chars, which never occur
        // in real Docmost prose — so the renumber regex below cannot mistake any body
        // text (e.g. "Press F1 for help", model "FN2") for a placeholder. The NUL is
        // transient: the placeholder round-trips within this function (insertMarkerAfter
        // inserts it, the renumber pass replaces it with "[N]"), so it never persists
        // in a returned/pushed document.
        const ph = `\u0000FN${i}\u0000`;
        // insertMarkerAfter returns a NEW cloned doc; reassign `working` and refresh
        // the `top` / `notesList` references that point into it.
        const r = insertMarkerAfter(working, c.selection.trimEnd(), ph, {
            beforeBlock: notesIdx,
        });
        if (!r.inserted)
            return;
        working = r.doc;
        noteByPh.set(ph, noteItem(mdToInlineNodes(c.content)));
        consumed.push(c.id);
    });
    // Re-resolve references into the (possibly re-cloned) working doc.
    const top2 = Array.isArray(working.content) ? working.content : [];
    const notesList2 = top2
        .slice(notesIdx)
        .find((n) => isObject(n) && n.type === "orderedList");
    if (!notesList2) {
        throw new Error("notes orderedList not found");
    }
    const oldNotes = Array.isArray(notesList2.content)
        ? notesList2.content
        : [];
    const newNotes = [];
    let seq = 0;
    // Match either an existing "[N]" marker or a NUL-delimited "\u0000FN<i>\u0000"
    // placeholder, in reading order across the body (blocks before the notes heading).
    const re = /\[(\d+)\]|\u0000FN(\d+)\u0000/g;
    // Same range regex setCalloutRange uses to detect the disclaimer callout's
    // "[1]…[K]" range; used here to decide whether a top-level callout is the
    // disclaimer (skip) or an ordinary callout (renumber normally).
    const disclaimerRangeRe = /(\[1\]\s*(?:…|\.\.\.)\s*\[)\d+(\])/;
    for (let i = 0; i < notesIdx; i++) {
        // Skip ONLY the disclaimer callout: its "[1]…[K]" range is NOT a footnote
        // marker and is synced separately by setCalloutRange. Renumbering it here
        // would consume note slots and corrupt the sequence. Other top-level
        // callouts may carry legitimate "[N]" body markers and are renumbered.
        if (isObject(top2[i]) &&
            top2[i].type === "callout" &&
            disclaimerRangeRe.test(blockText(top2[i]))) {
            continue;
        }
        walk(top2[i], (node) => {
            if (node.type !== "text" || typeof node.text !== "string")
                return;
            node.text = node.text.replace(re, (_m, oldNum, phIdx) => {
                if (oldNum != null) {
                    const note = oldNotes[Number(oldNum) - 1];
                    // Every existing body marker MUST map to a real note. An out-of-range
                    // marker means the document is internally inconsistent; fail loudly
                    // rather than silently dropping the note and desyncing the callout.
                    if (note === undefined) {
                        throw new Error(`footnote [${oldNum}] has no matching note (notes list has ${oldNotes.length} items); document is inconsistent`);
                    }
                    newNotes.push(note);
                }
                else {
                    newNotes.push(noteByPh.get(`\u0000FN${phIdx}\u0000`));
                }
                return `[${++seq}]`;
            });
        });
    }
    // Reorder the notes list IN PLACE on `working` first, THEN sync the callout
    // range. setCalloutRange clones `working`, so the reordered notes (mutated
    // before the clone) are carried into its result automatically. No null-filter
    // here: marker count and note count must stay exactly equal (the out-of-range
    // guard above guarantees no undefined entry is ever pushed).
    notesList2.content = newNotes;
    const synced = setCalloutRange(working, notesList2.content.length);
    return { doc: synced.doc, consumed };
}
