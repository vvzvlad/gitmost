/**
 * Server-side footnote canonicalizer + inline authoring helper (MCP mirror).
 *
 * `canonicalizeFootnotes(doc)` is a pure ProseMirror-JSON port of the editor's
 * `footnoteSyncPlugin` end-state, identical in behaviour to
 * `@docmost/editor-ext`'s `canonicalizeFootnotes`. It is mirrored here — rather
 * than imported from editor-ext — for the SAME reason `footnote-lex.ts` and the
 * `docmost-schema.ts` nodes are mirrored: the MCP package is deliberately
 * decoupled from the browser/React-heavy editor barrel and operates on plain
 * JSON. The editor-ext copy owns the golden test against the live plugin; this
 * copy must stay behaviourally identical.
 *
 * Why it exists: every NON-editor write path (markdown import, update_page_json,
 * docmost_transform, insert_footnote) builds ProseMirror JSON directly, so the
 * editor's footnote plugins never run and the canonical topology (sequential
 * numbering by first reference, one trailing list, no orphans, no raw `[^id]`)
 * was never enforced. Running this at the end of every write path closes that
 * gap; because it is idempotent, it is a no-op when the footnotes are already
 * canonical (no spurious mutations / git-sync churn).
 */
const FOOTNOTE_REFERENCE_NAME = "footnoteReference";
const FOOTNOTES_LIST_NAME = "footnotesList";
const FOOTNOTE_DEFINITION_NAME = "footnoteDefinition";
function cloneJson(v) {
    if (typeof structuredClone === "function")
        return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
}
/**
 * Deterministic unique id for the k-th (k >= 2) duplicate of an id during
 * collision resolution. Pure function of (originalId, occurrence, taken) — no
 * Math.random/Date.now — mirroring editor-ext's `deriveFootnoteId`. Kept local
 * (the importer's first-wins de-dup means duplicates are rare here, but the
 * canonicalizer must still resolve them deterministically).
 */
