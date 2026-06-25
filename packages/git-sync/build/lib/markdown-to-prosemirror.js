/**
 * Pure markdown -> ProseMirror conversion.
 *
 * The converter path is `markdownToProseMirror` (marked -> HTML ->
 * generateJSON) plus the two pre/post processors it needs (`preprocessCallouts`,
 * `bridgeTaskLists`). The gitmost server writes the resulting page bodies
 * natively through the collab gateway, so no websocket/Yjs write-path lives
 * here.
 */
import { generateJSON } from "@tiptap/html";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { docmostExtensions } from "./docmost-schema.js";
// Setup DOM environment for Tiptap HTML parsing in Node.js
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
global.window = dom.window;
global.document = dom.window.document;
// @ts-ignore
global.Element = dom.window.Element;
/**
 * Hard ceiling above which we skip callout preprocessing entirely. The linear
 * scanner below has no quadratic blow-up, but we still cap input defensively so
 * a pathological multi-megabyte payload cannot tie up the event loop; in that
 * case the markdown is passed through verbatim (callouts are simply not
 * detected) rather than risking a slow scan.
 */
const MAX_CALLOUT_PREPROCESS_BYTES = 4 * 1024 * 1024; // 4 MB
/** Matches an opening callout fence: `:::type` (type captured, lower-cased). */
const CALLOUT_OPEN_RE = /^:::\s*(\w+)\s*$/;
/** Matches a bare closing callout fence: `:::`. */
const CALLOUT_CLOSE_RE = /^:::\s*$/;
/** Matches the start/end of a code fence (``` or ~~~), capturing the marker. */
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
/**
 * Pre-process Docmost-flavoured markdown: convert `:::type ... :::`
 * callout blocks (the syntax our markdown export produces) into HTML
 * divs that the callout extension parses. The inner content is rendered
 * through marked as regular markdown.
 *
 * Implemented as a single linear pass over the lines (no quadratic regex
 * rescan). It:
 *   - tracks fenced code regions (```...``` and ~~~...~~~) and never treats a
 *     `:::` line that lives inside a code fence as a callout delimiter, so a
 *     callout body that itself contains a fenced code block with a `:::` line is
 *     no longer corrupted;
 *   - matches an opening `:::type` line with the next CLOSING `:::` at the SAME
 *     nesting level, supporting NESTED callouts via a depth counter (an inner
 *     `:::type` opens a deeper level and consumes a matching `:::`);
 *   - emits the same `<div data-type="callout" data-callout-type="TYPE">` output
 *     (inner rendered through marked) as the previous regex implementation.
 */
