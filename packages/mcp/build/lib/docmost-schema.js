/**
 * Full TipTap extension set matching the real Docmost document schema.
 *
 * The default StarterKit-only schema silently destroys Docmost-specific
 * nodes (callout, table) and drops attributes it does not know about
 * (node ids, image sizing, link targets). Every code path that converts
 * to or from ProseMirror JSON must use THIS set, otherwise a round-trip
 * loses content.
 */
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { Node, Extension, Mark } from "@tiptap/core";
// Inlined from @tiptap/core's getStyleProperty (added after 3.20.x) so this
// package can stay on the same @tiptap/core version as the editor and avoid a
// duplicate-tiptap version split in the monorepo. Reads a single declaration
// from an element's inline `style` attribute, last-wins, case-insensitive.
function getStyleProperty(element, propertyName) {
    const styleAttr = element.getAttribute("style");
    if (!styleAttr) {
        return null;
    }
    const decls = styleAttr.split(";").map((decl) => decl.trim()).filter(Boolean);
    const target = propertyName.toLowerCase();
    for (let i = decls.length - 1; i >= 0; i -= 1) {
        const decl = decls[i];
        const colonIndex = decl.indexOf(":");
        if (colonIndex === -1) {
            continue;
        }
        const prop = decl.slice(0, colonIndex).trim().toLowerCase();
        if (prop === target) {
            return decl.slice(colonIndex + 1).trim();
        }
    }
    return null;
}
/** Allowed Docmost callout types; anything else falls back to "info". */
const CALLOUT_TYPES = ["info", "warning", "danger", "success"];
export const clampCalloutType = (value) => value && CALLOUT_TYPES.includes(value.toLowerCase())
    ? value.toLowerCase()
    : "info";
/**
 * Allowlist guard for CSS color values imported from HTML.
 *
 * Docmost interpolates stored mark colors straight into an inline style
 * attribute (e.g. style="background-color: ${color}" / "color: ${color}").
 * An unsanitized value such as `red; --x: url(...)` or `red"><script>` would
 * let a crafted document break out of the style attribute. We therefore only
 * accept a narrow, well-formed subset of CSS <color> syntax and reject (-> null)
 * anything else.
 *
 * Accepted forms:
 *   - named colors:           letters only, e.g. "red", "rebeccapurple"
 *   - hex:                    #rgb, #rgba, #rrggbb, #rrggbbaa
 *   - functional notation:    rgb()/rgba()/hsl()/hsla() containing only
 *                             digits, %, ., commas, spaces and slashes
 */
const SAFE_COLOR_RE = /^(?:[a-zA-Z]+|#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\))$/;
export const sanitizeCssColor = (value) => {
    if (typeof value !== "string")
        return null;
    const color = value.trim();
    return color && SAFE_COLOR_RE.test(color) ? color : null;
};
/** Docmost callout (info/warning/danger/success banner). */
const Callout = Node.create({
    name: "callout",
    group: "block",
    content: "block+",
    defining: true,
    addAttributes() {
        return {
            // Read the type from data-callout-type so generateJSON(html) preserves
            // it; without an explicit parseHTML every imported callout became "info".
            type: {
                default: "info",
                parseHTML: (el) => clampCalloutType(el.getAttribute("data-callout-type")),
                renderHTML: (attrs) => ({
                    "data-callout-type": clampCalloutType(attrs.type),
                }),
            },
            icon: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-icon"),
                renderHTML: (attrs) => attrs.icon ? { "data-icon": attrs.icon } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="callout"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "callout", ...HTMLAttributes }, 0];
    },
});
/** Minimal table family: enough for schema round-trips and HTML parsing. */
const Table = Node.create({
    name: "table",
    group: "block",
    content: "tableRow+",
    isolating: true,
    parseHTML() {
        return [{ tag: "table" }];
    },
    renderHTML() {
        return ["table", ["tbody", 0]];
    },
});
const TableRow = Node.create({
    name: "tableRow",
    content: "(tableCell | tableHeader)*",
    parseHTML() {
        return [{ tag: "tr" }];
    },
    renderHTML() {
        return ["tr", 0];
    },
});
const cellAttributes = () => ({
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
    backgroundColor: { default: null },
    backgroundColorName: { default: null },
    // Column alignment so GFM aligned tables (|:--|:-:|--:|) round-trip.
    align: {
        default: null,
        parseHTML: (el) => el.getAttribute("align") || el.style.textAlign || null,
        renderHTML: (attrs) => attrs.align ? { align: attrs.align } : {},
    },
});
const TableCell = Node.create({
    name: "tableCell",
    content: "block+",
    isolating: true,
    addAttributes: cellAttributes,
    parseHTML() {
        return [{ tag: "td" }];
    },
    renderHTML() {
        return ["td", 0];
    },
});
const TableHeader = Node.create({
    name: "tableHeader",
    content: "block+",
    isolating: true,
    addAttributes: cellAttributes,
    parseHTML() {
        return [{ tag: "th" }];
    },
    renderHTML() {
        return ["th", 0];
    },
});
/**
 * Attributes Docmost stores on standard nodes that the stock extensions
 * do not declare. Without these, Node.fromJSON silently drops them —
 * including the block ids that heading anchors rely on.
 */
