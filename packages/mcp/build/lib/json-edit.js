/**
 * Surgical text edits on a ProseMirror document without re-importing it.
 *
 * Each edit replaces an exact substring of a block's inline text, preserving
 * every node id, mark and attribute around it. Matching works at the
 * INLINE-CONTAINER (block) level: a block's text nodes are flattened into a
 * per-character array, so a `find` may freely cross bold/italic/link
 * boundaries (separate text nodes). The replacement inherits marks from the
 * unchanged common prefix/suffix of the match, so editing plain text next to a
 * bold word keeps the bold word bold, and editing the inside of a bold word
 * keeps the inserted text bold. This is the safe alternative to a full markdown
 * re-import for small wording fixes.
 */
/** Placeholder code unit standing in for one opaque (non-text) inline node. */
const ATOM_PLACEHOLDER = "￼"; // OBJECT REPLACEMENT CHARACTER
/**
 * Find every VALID occurrence of `needle` in a block's flattened slots.
 *
 * A candidate occurrence at slot range [start, start+needle.length) is valid
 * ONLY IF none of the slots in that range are atoms (non-text inline nodes).
 * This makes atom matching collision-safe against the U+FFFC placeholder: an
 * atom slot can never be part of a match, while a real text node containing a
 * literal U+FFFC code unit still matches normally (its slot has no `.atom`).
 *
 * Overlapping candidates that touch an atom are skipped (not counted, not
 * spliced); the scan resumes one code unit past the rejected start so a valid
 * match that begins just after an atom is not missed.
 */
function findValidMatches(chars, plain, needle) {
    if (!needle)
        return [];
    const positions = [];
    let idx = plain.indexOf(needle);
    while (idx !== -1) {
        const end = idx + needle.length;
        let hasAtom = false;
        for (let i = idx; i < end; i++) {
            if (chars[i] && chars[i].atom) {
                hasAtom = true;
                break;
            }
        }
        if (!hasAtom) {
            positions.push(idx);
            // Non-overlapping: skip past this match.
            idx = plain.indexOf(needle, end);
        }
        else {
            // This candidate crosses an atom: reject it and resume one unit later so
            // an overlapping valid match starting after the atom is still found.
            idx = plain.indexOf(needle, idx + 1);
        }
    }
    return positions;
}
/** Order-sensitive deep-equality of two marks arrays. */
function marksEqual(a, b) {
    if (a === b)
        return true;
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i]))
            return false;
    }
    return true;
}
/** A block is any node that DIRECTLY contains at least one inline text child. */
function isInlineBlock(node) {
    return (Array.isArray(node?.content) &&
        node.content.some((child) => child && child.type === "text"));
}
/** Flatten a block's inline content into a per-code-unit slot array. */
function flattenBlock(node) {
    const chars = [];
    for (const child of node.content || []) {
        if (child && child.type === "text" && typeof child.text === "string") {
            const marks = child.marks || [];
            // Iterate by UTF-16 code unit so indices align with String.indexOf.
            for (let i = 0; i < child.text.length; i++) {
                chars.push({ ch: child.text[i], marks });
            }
        }
        else {
            // Any non-text inline node becomes one opaque slot.
            chars.push({
                ch: ATOM_PLACEHOLDER,
                marks: (child && child.marks) || [],
                atom: child,
            });
        }
    }
    return chars;
}
/** Re-tokenize a slot array back into ProseMirror inline nodes. */
function tokenizeChars(chars) {
    const out = [];
    let buffer = "";
    let bufferMarks = null;
    const flush = () => {
        if (buffer.length === 0)
            return;
        const textNode = { type: "text", text: buffer };
        if (bufferMarks && bufferMarks.length > 0)
            textNode.marks = bufferMarks;
        out.push(textNode);
        buffer = "";
        bufferMarks = null;
    };
    for (const slot of chars) {
        if (slot.atom) {
            flush();
            out.push(slot.atom);
            continue;
        }
        if (bufferMarks !== null && !marksEqual(bufferMarks, slot.marks)) {
            flush();
        }
        if (bufferMarks === null)
            bufferMarks = slot.marks;
        buffer += slot.ch;
    }
    flush();
    return out;
}
/** Longest common prefix length of two strings. */
function commonPrefixLen(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i])
        i++;
    return i;
}
/** Longest common suffix length of two strings, capped so it can't overlap. */
function commonSuffixLen(a, b, cap) {
    const max = Math.min(a.length, b.length, cap);
    let i = 0;
    while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i])
        i++;
    return i;
}
/**
 * Apply one edit to one block's flattened slot array.
 *
 * The caller passes only VALID (atom-free) match positions (see
 * findValidMatches), so no match range can overlap an atom slot here.
 */