async function preprocessCallouts(markdown) {
    // Defensive cap: skip preprocessing for pathologically large inputs.
    if (markdown.length > MAX_CALLOUT_PREPROCESS_BYTES) {
        return markdown;
    }
    // Recursively transform a slice of lines, converting top-level callouts in
    // that slice into <div> blocks and rendering their inner content (which may
    // itself contain nested callouts) through this same function.
    const transform = async (lines) => {
        const out = [];
        let inCodeFence = false;
        let codeFenceMarker = ""; // the exact run of backticks/tildes that opened it
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            // Inside a code fence, only its matching closing fence is significant;
            // everything else (including `:::` lines) is copied through verbatim.
            if (inCodeFence) {
                out.push(line);
                const fence = line.match(CODE_FENCE_RE);
                if (fence && fence[2].startsWith(codeFenceMarker[0]) &&
                    fence[2].length >= codeFenceMarker.length) {
                    inCodeFence = false;
                    codeFenceMarker = "";
                }
                i++;
                continue;
            }
            // A code fence opening outside any callout body: enter code-fence mode.
            const fenceOpen = line.match(CODE_FENCE_RE);
            if (fenceOpen) {
                inCodeFence = true;
                codeFenceMarker = fenceOpen[2];
                out.push(line);
                i++;
                continue;
            }
            // An opening callout fence: scan forward (with code-fence and nested
            // callout awareness) for its matching closing `:::` at the same level.
            const open = line.match(CALLOUT_OPEN_RE);
            if (open) {
                const type = open[1].toLowerCase();
                const bodyLines = [];
                let depth = 1;
                let innerInCodeFence = false;
                let innerCodeFenceMarker = "";
                let j = i + 1;
                for (; j < lines.length; j++) {
                    const bl = lines[j];
                    if (innerInCodeFence) {
                        const f = bl.match(CODE_FENCE_RE);
                        if (f && f[2].startsWith(innerCodeFenceMarker[0]) &&
                            f[2].length >= innerCodeFenceMarker.length) {
                            innerInCodeFence = false;
                            innerCodeFenceMarker = "";
                        }
                        bodyLines.push(bl);
                        continue;
                    }
                    const innerFence = bl.match(CODE_FENCE_RE);
                    if (innerFence) {
                        innerInCodeFence = true;
                        innerCodeFenceMarker = innerFence[2];
                        bodyLines.push(bl);
                        continue;
                    }
                    if (CALLOUT_OPEN_RE.test(bl)) {
                        depth++;
                        bodyLines.push(bl);
                        continue;
                    }
                    if (CALLOUT_CLOSE_RE.test(bl)) {
                        depth--;
                        if (depth === 0)
                            break; // matching close for THIS callout
                        bodyLines.push(bl);
                        continue;
                    }
                    bodyLines.push(bl);
                }
                if (j < lines.length) {
                    // Found the matching closing fence: render the body (recursively, so
                    // nested callouts are handled) and emit the callout div.
                    const inner = await transform(bodyLines);
                    const renderedInner = await marked.parse(inner);
                    out.push(`\n<div data-type="callout" data-callout-type="${type}">${renderedInner}</div>\n`);
                    i = j + 1; // skip past the closing `:::`
                    continue;
                }
                // No matching close (unterminated callout): treat the opener as a
                // literal line and continue, preserving the original text.
                out.push(line);
                i++;
                continue;
            }
            out.push(line);
            i++;
        }
        return out.join("\n");
    };
    return transform(markdown.split("\n"));
}
/**
 * Bridge marked's checkbox lists to TipTap task lists.
 *
 * marked renders GitHub task list items (`- [x] done`) as a plain
 * `<ul><li><p><input type="checkbox" checked> text</p></li></ul>` WITHOUT the
 * markup TipTap's TaskList/TaskItem extensions parse. This rewrites such lists
 * into the shape those extensions expect:
 *   TaskList parseHTML matches `ul[data-type="taskList"]`,
 *   TaskItem matches `li[data-type="taskItem"]`,
 *   the checked state is read from `data-checked === "true"`.
 *
 * A list is only converted when it has at least one `<li>` and EVERY direct
 * `<li>` contains a checkbox input. Both `<ul>` and `<ol>` are considered: a
 * numbered checklist (`1. [x] a`, which marked renders as an `<ol>` of checkbox
 * `<li>`s) would otherwise lose its task state. TipTap task lists are unordered,
 * so a matching `<ol>` is emitted as `data-type="taskList"` exactly like a
 * `<ul>`. Mixed or ordinary lists (including ordinary `<ol>` lists) are left
 * untouched so they keep rendering as bullet/numbered lists. The marked `<p>`
 * wrapper is kept inside the `<li>` because TaskItem content allows paragraphs.
 */