const DocmostAttributes = Extension.create({
    name: "docmostAttributes",
    addGlobalAttributes() {
        return [
            {
                types: ["heading", "paragraph"],
                attributes: {
                    id: { default: null },
                    indent: { default: null },
                    textAlign: { default: null },
                },
            },
            {
                types: ["image"],
                attributes: {
                    align: { default: null },
                    attachmentId: { default: null },
                    aspectRatio: { default: null },
                    height: { default: null },
                    placeholder: { default: null },
                    size: { default: null },
                    width: { default: null },
                },
            },
            {
                types: ["orderedList"],
                attributes: { type: { default: null } },
            },
            {
                types: ["link"],
                attributes: { internal: { default: null }, title: { default: null } },
            },
        ];
    },
});
/**
 * Docmost inline comment mark. Anchors a comment thread to a text range via
 * `commentId`. Without it, any document containing comment highlights fails to
 * round-trip through the schema ("There is no mark type comment in this schema"),
 * which breaks update_page_json and edit_page_text on every commented page.
 * Mirrors Docmost's @docmost/editor-ext comment mark (commentId / resolved).
 */
const Comment = Mark.create({
    name: "comment",
    exitable: true,
    inclusive: false,
    addAttributes() {
        return {
            commentId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-comment-id"),
                renderHTML: (attrs) => attrs.commentId ? { "data-comment-id": attrs.commentId } : {},
            },
            resolved: {
                default: false,
                parseHTML: (el) => el.getAttribute("data-resolved") === "true",
                renderHTML: (attrs) => attrs.resolved ? { "data-resolved": "true" } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: "span[data-comment-id]" }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["span", { class: "comment-mark", ...HTMLAttributes }, 0];
    },
});
/**
 * Text color mark. The markdown-converter emits colored text as
 * <span style="color: ...">, but with no mark parsing it back the color was
 * silently dropped on import. This mirrors TipTap's @tiptap/extension-text-style
 * `textStyle` mark (the name Docmost expects) and carries a single `color`
 * attribute. The parsed color is passed through the allowlist guard so a crafted
 * style cannot break out of the attribute when Docmost re-renders it.
 */
const TextStyle = Mark.create({
    name: "textStyle",
    addAttributes() {
        return {
            color: {
                default: null,
                parseHTML: (el) => sanitizeCssColor(el.style.color || el.getAttribute("data-color")),
                renderHTML: (attrs) => {
                    const color = sanitizeCssColor(attrs.color);
                    return color ? { style: `color: ${color}` } : {};
                },
            },
        };
    },
    parseHTML() {
        return [
            {
                tag: "span",
                // Only claim a plain colored span. Do NOT match spans that are already a
                // comment mark (data-comment-id) or a mention node (data-type=mention),
                // otherwise importing such HTML would silently drop the comment/mention.
                getAttrs: (el) => el.style.color &&
                    !el.getAttribute("data-comment-id") &&
                    el.getAttribute("data-type") !== "mention"
                    ? {}
                    : false,
            },
        ];
    },
    renderHTML({ HTMLAttributes }) {
        return ["span", HTMLAttributes, 0];
    },
});
/**
 * Passthrough definitions for the remaining Docmost-specific nodes.
 *
 * TiptapTransformer.toYdoc (the write path every mutation uses) throws
 * "Unknown node type: X" for any node not registered here, so editing ANY
 * page that contains one of these nodes used to fail outright. The read path
 * (fromYdoc) accepts them, which is why they appear in real documents.
 *
 * Each node below mirrors the real @docmost/editor-ext definition's name,
 * group, content, inline/atom flags and attribute keys (with the same data-*
 * HTML mapping) so that a fromYdoc -> transform -> toYdoc round-trip both
 * validates and preserves attributes faithfully. Interactive concerns
 * (node views, commands, keyboard shortcuts, input rules, suggestion plugins)
 * are intentionally omitted: the MCP server never renders these nodes, it only
 * needs the schema to accept and carry them. The Callout node above is the
 * pattern these follow.
 */