function applyEditToChars(chars, edit, matchPositions) {
    // Pre-compute the diff slices once (find/replace are constant per edit).
    const p = commonPrefixLen(edit.find, edit.replace);
    const s = commonSuffixLen(edit.find, edit.replace, Math.min(edit.find.length, edit.replace.length) - p);
    const insertText = edit.replace.slice(p, edit.replace.length - s);
    // Rebuild the slot array in a single left-to-right pass, splicing at each
    // match start. Offsets into `chars` stay valid because we copy through.
    const newChars = [];
    let cursor = 0;
    let spliced = 0;
    for (const mStart of matchPositions) {
        const mEnd = mStart + edit.find.length;
        const changedStart = mStart + p;
        const changedEnd = mEnd - s;
        // Copy through everything up to the changed region (incl. the prefix).
        for (; cursor < changedStart; cursor++)
            newChars.push(chars[cursor]);
        const removed = chars.slice(changedStart, changedEnd);
        // Choose the marks for the inserted characters.
        let chosenMarks = [];
        if (removed.length > 0 &&
            removed.every((r) => marksEqual(r.marks, removed[0].marks))) {
            // Uniform removed region: inherit its marks directly.
            chosenMarks = removed[0].marks;
        }
        else {
            // Empty or non-uniform removed region: inherit from the nearest TEXT
            // neighbour, skipping atom slots (an atom carries marks that do not
            // belong on inserted text). Scan left first, then right; fall back to [].
            let inherited = null;
            for (let i = changedStart - 1; i >= 0; i--) {
                if (!chars[i].atom) {
                    inherited = chars[i].marks;
                    break;
                }
            }
            if (inherited === null) {
                for (let i = changedEnd; i < chars.length; i++) {
                    if (!chars[i].atom) {
                        inherited = chars[i].marks;
                        break;
                    }
                }
            }
            chosenMarks = inherited === null ? [] : inherited;
        }
        // Emit the inserted text (one slot per code unit).
        for (let i = 0; i < insertText.length; i++) {
            newChars.push({ ch: insertText[i], marks: chosenMarks });
        }
        // Skip the removed region.
        cursor = changedEnd;
        spliced++;
    }
    // Copy through the tail.
    for (; cursor < chars.length; cursor++)
        newChars.push(chars[cursor]);
    return { newChars, spliced };
}
/**
 * Apply text edits to a ProseMirror doc (operates on a deep copy, returns it).
 *
 * Returns { doc, results, failed }:
 *  - results: edits that applied (replacements >= 1).
 *  - failed:  edits that matched zero times, were ambiguous (multi-match
 *    without replaceAll), or whose changed region crosses a non-text inline
 *    node. These do NOT throw — they are recorded so the caller can surface an
 *    actionable message and still keep the edits that did apply.
 *
 * Edits apply IN ORDER to the same working copy, so a later edit can target
 * text produced by an earlier one. The input doc is never mutated. The only
 * thrown error is for invalid input (an empty `edit.find`).
 */
export function applyTextEdits(doc, edits) {
    const copy = JSON.parse(JSON.stringify(doc));
    const results = [];
    const failed = [];
    for (const edit of edits) {
        if (!edit.find)
            throw new Error("edit.find must be a non-empty string");
        // Gather every inline block in document order (recurse the whole tree so
        // nested containers — callouts, list items, table cells, blockquotes — are
        // all covered).
        const blocks = [];
        (function collect(node) {
            if (isInlineBlock(node))
                blocks.push(node);
            for (const child of node.content || [])
                collect(child);
        })(copy);
        // Find every VALID (atom-free) occurrence per block. A candidate whose slot
        // range overlaps a non-text inline atom is never a match (collision-safe vs
        // the U+FFFC placeholder), so it is excluded from both the uniqueness count
        // and the splicing.
        const blockChars = blocks.map((b) => flattenBlock(b));
        const blockPlain = blockChars.map((chars) => chars.map((c) => c.ch).join(""));
        const validPerBlock = blockChars.map((chars, b) => findValidMatches(chars, blockPlain[b], edit.find));
        let total = 0;
        for (const positions of validPerBlock)
            total += positions.length;
        if (total === 0) {
            // Distinguish "the text exists but only across an atom" from a plain
            // not-found: if a raw substring scan (atoms included) WOULD have hit,
            // the only thing blocking the edit is the atom, so report that.
            const existsAcrossAtom = blockPlain.some((plain) => plain.indexOf(edit.find) !== -1);
            failed.push({
                find: edit.find,
                reason: existsAcrossAtom
                    ? "match crosses a non-text inline node (image/break/mention); use update_page_json for structural changes."
                    : "text not found in the document.",
            });
            continue;
        }
        if (total > 1 && !edit.replaceAll) {
            failed.push({
                find: edit.find,
                reason: `matches ${total} times. Provide a longer, unique fragment or set replaceAll: true.`,
            });
            continue;
        }
        // Plan the splices from the valid positions. For a non-replaceAll edit we
        // splice only the first valid match (left-to-right across blocks); for
        // replaceAll we splice every valid match.
        const plannedPerBlock = blockChars.map(() => []);
        let takenFirst = false;
        for (let b = 0; b < validPerBlock.length; b++) {
            for (const idx of validPerBlock[b]) {
                if (edit.replaceAll) {
                    plannedPerBlock[b].push(idx);
                }
                else if (!takenFirst) {
                    plannedPerBlock[b].push(idx);
                    takenFirst = true;
                    break;
                }
                else {
                    break;
                }
            }
            if (!edit.replaceAll && takenFirst)
                break;
        }
        // Apply the splices block-by-block and re-tokenize changed blocks.
        let spliced = 0;
        for (let b = 0; b < blocks.length; b++) {
            if (plannedPerBlock[b].length === 0)
                continue;
            const { newChars, spliced: n } = applyEditToChars(blockChars[b], edit, plannedPerBlock[b]);
            spliced += n;
            blocks[b].content = tokenizeChars(newChars);
        }
        results.push({ find: edit.find, replacements: spliced });
    }
    // Safety net: drop any empty text nodes (ProseMirror forbids them). The
    // re-tokenizer never emits empty text nodes, but untouched blocks could in
    // principle carry one in from upstream.
    (function prune(node) {
        if (Array.isArray(node.content)) {
            node.content = node.content.filter((child) => !(child.type === "text" && child.text === ""));
            for (const child of node.content)
                prune(child);
        }
    })(copy);
    return { doc: copy, results, failed };
}
