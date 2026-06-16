/**
 * Surgical text edits on a ProseMirror document without re-importing it.
 *
 * Each edit replaces an exact substring inside individual text nodes,
 * preserving every node id, mark and attribute around it. This is the
 * safe alternative to a full markdown re-import for small wording fixes.
 */
/** Collect plain text of the whole document (for span-detection hints). */
function collectText(node) {
    let out = "";
    if (node.type === "text")
        out += node.text || "";
    for (const child of node.content || [])
        out += collectText(child);
    return out;
}
function countOccurrences(haystack, needle) {
    if (!needle)
        return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
}
/**
 * Apply text edits to a ProseMirror doc (mutates a deep copy, returns it).
 * Throws a descriptive error when an edit matches zero times or matches
 * multiple times without replaceAll — so the caller can refine `find`.
 */
export function applyTextEdits(doc, edits) {
    const copy = JSON.parse(JSON.stringify(doc));
    const results = [];
    for (const edit of edits) {
        if (!edit.find)
            throw new Error("edit.find must be a non-empty string");
        // Count matches inside individual text nodes first.
        let nodeMatches = 0;
        (function count(node) {
            if (node.type === "text" && node.text) {
                nodeMatches += countOccurrences(node.text, edit.find);
            }
            for (const child of node.content || [])
                count(child);
        })(copy);
        if (nodeMatches === 0) {
            // Distinguish "text not present" from "text spans formatting runs".
            const fullText = collectText(copy);
            if (fullText.includes(edit.find)) {
                throw new Error(`Edit "${truncate(edit.find)}": the text exists in the document but spans ` +
                    `multiple formatting runs (bold/link/italic boundaries). Use a shorter ` +
                    `fragment that stays inside one run, or use update_page_json for ` +
                    `structural changes.`);
            }
            throw new Error(`Edit "${truncate(edit.find)}": text not found in the document.`);
        }
        if (nodeMatches > 1 && !edit.replaceAll) {
            throw new Error(`Edit "${truncate(edit.find)}": matches ${nodeMatches} times. ` +
                `Provide a longer, unique fragment or set replaceAll: true.`);
        }
        // Perform the replacement(s).
        let done = 0;
        (function replace(node) {
            if (node.type === "text" && node.text && node.text.includes(edit.find)) {
                if (edit.replaceAll) {
                    done += countOccurrences(node.text, edit.find);
                    node.text = node.text.split(edit.find).join(edit.replace);
                }
                else if (done === 0) {
                    // Avoid String.replace: its second arg treats $&, $1, $`, $', $$ as
                    // special patterns, expanding them instead of inserting literally.
                    // Splice the first occurrence by index to keep the replacement literal.
                    const idx = node.text.indexOf(edit.find);
                    node.text =
                        node.text.slice(0, idx) +
                            edit.replace +
                            node.text.slice(idx + edit.find.length);
                    done = 1;
                }
            }
            for (const child of node.content || [])
                replace(child);
        })(copy);
        results.push({ find: edit.find, replacements: done });
    }
    // Drop text nodes that became empty (ProseMirror forbids empty text nodes).
    (function prune(node) {
        if (Array.isArray(node.content)) {
            node.content = node.content.filter((child) => !(child.type === "text" && child.text === ""));
            for (const child of node.content)
                prune(child);
        }
    })(copy);
    return { doc: copy, results };
}
function truncate(s) {
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
}
