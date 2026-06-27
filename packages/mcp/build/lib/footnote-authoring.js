/**
 * Inline-authoring helpers for footnotes (MCP).
 *
 * These build/identify footnote DEFINITION nodes for the author-inline tool
 * (`insertInlineFootnote` in transforms.ts): a content key to de-duplicate notes
 * by text, a definition-node factory, and a fresh uuidv7-style id generator.
 *
 * Split out of `footnote-canonicalize.ts` so that module stays a pure MIRROR of
 * the editor-ext canonicalizer (compositionally symmetric to the editor-ext
 * copy, which keeps its authoring helpers in `footnote-util.ts`). The pure
 * canonicalizer has no dependency on these.
 */
const FOOTNOTE_DEFINITION_NAME = "footnoteDefinition";
function cloneJson(v) {
    if (typeof structuredClone === "function")
        return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
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
            parts.push(`${n.text}${marks}`);
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