/** Docmost @mention (user/page reference). Inline atom. */
const Mention = Node.create({
    name: "mention",
    group: "inline",
    inline: true,
    selectable: true,
    atom: true,
    draggable: true,
    addAttributes() {
        return {
            id: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-id"),
                renderHTML: (attrs) => attrs.id ? { "data-id": attrs.id } : {},
            },
            label: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-label"),
                renderHTML: (attrs) => attrs.label ? { "data-label": attrs.label } : {},
            },
            entityType: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-entity-type"),
                renderHTML: (attrs) => attrs.entityType ? { "data-entity-type": attrs.entityType } : {},
            },
            entityId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-entity-id"),
                renderHTML: (attrs) => attrs.entityId ? { "data-entity-id": attrs.entityId } : {},
            },
            slugId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-slug-id"),
                renderHTML: (attrs) => attrs.slugId ? { "data-slug-id": attrs.slugId } : {},
            },
            creatorId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-creator-id"),
                renderHTML: (attrs) => attrs.creatorId ? { "data-creator-id": attrs.creatorId } : {},
            },
            anchorId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-anchor-id"),
                renderHTML: (attrs) => attrs.anchorId ? { "data-anchor-id": attrs.anchorId } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: 'span[data-type="mention"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["span", { "data-type": "mention", ...HTMLAttributes }, 0];
    },
});
/**
 * Footnote feature (mirror of packages/editor-ext/src/lib/footnote). Three
 * nodes connected by `id`:
 *  - FootnoteReference: inline atom marker in the body (<sup data-footnote-ref>);
 *  - FootnotesList:     a single bottom container (<section data-footnotes>);
 *  - FootnoteDefinition: one editable note keyed by id (<div data-footnote-def>).
 * The visible number is not stored; it is derived from reference order.
 *
 * priority 101 so this node's <sup> parse rule beats the Superscript mark's
 * <sup> rule (otherwise an empty reference is parsed as an empty superscript
 * mark and dropped). Keep in sync with editor-ext.
 */