function bridgeTaskLists(html) {
    // Cheap early-out: if the markup contains no checkbox input at all there is
    // nothing to bridge, so skip the expensive JSDOM parse entirely. This is the
    // common case (most pages have no task lists).
    if (!/type=["']?checkbox/i.test(html)) {
        return html;
    }
    // Defensive cap (consistent with preprocessCallouts): skip the bridge for
    // pathologically large inputs rather than running a second expensive JSDOM
    // parse on a multi-megabyte payload. The markup is passed through verbatim.
    if (html.length > MAX_CALLOUT_PREPROCESS_BYTES) {
        return html;
    }
    const dom = new JSDOM(html);
    const document = dom.window.document;
    // Collect the checkbox(es) that belong to THIS <li> directly: either direct
    // child <input type="checkbox"> elements or ones inside the <li>'s direct <p>
    // child (the shape marked emits: `<li><p><input type="checkbox"> text</p></li>`).
    // Checkboxes nested deeper (e.g. inside a child <ul>/<ol>) are excluded so a
    // bullet <li> that merely contains a nested task sublist is not misdetected.
    // Raw inline HTML can put more than one checkbox in a single <li>; we gather
    // ALL of them so none survive into the converted item.
    const directCheckboxes = (li) => {
        const found = [];
        for (const child of Array.from(li.children)) {
            if (child.tagName === "INPUT" &&
                child.getAttribute("type") === "checkbox") {
                found.push(child);
                continue;
            }
            if (child.tagName === "P") {
                for (const inp of Array.from(child.querySelectorAll(":scope > input[type='checkbox']"))) {
                    found.push(inp);
                }
            }
        }
        return found;
    };
    // Both <ul> and <ol> are candidates: an <ol> whose every direct <li> carries
    // its own checkbox is a numbered checklist that must also become a taskList.
    const lists = Array.from(document.querySelectorAll("ul, ol"));
    for (const list of lists) {
        // Only consider DIRECT child <li> elements; nested lists are handled by
        // their own iteration of the outer loop.
        const items = Array.from(list.children).filter((child) => child.tagName === "LI");
        if (items.length === 0)
            continue;
        const itemCheckboxes = items.map((li) => directCheckboxes(li));
        // Convert only when every direct <li> carries at least one OWN checkbox.
        if (!itemCheckboxes.every((boxes) => boxes.length > 0))
            continue;
        // A numbered checklist arrives as an <ol>. We must NOT leave the tag as
        // <ol> while tagging it data-type="taskList": generateJSON would then match
        // BOTH the orderedList rule (tag ol) and the taskList rule (data-type),
        // emitting a phantom empty orderedList beside the real taskList. So rename a
        // qualifying <ol> to a <ul> — move its <li> children over and replace it —
        // leaving only the taskList rule to match. Already-<ul> lists are unchanged.
        let target = list;
        if (list.tagName === "OL") {
            const ul = document.createElement("ul");
            // Carry over existing attributes (e.g. class) so nothing is silently lost.
            for (const attr of Array.from(list.attributes)) {
                ul.setAttribute(attr.name, attr.value);
            }
            // Move every child node (including the <li>s we collected) into the <ul>.
            while (list.firstChild) {
                ul.appendChild(list.firstChild);
            }
            list.replaceWith(ul);
            target = ul;
        }
        target.setAttribute("data-type", "taskList");
        items.forEach((li, index) => {
            const boxes = itemCheckboxes[index];
            // The first checkbox determines the checked state (matches the previous
            // single-checkbox behaviour); any extras only need removing.
            const input = boxes[0] ?? null;
            li.setAttribute("data-type", "taskItem");
            const checked = input != null &&
                (input.hasAttribute("checked") || input.checked);
            li.setAttribute("data-checked", checked ? "true" : "false");
            // Remove ALL direct checkbox inputs so none survive into the content
            // (a raw-inline-HTML <li> may carry more than one).
            for (const box of boxes) {
                box.remove();
            }
        });
    }
    return document.body.innerHTML;
}
/**
 * Recursively strip content-less paragraph nodes from a generated doc.
 *
 * A block-level atom whose markdown form is INLINE (e.g. the block `image`'s
 * `![](url)`, or a bare media element) is wrapped by marked in a <p>; the schema
 * then HOISTS the block atom out of that paragraph, leaving an EMPTY paragraph
 * sibling. On the next export that empty `<p>` renders to "" and the doc "\n\n"
 * join injects a phantom blank gap, so the markdown is not byte-stable.
 *
 * Markdown blank lines are separators, never content, so generateJSON only ever
 * produces an empty paragraph as such a hoist artifact — removing them is safe
 * and general (it also subsumes the <div>-wrapper workaround the `video` case
 * uses). We remove ONLY `type === 'paragraph'` nodes whose `content` is absent
 * or an empty array; every other node (including atoms without `content`) is
 * preserved, and we recurse into the content of any node that has children.
 */
function stripEmptyParagraphs(node) {
    if (!node || !Array.isArray(node.content)) {
        // Atom / leaf node (no children to recurse into): keep as-is.
        return node;
    }
    const mapped = node.content.map((child) => stripEmptyParagraphs(child));
    const isEmptyParagraph = (child) => !!child &&
        child.type === "paragraph" &&
        (!Array.isArray(child.content) || child.content.length === 0);
    const filtered = mapped.filter((child) => !isEmptyParagraph(child));
    // Schema-validity guard: several nodes require NON-empty block content
    // (`content: "block+"` — tableCell, tableHeader, blockquote, column, callout,
    // and the doc root). For an empty one of those, generateJSON materializes a
    // single empty paragraph as its OBLIGATORY content — that is not a hoist
    // artifact. If stripping would empty the container, keep ONE empty paragraph
    // so the result stays schema-valid (an empty cell/quote must not become `[]`).
    const cleaned = filtered.length === 0 && mapped.length > 0 ? [mapped[0]] : filtered;
    return { ...node, content: cleaned };
}
/** Convert markdown to a ProseMirror doc using the full Docmost schema. */
export async function markdownToProseMirror(markdownContent) {
    const withCallouts = await preprocessCallouts(markdownContent);
    const html = await marked.parse(withCallouts);
    const bridged = bridgeTaskLists(html);
    const doc = generateJSON(bridged, docmostExtensions);
    return stripEmptyParagraphs(doc);
}