export function deriveFootnoteId(originalId, occurrence, taken) {
    let candidate = `${originalId}__${occurrence}`;
    let n = 0;
    while (taken.has(candidate)) {
        n += 1;
        candidate = `${originalId}__${occurrence}${suffix(n)}`;
    }
    return candidate;
}
function suffix(n) {
    let out = "";
    let x = n;
    while (x > 0) {
        const rem = (x - 1) % 25;
        out = String.fromCharCode(98 + rem) + out; // 98 = 'b'
        x = Math.floor((x - 1) / 25);
    }
    return out;
}
function isEmptyParagraph(node) {
    return (!!node &&
        node.type === "paragraph" &&
        (!Array.isArray(node.content) || node.content.length === 0));
}
function collectReferenceIds(node, out, seen) {
    if (!node || typeof node !== "object")
        return;
    if (node.type === FOOTNOTE_REFERENCE_NAME) {
        const id = node?.attrs?.id;
        if (id && !seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    if (Array.isArray(node.content)) {
        for (const child of node.content)
            collectReferenceIds(child, out, seen);
    }
}
function collectDefinitions(node, out) {
    if (!node || typeof node !== "object")
        return;
    if (node.type === FOOTNOTE_DEFINITION_NAME)
        out.push(node);
    if (Array.isArray(node.content)) {
        for (const child of node.content)
            collectDefinitions(child, out);
    }
}
function emptyDefinition(id) {
    return {
        type: FOOTNOTE_DEFINITION_NAME,
        attrs: { id },
        content: [{ type: "paragraph" }],
    };
}
/**
 * Canonicalize footnotes in a ProseMirror-JSON document. See the file header and
 * the editor-ext twin for the full contract. Pure (deep-clones input,
 * deterministic, idempotent).
 */
export function canonicalizeFootnotes(doc) {
    if (doc == null ||
        typeof doc !== "object" ||
        !Array.isArray(doc.content)) {
        return doc;
    }
    const out = cloneJson(doc);
    const referenceIds = [];
    collectReferenceIds(out, referenceIds, new Set());
    const defNodes = [];
    collectDefinitions(out, defNodes);
    const taken = new Set(referenceIds);
    for (const d of defNodes) {
        const id = d?.attrs?.id;
        if (id)
            taken.add(id);
    }
    const occurrenceOf = new Map();
    const seenDefIds = new Set();
    const defByFinalId = new Map();
    for (const d of defNodes) {
        const origId = d?.attrs?.id;
        if (!origId)
            continue;
        if (!seenDefIds.has(origId)) {
            seenDefIds.add(origId);
            defByFinalId.set(origId, d);
        }
        else {
            const next = (occurrenceOf.get(origId) ?? 1) + 1;
            occurrenceOf.set(origId, next);
            const newId = deriveFootnoteId(origId, next, taken);
            taken.add(newId);
            defByFinalId.set(newId, d);
        }
    }
    const orderedDefs = [];
    for (const id of referenceIds) {
        const existing = defByFinalId.get(id);
        if (existing) {
            const node = cloneJson(existing);
            node.attrs = { ...(node.attrs ?? {}), id };
            orderedDefs.push(node);
        }
        else {
            orderedDefs.push(emptyDefinition(id));
        }
    }
    const top = out.content.filter((n) => !(n && n.type === FOOTNOTES_LIST_NAME));
    if (referenceIds.length === 0) {
        out.content = top;
        return out;
    }
    let insertAt = top.length;
    while (insertAt > 0 && isEmptyParagraph(top[insertAt - 1]))
        insertAt--;
    top.splice(insertAt, 0, { type: FOOTNOTES_LIST_NAME, content: orderedDefs });
    out.content = top;
    return out;
}
/**
 * Normalized content key for de-duplicating footnote DEFINITIONS by their text.
 *
 * Two definitions with the same key are the SAME footnote — so the inline
 * authoring tool reuses one id (one number, one definition, several references)
 * instead of minting a second definition. Key = plaintext (whitespace-collapsed,
 * trimmed) PLUS a signature of the inline mark types in order, so two notes that
 * read the same but differ in formatting (one bold, one plain) are NOT merged.
 * Conservative: only an exact match merges.
 */
export function footnoteContentKey(defNode) {
    const parts = [];
    const visit = (n) => {
        if (!n || typeof n !== "object")
            return;
        if (n.type === "text" && typeof n.text === "string") {
            const marks = Array.isArray(n.marks)
                ? n.marks.map((m) => m?.type).filter(Boolean).sort().join(",")
                : "";
            parts.push(`${n.text}${marks}`);
        }
        if (Array.isArray(n.content))
            for (const c of n.content)
                visit(c);
    };
    visit(defNode);
    // Collapse the assembled text's whitespace and trim, keeping the mark
    // signature attached so formatting differences still distinguish notes.
    return parts
        .join("")
        .replace(/[ \t\r\n]+/g, " ")
        .trim();
}
/**
 * Build a footnoteDefinition node from inline ProseMirror nodes, keyed by id.
 */
export function makeFootnoteDefinition(id, inlineNodes) {
    const content = Array.isArray(inlineNodes) ? cloneJson(inlineNodes) : [];
    return {
        type: FOOTNOTE_DEFINITION_NAME,
        attrs: { id },
        content: [{ type: "paragraph", content }],
    };
}
/**
 * Generate a uuidv7-style id (time-ordered), matching editor-ext's
 * `generateFootnoteId`. Used for a genuinely-new inline footnote id.
 */
export function generateFootnoteId() {
    const now = Date.now();
    const timeHex = now.toString(16).padStart(12, "0");
    const rand = (length) => {
        let s = "";
        for (let i = 0; i < length; i++)
            s += Math.floor(Math.random() * 16).toString(16);
        return s;
    };
    const versioned = "7" + rand(3);
    const variantNibble = (8 + Math.floor(Math.random() * 4)).toString(16);
    const variant = variantNibble + rand(3);
    return (timeHex.slice(0, 8) +
        "-" +
        timeHex.slice(8, 12) +
        "-" +
        versioned +
        "-" +
        variant +
        "-" +
        rand(12));
}