const FootnoteReference = Node.create({
    name: "footnoteReference",
    priority: 101,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
        return {
            id: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-id"),
                renderHTML: (attrs) => attrs.id ? { "data-id": attrs.id } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: "sup[data-footnote-ref]", priority: 100 }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["sup", { "data-footnote-ref": "", ...HTMLAttributes }];
    },
});
const FootnotesList = Node.create({
    name: "footnotesList",
    group: "block",
    content: "footnoteDefinition+",
    isolating: true,
    selectable: false,
    defining: true,
    parseHTML() {
        return [{ tag: "section[data-footnotes]" }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["section", { "data-footnotes": "", ...HTMLAttributes }, 0];
    },
});
const FootnoteDefinition = Node.create({
    name: "footnoteDefinition",
    content: "paragraph+",
    defining: true,
    isolating: true,
    selectable: false,
    addAttributes() {
        return {
            id: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-id"),
                renderHTML: (attrs) => attrs.id ? { "data-id": attrs.id } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: "div[data-footnote-def]" }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-footnote-def": "", ...HTMLAttributes }, 0];
    },
});
/** Inline KaTeX expression. Carries the LaTeX source in `text`. */
const MathInline = Node.create({
    name: "mathInline",
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
        return {
            text: { default: "" },
        };
    },
    parseHTML() {
        return [{ tag: 'span[data-type="mathInline"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return [
            "span",
            { "data-type": "mathInline", "data-katex": "true" },
            `${HTMLAttributes.text ?? ""}`,
        ];
    },
});
/** Block KaTeX expression. Carries the LaTeX source in `text`. */
const MathBlock = Node.create({
    name: "mathBlock",
    group: "block",
    atom: true,
    isolating: true,
    addAttributes() {
        return {
            text: { default: "" },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="mathBlock"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return [
            "div",
            { "data-type": "mathBlock", "data-katex": "true" },
            `${HTMLAttributes.text ?? ""}`,
        ];
    },
});
/** Collapsible <details> wrapper: summary + content children. */
const Details = Node.create({
    name: "details",
    group: "block",
    content: "detailsSummary detailsContent",
    defining: true,
    isolating: true,
    addAttributes() {
        return {
            open: {
                default: false,
                parseHTML: (el) => el.getAttribute("open"),
                renderHTML: (attrs) => attrs.open ? { open: "" } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: "details" }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["details", { ...HTMLAttributes }, 0];
    },
});
/** Clickable summary line of a <details> block. */
const DetailsSummary = Node.create({
    name: "detailsSummary",
    group: "block",
    content: "inline*",
    defining: true,
    isolating: true,
    selectable: false,
    parseHTML() {
        return [{ tag: "summary" }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["summary", { "data-type": "detailsSummary", ...HTMLAttributes }, 0];
    },
});
/** Body of a <details> block. Permissive content so fromYdoc output validates. */
const DetailsContent = Node.create({
    name: "detailsContent",
    group: "block",
    // Docmost declares block* (an empty details body is valid); block+ would
    // reject a collapsed/empty details on round-trip.
    content: "block*",
    defining: true,
    selectable: false,
    parseHTML() {
        return [{ tag: 'div[data-type="detailsContent"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "detailsContent", ...HTMLAttributes }, 0];
    },
});
/** File attachment card (non-image upload). Block atom. */
const Attachment = Node.create({
    name: "attachment",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes() {
        return {
            url: {
                default: "",
                parseHTML: (el) => el.getAttribute("data-attachment-url"),
                renderHTML: (attrs) => ({
                    "data-attachment-url": attrs.url ?? "",
                }),
            },
            name: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-attachment-name"),
                renderHTML: (attrs) => attrs.name ? { "data-attachment-name": attrs.name } : {},
            },
            mime: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-attachment-mime"),
                renderHTML: (attrs) => attrs.mime ? { "data-attachment-mime": attrs.mime } : {},
            },
            size: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-attachment-size"),
                renderHTML: (attrs) => attrs.size != null ? { "data-attachment-size": attrs.size } : {},
            },
            attachmentId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-attachment-id"),
                renderHTML: (attrs) => attrs.attachmentId
                    ? { "data-attachment-id": attrs.attachmentId }
                    : {},
            },
            // Docmost declares `placeholder` (a transient upload key, not rendered
            // to HTML). Carry it so a round-trip never hits "Unsupported attribute".
            placeholder: { default: null },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="attachment"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "attachment", ...HTMLAttributes }, 0];
    },
});
/** Uploaded <video> player. Block atom. */
const Video = Node.create({
    name: "video",
    group: "block",
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes() {
        return {
            src: {
                default: "",
                parseHTML: (el) => el.getAttribute("src"),
                renderHTML: (attrs) => ({ src: attrs.src ?? "" }),
            },
            alt: {
                default: null,
                parseHTML: (el) => el.getAttribute("aria-label"),
                renderHTML: (attrs) => attrs.alt ? { "aria-label": attrs.alt } : {},
            },
            attachmentId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-attachment-id"),
                renderHTML: (attrs) => attrs.attachmentId
                    ? { "data-attachment-id": attrs.attachmentId }
                    : {},
            },
            width: {
                default: null,
                parseHTML: (el) => el.getAttribute("width"),
                renderHTML: (attrs) => attrs.width != null ? { width: attrs.width } : {},
            },
            height: {
                default: null,
                parseHTML: (el) => el.getAttribute("height"),
                renderHTML: (attrs) => attrs.height != null ? { height: attrs.height } : {},
            },
            size: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-size"),
                renderHTML: (attrs) => attrs.size != null ? { "data-size": attrs.size } : {},
            },
            align: {
                default: "center",
                parseHTML: (el) => el.getAttribute("data-align"),
                renderHTML: (attrs) => attrs.align ? { "data-align": attrs.align } : {},
            },
            aspectRatio: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-aspect-ratio"),
                renderHTML: (attrs) => attrs.aspectRatio != null
                    ? { "data-aspect-ratio": attrs.aspectRatio }
                    : {},
            },
            // Docmost declares `placeholder` (a transient upload key, not rendered
            // to HTML). Carry it so a round-trip never hits "Unsupported attribute".
            placeholder: { default: null },
        };
    },
    parseHTML() {
        return [{ tag: "video" }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["video", { controls: "true", ...HTMLAttributes }];
    },
});
/**
 * Defensive passthrough for a `youtube` node. Docmost itself has no dedicated
 * youtube node (YouTube is handled via `embed`), but the converter read path
 * references this type, so accept it as a generic block atom that preserves
 * its src so legacy/external documents survive a round-trip.
 */
