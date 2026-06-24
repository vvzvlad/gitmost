/**
 * Shared, fence-aware line lexer for footnote markdown (MCP-internal).
 *
 * Both the importer (`extractFootnotes` in collaboration.ts, which strips
 * definition lines and rebuilds a footnotes section) and the diagnostics
 * (`analyzeFootnotes` in footnote-analyze.ts) must agree EXACTLY on which lines
 * are definitions and which lines are inert (inside a code fence). Sharing one
 * lexer makes "the analyzer sees what the importer leaves" a structural property
 * instead of two hand-kept copies that can drift (#166 review).
 *
 * NOTE: this is deliberately NOT shared with editor-ext's
 * `extractFootnoteDefinitions` — that lives in a different package and the
 * decoupling between the editor and the MCP mirror is intentional.
 */
/** A footnote DEFINITION line: `[^id]: text` (id + text captured). */
export const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
/** Every footnote REFERENCE `[^id]` in a line (global; id captured). */
export const FOOTNOTE_REF_RE_G = /\[\^([^\]\s]+)\]/g;
/** Opening/closing code fence marker (``` or ~~~). */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
/** Classify every line of `markdown`, tracking fenced-code state. Pure. */
export function lexFootnoteLines(markdown) {
    const out = [];
    let fence = null;
    for (const line of markdown.split("\n")) {
        const fenceMatch = FENCE_RE.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[2][0];
            if (fence === null)
                fence = marker; // opening fence
            else if (marker === fence)
                fence = null; // matching closing fence
            out.push({ line, inFence: true, definition: null });
            continue;
        }
        if (fence !== null) {
            out.push({ line, inFence: true, definition: null });
            continue;
        }
        const m = FOOTNOTE_DEF_RE.exec(line);
        out.push({
            line,
            inFence: false,
            definition: m ? { id: m[1], text: m[2] } : null,
        });
    }
    return out;
}
/** Scan a line for every `[^id]` reference, invoking `onRef(id)` for each. */
export function forEachFootnoteReference(line, onRef) {
    FOOTNOTE_REF_RE_G.lastIndex = 0;
    let m;
    while ((m = FOOTNOTE_REF_RE_G.exec(line)) !== null)
        onRef(m[1]);
}