const Youtube = Node.create({
    name: "youtube",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes() {
        return {
            src: {
                default: "",
                parseHTML: (el) => el.getAttribute("data-src"),
                renderHTML: (attrs) => ({
                    "data-src": attrs.src ?? "",
                }),
            },
            width: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-width"),
                renderHTML: (attrs) => attrs.width != null ? { "data-width": attrs.width } : {},
            },
            height: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-height"),
                renderHTML: (attrs) => attrs.height != null ? { "data-height": attrs.height } : {},
            },
            align: {
                default: "center",
                parseHTML: (el) => el.getAttribute("data-align"),
                renderHTML: (attrs) => attrs.align ? { "data-align": attrs.align } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="youtube"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "youtube", ...HTMLAttributes }, 0];
    },
});
/** Generic embed (provider iframe). Block atom. */
const Embed = Node.create({
    name: "embed",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes() {
        return {
            src: {
                default: "",
                parseHTML: (el) => el.getAttribute("data-src"),
                renderHTML: (attrs) => ({
                    "data-src": attrs.src ?? "",
                }),
            },
            provider: {
                default: "",
                parseHTML: (el) => el.getAttribute("data-provider"),
                renderHTML: (attrs) => ({
                    "data-provider": attrs.provider ?? "",
                }),
            },
            align: {
                default: "center",
                parseHTML: (el) => el.getAttribute("data-align"),
                renderHTML: (attrs) => ({
                    "data-align": attrs.align ?? "center",
                }),
            },
            width: {
                default: 800,
                parseHTML: (el) => el.getAttribute("data-width"),
                renderHTML: (attrs) => ({
                    "data-width": attrs.width,
                }),
            },
            height: {
                default: 600,
                parseHTML: (el) => el.getAttribute("data-height"),
                renderHTML: (attrs) => ({
                    "data-height": attrs.height,
                }),
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="embed"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "embed", ...HTMLAttributes }, 0];
    },
});
/**
 * Docmost raw HTML embed. Block atom; the client renders `source` inside a
 * sandboxed iframe. The MCP server never renders it — it only needs the
 * schema to accept and carry the node so a fromYdoc -> transform -> toYdoc
 * round-trip does not throw "Unknown node type: htmlEmbed". Mirrors the
 * @docmost/editor-ext node name, attribute keys and flags; keep in sync when
 * the editor-ext htmlEmbed schema changes.
 *
 * NOTE: unlike the canonical editor-ext node, `data-source` here is mapped as
 * plain text rather than base64-encoded. That is intentional: the MCP write
 * path carries the node through Yjs (fromYdoc -> toYdoc) on its JSON `source`
 * attribute and never invokes parseHTML/renderHTML, and htmlEmbed is not
 * produced from the markdown/HTML (generateJSON) path. If a future HTML path
 * for htmlEmbed is added here, this mapping must adopt editor-ext's base64
 * encode/decode to avoid double-encoding `source`.
 */
const HtmlEmbed = Node.create({
    name: "htmlEmbed",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes() {
        return {
            source: {
                default: "",
                parseHTML: (el) => el.getAttribute("data-source") ?? "",
                renderHTML: (attrs) => ({
                    "data-source": attrs.source ?? "",
                }),
            },
            height: {
                default: null,
                parseHTML: (el) => {
                    const v = el.getAttribute("data-height");
                    if (!v)
                        return null;
                    const n = parseInt(v, 10);
                    return Number.isFinite(n) ? n : null;
                },
                renderHTML: (attrs) => attrs.height != null ? { "data-height": String(attrs.height) } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="htmlEmbed"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "htmlEmbed", ...HTMLAttributes }, 0];
    },
});
/** Shared attribute set for drawio/excalidraw diagram nodes. */
const diagramAttributes = () => ({
    src: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-src"),
        renderHTML: (attrs) => ({
            "data-src": attrs.src ?? "",
        }),
    },
    title: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-title"),
        renderHTML: (attrs) => attrs.title ? { "data-title": attrs.title } : {},
    },
    alt: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-alt"),
        renderHTML: (attrs) => attrs.alt ? { "data-alt": attrs.alt } : {},
    },
    width: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-width"),
        renderHTML: (attrs) => attrs.width != null ? { "data-width": attrs.width } : {},
    },
    height: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-height"),
        renderHTML: (attrs) => attrs.height != null ? { "data-height": attrs.height } : {},
    },
    size: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-size"),
        renderHTML: (attrs) => attrs.size != null ? { "data-size": attrs.size } : {},
    },
    aspectRatio: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-aspect-ratio"),
        renderHTML: (attrs) => attrs.aspectRatio != null
            ? { "data-aspect-ratio": attrs.aspectRatio }
            : {},
    },
    align: {
        default: "center",
        parseHTML: (el) => el.getAttribute("data-align"),
        renderHTML: (attrs) => attrs.align ? { "data-align": attrs.align } : {},
    },
    attachmentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs) => attrs.attachmentId ? { "data-attachment-id": attrs.attachmentId } : {},
    },
});
/** draw.io diagram. Block atom (image-backed). */
const Drawio = Node.create({
    name: "drawio",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes: diagramAttributes,
    parseHTML() {
        return [{ tag: 'div[data-type="drawio"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "drawio", ...HTMLAttributes }, 0];
    },
});
/** Excalidraw diagram. Block atom (image-backed). */
const Excalidraw = Node.create({
    name: "excalidraw",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes: diagramAttributes,
    parseHTML() {
        return [{ tag: 'div[data-type="excalidraw"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "excalidraw", ...HTMLAttributes }, 0];
    },
});
/** Multi-column layout container holding one or more `column` children. */
const Columns = Node.create({
    name: "columns",
    group: "block",
    content: "column+",
    defining: true,
    isolating: true,
    addAttributes() {
        return {
            layout: {
                default: "two_equal",
                parseHTML: (el) => el.getAttribute("data-layout"),
                renderHTML: (attrs) => attrs.layout ? { "data-layout": attrs.layout } : {},
            },
            widthMode: {
                default: "normal",
                parseHTML: (el) => el.getAttribute("data-width-mode") || "normal",
                renderHTML: (attrs) => attrs.widthMode && attrs.widthMode !== "normal"
                    ? { "data-width-mode": attrs.widthMode }
                    : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="columns"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "columns", ...HTMLAttributes }, 0];
    },
});
/** Single column within a `columns` layout. */
const Column = Node.create({
    name: "column",
    group: "block",
    content: "block+",
    defining: true,
    isolating: true,
    selectable: false,
    addAttributes() {
        return {
            width: {
                default: null,
                parseHTML: (el) => {
                    const value = el.getAttribute("data-width");
                    return value ? parseFloat(value) : null;
                },
                renderHTML: (attrs) => attrs.width ? { "data-width": attrs.width } : {},
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="column"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "column", ...HTMLAttributes }, 0];
    },
});
/**
 * Subpages listing block (auto-generated index of child pages). Docmost
 * declares no attributes; the markdown-converter has a `case "subpages"`, so
 * the read path can emit it and toYdoc must accept it. Block atom.
 */
const Subpages = Node.create({
    name: "subpages",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    parseHTML() {
        return [{ tag: 'div[data-type="subpages"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "subpages", ...HTMLAttributes }, 0];
    },
});
/** Uploaded <audio> player. Block atom. Mirrors Docmost audio attrs. */
const Audio = Node.create({
    name: "audio",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes() {
        return {
            src: {
                default: "",
                parseHTML: (el) => el.getAttribute("src"),
                renderHTML: (attrs) => ({ src: attrs.src ?? "" }),
            },
            attachmentId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-attachment-id"),
                renderHTML: (attrs) => attrs.attachmentId
                    ? { "data-attachment-id": attrs.attachmentId }
                    : {},
            },
            size: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-size"),
                renderHTML: (attrs) => attrs.size != null ? { "data-size": attrs.size } : {},
            },
            // Transient upload key Docmost declares with rendered:false; carried so
            // a round-trip never hits "Unsupported attribute".
            placeholder: { default: null },
        };
    },
    parseHTML() {
        return [{ tag: "audio" }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["audio", { controls: "true", ...HTMLAttributes }];
    },
});
/** Embedded PDF viewer. Block atom. Mirrors Docmost pdf attrs. */
const Pdf = Node.create({
    name: "pdf",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    addAttributes() {
        return {
            src: {
                default: "",
                parseHTML: (el) => el.getAttribute("src"),
                renderHTML: (attrs) => ({ src: attrs.src ?? "" }),
            },
            name: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-name"),
                renderHTML: (attrs) => attrs.name ? { "data-name": attrs.name } : {},
            },
            attachmentId: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-attachment-id"),
                renderHTML: (attrs) => attrs.attachmentId
                    ? { "data-attachment-id": attrs.attachmentId }
                    : {},
            },
            size: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-size"),
                renderHTML: (attrs) => attrs.size != null ? { "data-size": attrs.size } : {},
            },
            width: {
                default: null,
                parseHTML: (el) => el.getAttribute("width"),
                renderHTML: (attrs) => attrs.width != null ? { width: attrs.width } : {},
            },
            height: {
                default: null,
                parseHTML: (el) => el.getAttribute("height"),
                renderHTML: (attrs) => attrs.height != null ? { height: attrs.height } : {},
            },
            // Transient upload key Docmost declares with rendered:false; carried so
            // a round-trip never hits "Unsupported attribute".
            placeholder: { default: null },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="pdf"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "pdf", ...HTMLAttributes }, 0];
    },
});
/** Page break (print/export divider). Block atom; Docmost declares no attrs. */
const PageBreak = Node.create({
    name: "pageBreak",
    group: "block",
    inline: false,
    isolating: true,
    atom: true,
    defining: true,
    draggable: true,
    parseHTML() {
        return [{ tag: 'div[data-type="pageBreak"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ["div", { "data-type": "pageBreak", ...HTMLAttributes }];
    },
});
/**
 * Full extension list. Image is block-level (matches Docmost); the
 * ProseMirror DOM parser hoists <img> found inside <p> automatically.
 * StarterKit v3 already bundles the link extension, configured here.
 */
export const docmostExtensions = [
    StarterKit.configure({
        codeBlock: {},
        heading: {},
        link: { openOnClick: false },
    }),
    Image.configure({ inline: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Highlight stores its color unescaped and Docmost interpolates it into
    // style="background-color: ${color}". Wrap the color attribute's parseHTML
    // with the same allowlist guard used by textStyle so a crafted import color
    // cannot break out of the style attribute. Multicolor behavior is preserved.
    Highlight.extend({
        addAttributes() {
            const parent = this.parent?.() ?? {};
            return {
                ...parent,
                color: {
                    ...parent.color,
                    parseHTML: (el) => sanitizeCssColor(el.getAttribute("data-color") ||
                        getStyleProperty(el, "background-color") ||
                        el.style.backgroundColor),
                },
            };
        },
    }).configure({ multicolor: true }),
    Subscript,
    Superscript,
    // StarterKit does not provide a textStyle mark, so register ours; without it
    // generateJSON drops <span style="color: ...">, defeating the color import.
    TextStyle,
    Comment,
    Callout,
    Table,
    TableRow,
    TableCell,
    TableHeader,
    Mention,
    FootnoteReference,
    FootnotesList,
    FootnoteDefinition,
    MathInline,
    MathBlock,
    Details,
    DetailsSummary,
    DetailsContent,
    Attachment,
    Video,
    Youtube,
    Embed,
    HtmlEmbed,
    Drawio,
    Excalidraw,
    Columns,
    Column,
    Subpages,
    Audio,
    Pdf,
    PageBreak,
    DocmostAttributes,
];
