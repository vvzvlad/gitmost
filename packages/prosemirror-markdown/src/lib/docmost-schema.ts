/**
 * Full TipTap extension set matching the real Docmost document schema.
 *
 * The default StarterKit-only schema silently destroys Docmost-specific
 * nodes (callout, table) and drops attributes it does not know about
 * (node ids, image sizing, link targets). Every code path that converts
 * to or from ProseMirror JSON must use THIS set, otherwise a round-trip
 * loses content.
 *
 * PROVENANCE / KEEP IN SYNC: this file is a VENDORED MIRROR of the canonical
 * Docmost document schema in `@docmost/editor-ext`. The node/mark/attribute
 * surface MUST be kept in sync with editor-ext — anything present there but
 * missing here is silently dropped on a round-trip (data loss). The exported
 * `docmostExtensions` surface is guarded by `test/schema-surface-snapshot.test.ts`,
 * which fails loudly on any drift; when it does, re-verify parity against
 * `@docmost/editor-ext` before updating the snapshot.
 */
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import { Code } from "@tiptap/extension-code";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { Node, Extension, Mark } from "@tiptap/core";

// Inlined from @tiptap/core's getStyleProperty (added after 3.20.x) so this
// package can stay on the same @tiptap/core version as the editor and avoid a
// duplicate-tiptap version split in the monorepo. Reads a single declaration
// from an element's inline `style` attribute, last-wins, case-insensitive.
function getStyleProperty(element: HTMLElement, propertyName: string): string | null {
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

/**
 * Allowed Docmost callout types; anything else falls back to "info".
 *
 * This MUST stay in lockstep with the editor's canonical set
 * (`getValidCalloutType` in `@docmost/editor-ext` callout/utils.ts:
 * default | info | note | success | warning | danger). A type missing here is
 * silently flattened to "info" on the markdown -> ProseMirror round-trip, so a
 * `[!note]` / `[!default]` callout authored in the editor would come back as
 * `[!info]` after a git sync (the QA "callout type -> [!info]" fidelity loss).
 * `note` and `default` were previously absent and so were being flattened.
 *
 * The editor SCHEMA genuinely only supports these six banner types — there is no
 * `tip`/`caution`/`important`/`question` callout node. So those are NOT first-
 * class types we can round-trip literally; they are INPUT ALIASES (GitHub/Obsidian
 * alert syntax). This package's own `> [!type]` import path maps them onto the
 * supported set (see `CALLOUT_TYPE_ALIASES` below: tip -> success, caution ->
 * danger, important -> info). We apply that aliasing
 * here so an ingested `> [!tip]` / `> [!caution]` lands on the closest real banner
 * (success / danger) instead of flatly collapsing to `info` — matching exactly how
 * the editor itself would interpret the same alias. A schema type always maps to
 * itself first (idempotent round-trip); the alias map only rewrites NON-schema
 * names; anything still unknown falls back to `info`.
 */
const CALLOUT_TYPES = ["default", "info", "note", "success", "warning", "danger"];
/**
 * NON-schema callout aliases -> their closest supported banner, for the names
 * that are NOT already schema types (a schema type is preserved as-is and never
 * consulted here). This is the single canonical alias map now that the editor's
 * old marked layer is gone; git-sync ingest and an editor paste both go through
 * this package, so they interpret the same `> [!alias]` identically.
 */
const CALLOUT_TYPE_ALIASES: Record<string, string> = {
  tip: "success",
  caution: "danger",
  important: "info",
};
export const clampCalloutType = (value: string | null | undefined): string => {
  if (!value) return "info";
  const lower = value.toLowerCase();
  // A real schema type round-trips to itself (idempotent).
  if (CALLOUT_TYPES.includes(lower)) return lower;
  // A known GitHub/Obsidian alias maps to the editor's closest banner.
  if (CALLOUT_TYPE_ALIASES[lower]) return CALLOUT_TYPE_ALIASES[lower];
  // Anything else is collapsed to the safe default (matches the editor).
  return "info";
};

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
const SAFE_COLOR_RE =
  /^(?:[a-zA-Z]+|#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\))$/;
export const sanitizeCssColor = (
  value: string | null | undefined,
): string | null => {
  if (typeof value !== "string") return null;
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
        parseHTML: (el: HTMLElement) =>
          clampCalloutType(el.getAttribute("data-callout-type")),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-callout-type": clampCalloutType(attrs.type),
        }),
      },
      icon: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-icon"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.icon ? { "data-icon": attrs.icon } : {},
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
    parseHTML: (el: HTMLElement) =>
      el.getAttribute("align") || el.style.textAlign || null,
    renderHTML: (attrs: Record<string, any>) =>
      attrs.align ? { align: attrs.align } : {},
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
          // textAlign must round-trip the exported `<p style="text-align:…">`
          // (and the legacy `<... align="…">`) form (review #10). Without an
          // explicit parseHTML the default reads a bare `textAlign` attribute
          // (never present), so alignment was silently dropped on every import.
          textAlign: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              el.style?.textAlign || el.getAttribute("align") || null,
            renderHTML: (attrs: Record<string, any>) =>
              attrs.textAlign
                ? { style: `text-align: ${attrs.textAlign}` }
                : {},
          },
        },
      },
      {
        types: ["image"],
        attributes: {
          // #293 canon #4: the image `align` default is unified to "center"
          // (matching editor-ext, the source of real user documents) so an
          // editor-authored image — which is always align="center" — serializes
          // as the clean `![](src)` form with NO attached comment, and only a
          // genuinely non-default alignment (left/right) emits an `<!--img-->`
          // comment. The DOM attribute name stays `align` (imageToHtml already
          // round-trips it as align="…"); only the DEFAULT value changed from
          // null to "center". parseHTML reads the `align` attribute so a bare
          // <img> with no align falls back to "center", and <img align="left">
          // reads "left".
          align: {
            default: "center",
            parseHTML: (el: HTMLElement) => el.getAttribute("align") || "center",
            renderHTML: (attrs: Record<string, any>) =>
              attrs.align && attrs.align !== "center" ? { align: attrs.align } : {},
          },
          // imageToHtml emits these Docmost-specific image attrs as data-*; map
          // them back explicitly so a top-level image (or one inside a column)
          // round-trips them. Without a parseHTML the default reads the bare
          // attribute name (e.g. getAttribute("attachmentId") -> null) and the
          // value — including the attachmentId that links the image to its
          // stored file — is silently dropped on every round-trip (data loss).
          attachmentId: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              el.getAttribute("data-attachment-id"),
            renderHTML: (attrs: Record<string, any>) =>
              attrs.attachmentId
                ? { "data-attachment-id": attrs.attachmentId }
                : {},
          },
          aspectRatio: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              el.getAttribute("data-aspect-ratio"),
            renderHTML: (attrs: Record<string, any>) =>
              attrs.aspectRatio != null
                ? { "data-aspect-ratio": attrs.aspectRatio }
                : {},
          },
          // Plain-text image caption (issue #221). editor-ext's image node
          // serializes it as `data-caption` on the <img>; mirror that mapping so
          // a captioned image survives the markdown <-> ProseMirror round-trip.
          // Emit data-caption only when set, so caption-less images stay clean.
          caption: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              el.getAttribute("data-caption") || null,
            renderHTML: (attrs: Record<string, any>) =>
              attrs.caption ? { "data-caption": attrs.caption } : {},
          },
          height: { default: null },
          placeholder: { default: null },
          size: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-size"),
            renderHTML: (attrs: Record<string, any>) =>
              attrs.size != null ? { "data-size": attrs.size } : {},
          },
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
 * which breaks updatePageJson and editPageText on every commented page.
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.commentId ? { "data-comment-id": attrs.commentId } : {},
      },
      resolved: {
        default: false,
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-resolved") === "true",
        renderHTML: (attrs: Record<string, any>) =>
          attrs.resolved ? { "data-resolved": "true" } : {},
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
 * Inline spoiler mark (issue #259). Mirrors the @docmost/editor-ext `spoiler`
 * mark so a document carrying a spoiler survives the git-sync round-trip.
 * Markdown has no native spoiler syntax, so the markdown-converter emits it as
 * raw inline HTML (`<span data-spoiler="true">…</span>`); without this mark the
 * span re-parses as plain text and the spoiler is silently dropped on import.
 * It parses span[data-spoiler] and re-renders the same span[data-spoiler][class].
 */
const Spoiler = Mark.create({
  name: "spoiler",
  inclusive: false,
  parseHTML() {
    return [{ tag: "span[data-spoiler]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-spoiler": "true", class: "spoiler", ...HTMLAttributes }, 0];
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
        parseHTML: (el: HTMLElement) =>
          sanitizeCssColor(
            el.style.color || el.getAttribute("data-color"),
          ),
        renderHTML: (attrs: Record<string, any>) => {
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
        getAttrs: (el: HTMLElement) =>
          el.style.color &&
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.id ? { "data-id": attrs.id } : {},
      },
      label: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-label"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.label ? { "data-label": attrs.label } : {},
      },
      entityType: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-entity-type"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.entityType ? { "data-entity-type": attrs.entityType } : {},
      },
      entityId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-entity-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.entityId ? { "data-entity-id": attrs.entityId } : {},
      },
      slugId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-slug-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.slugId ? { "data-slug-id": attrs.slugId } : {},
      },
      creatorId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-creator-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.creatorId ? { "data-creator-id": attrs.creatorId } : {},
      },
      anchorId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-anchor-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.anchorId ? { "data-anchor-id": attrs.anchorId } : {},
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
        parseHTML: (el: HTMLElement) => el.hasAttribute("open"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.open ? { open: "" } : {},
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-url"),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-attachment-url": attrs.url ?? "",
        }),
      },
      name: {
        default: null,
        // Empty-string-vs-absent idempotency (GS-EDIT-REVERT class): "" -> default.
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-attachment-name") || null,
        renderHTML: (attrs: Record<string, any>) =>
          attrs.name ? { "data-attachment-name": attrs.name } : {},
      },
      mime: {
        default: null,
        // Empty-string-vs-absent idempotency (GS-EDIT-REVERT class): "" -> default.
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-attachment-mime") || null,
        renderHTML: (attrs: Record<string, any>) =>
          attrs.mime ? { "data-attachment-mime": attrs.mime } : {},
      },
      size: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-size"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.size != null ? { "data-attachment-size": attrs.size } : {},
      },
      attachmentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.attachmentId
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
        parseHTML: (el: HTMLElement) => el.getAttribute("src"),
        renderHTML: (attrs: Record<string, any>) => ({ src: attrs.src ?? "" }),
      },
      alt: {
        default: null,
        // Empty-string-vs-absent idempotency: coerce "" back to the default so a
        // stray empty `aria-label` never materializes `alt: ""` on a video stored
        // with no alt (same GS-EDIT-REVERT class as the image `alt` fix).
        parseHTML: (el: HTMLElement) => el.getAttribute("aria-label") || null,
        renderHTML: (attrs: Record<string, any>) =>
          attrs.alt ? { "aria-label": attrs.alt } : {},
      },
      attachmentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.attachmentId
            ? { "data-attachment-id": attrs.attachmentId }
            : {},
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("width"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.width != null ? { width: attrs.width } : {},
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("height"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.height != null ? { height: attrs.height } : {},
      },
      size: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-size"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.size != null ? { "data-size": attrs.size } : {},
      },
      align: {
        default: "center",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-align"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.align ? { "data-align": attrs.align } : {},
      },
      aspectRatio: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-aspect-ratio"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.aspectRatio != null
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-src"),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-src": attrs.src ?? "",
        }),
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-width"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.width != null ? { "data-width": attrs.width } : {},
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-height"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.height != null ? { "data-height": attrs.height } : {},
      },
      align: {
        default: "center",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-align"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.align ? { "data-align": attrs.align } : {},
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-src"),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-src": attrs.src ?? "",
        }),
      },
      provider: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-provider"),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-provider": attrs.provider ?? "",
        }),
      },
      align: {
        default: "center",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-align"),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-align": attrs.align ?? "center",
        }),
      },
      width: {
        default: 800,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-width"),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-width": attrs.width,
        }),
      },
      height: {
        default: 600,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-height"),
        renderHTML: (attrs: Record<string, any>) => ({
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

/** Shared attribute set for drawio/excalidraw diagram nodes. */
const diagramAttributes = () => ({
  src: {
    default: "",
    parseHTML: (el: HTMLElement) => el.getAttribute("data-src"),
    renderHTML: (attrs: Record<string, any>) => ({
      "data-src": attrs.src ?? "",
    }),
  },
  title: {
    default: null,
    // Empty-string-vs-absent idempotency (GS-EDIT-REVERT class): "" -> default.
    parseHTML: (el: HTMLElement) => el.getAttribute("data-title") || null,
    renderHTML: (attrs: Record<string, any>) =>
      attrs.title ? { "data-title": attrs.title } : {},
  },
  alt: {
    default: null,
    // Empty-string-vs-absent idempotency (GS-EDIT-REVERT class): "" -> default.
    parseHTML: (el: HTMLElement) => el.getAttribute("data-alt") || null,
    renderHTML: (attrs: Record<string, any>) =>
      attrs.alt ? { "data-alt": attrs.alt } : {},
  },
  width: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-width"),
    renderHTML: (attrs: Record<string, any>) =>
      attrs.width != null ? { "data-width": attrs.width } : {},
  },
  height: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-height"),
    renderHTML: (attrs: Record<string, any>) =>
      attrs.height != null ? { "data-height": attrs.height } : {},
  },
  size: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-size"),
    renderHTML: (attrs: Record<string, any>) =>
      attrs.size != null ? { "data-size": attrs.size } : {},
  },
  aspectRatio: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-aspect-ratio"),
    renderHTML: (attrs: Record<string, any>) =>
      attrs.aspectRatio != null
        ? { "data-aspect-ratio": attrs.aspectRatio }
        : {},
  },
  align: {
    default: "center",
    parseHTML: (el: HTMLElement) => el.getAttribute("data-align"),
    renderHTML: (attrs: Record<string, any>) =>
      attrs.align ? { "data-align": attrs.align } : {},
  },
  attachmentId: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-id"),
    renderHTML: (attrs: Record<string, any>) =>
      attrs.attachmentId ? { "data-attachment-id": attrs.attachmentId } : {},
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-layout"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.layout ? { "data-layout": attrs.layout } : {},
      },
      widthMode: {
        default: "normal",
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-width-mode") || "normal",
        renderHTML: (attrs: Record<string, any>) =>
          attrs.widthMode && attrs.widthMode !== "normal"
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
        parseHTML: (el: HTMLElement) => {
          // Mirrors editor-ext (column.ts): width is a unitless flex-grow
          // number, so parse it to a Number for parity with the canonical schema.
          const value = el.getAttribute("data-width");
          return value ? parseFloat(value) : null;
        },
        renderHTML: (attrs: Record<string, any>) =>
          attrs.width ? { "data-width": attrs.width } : {},
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
  addAttributes() {
    return {
      recursive: {
        default: false,
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-recursive") === "true",
        renderHTML: (attrs: Record<string, any>) =>
          attrs.recursive ? { "data-recursive": "true" } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="subpages"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { "data-type": "subpages", ...HTMLAttributes }];
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
        parseHTML: (el: HTMLElement) => el.getAttribute("src"),
        renderHTML: (attrs: Record<string, any>) => ({ src: attrs.src ?? "" }),
      },
      attachmentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.attachmentId
            ? { "data-attachment-id": attrs.attachmentId }
            : {},
      },
      size: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-size"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.size != null ? { "data-size": attrs.size } : {},
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
        parseHTML: (el: HTMLElement) => el.getAttribute("src"),
        renderHTML: (attrs: Record<string, any>) => ({ src: attrs.src ?? "" }),
      },
      name: {
        default: null,
        // Empty-string-vs-absent idempotency (GS-EDIT-REVERT class): "" -> default.
        parseHTML: (el: HTMLElement) => el.getAttribute("data-name") || null,
        renderHTML: (attrs: Record<string, any>) =>
          attrs.name ? { "data-name": attrs.name } : {},
      },
      attachmentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.attachmentId
            ? { "data-attachment-id": attrs.attachmentId }
            : {},
      },
      size: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-size"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.size != null ? { "data-size": attrs.size } : {},
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("width"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.width != null ? { width: attrs.width } : {},
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("height"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.height != null ? { height: attrs.height } : {},
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
 * Footnote feature (mirror of @docmost/editor-ext footnote, matching the MCP
 * schema mirror). Three nodes connected by `id`:
 *  - FootnoteReference: inline atom marker in the body (<sup data-footnote-ref>);
 *  - FootnotesList:     a single bottom container (<section data-footnotes>);
 *  - FootnoteDefinition: one editable note keyed by id (<div data-footnote-def>).
 * The visible number is not stored; it is derived from reference order. The
 * <sup> parse rule uses priority 100 so it beats the Superscript mark's <sup>
 * rule (otherwise an empty reference parses as an empty superscript and drops).
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.id ? { "data-id": attrs.id } : {},
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
        parseHTML: (el: HTMLElement) => el.getAttribute("data-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.id ? { "data-id": attrs.id } : {},
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

/**
 * Encode/decode the htmlEmbed `source` (arbitrary HTML/CSS/JS) to/from base64
 * for the `data-source` attribute. Ported from @docmost/editor-ext so the
 * markdown-converter HTML path (generateJSON via parseHTML) round-trips the
 * raw source losslessly and keeps it inert while it sits in the attribute.
 * `encodeURIComponent`/`decodeURIComponent` wrap btoa/atob so UTF-8 survives.
 */
export function encodeHtmlEmbedSource(source: string): string {
  if (!source) return "";
  try {
    if (typeof btoa === "function") {
      return btoa(encodeURIComponent(source));
    }
    return Buffer.from(encodeURIComponent(source), "utf-8").toString("base64");
  } catch {
    return "";
  }
}

export function decodeHtmlEmbedSource(encoded: string): string {
  if (!encoded) return "";
  try {
    if (typeof atob === "function") {
      return decodeURIComponent(atob(encoded));
    }
    return decodeURIComponent(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch {
    return "";
  }
}

/**
 * Docmost raw HTML embed. Block atom; the client renders `source` inside a
 * sandboxed iframe. Mirrors the @docmost/editor-ext node — `source` rides the
 * `data-source` attribute base64-encoded (this is an HTML/generateJSON path, so
 * it MUST use base64 to avoid double-encoding / injection).
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
        parseHTML: (el: HTMLElement) =>
          decodeHtmlEmbedSource(el.getAttribute("data-source") || ""),
        renderHTML: (attrs: Record<string, any>) => ({
          "data-source": encodeHtmlEmbedSource(attrs.source || ""),
        }),
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute("data-height");
          if (!v) return null;
          const n = parseInt(v, 10);
          return Number.isFinite(n) ? n : null;
        },
        renderHTML: (attrs: Record<string, any>) =>
          attrs.height != null ? { "data-height": String(attrs.height) } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="htmlEmbed"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { "data-type": "htmlEmbed", ...HTMLAttributes }];
  },
});

/**
 * Inline status pill. Mirrors @docmost/editor-ext status: the label rides in
 * the element's TEXT content (not an attribute) and the color in data-color.
 */
const Status = Node.create({
  name: "status",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (el: HTMLElement) => el.textContent || "",
      },
      color: {
        default: "gray",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-color") || "gray",
        renderHTML: (attrs: Record<string, any>) => ({
          "data-color": attrs.color ?? "gray",
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="status"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      { "data-type": "status", "data-color": HTMLAttributes["data-color"] },
      `${HTMLAttributes.text ?? ""}`,
    ];
  },
});

/**
 * Whole-page live embed. Holds only a `sourcePageId` reference. Mirrors
 * @docmost/editor-ext pageEmbed. Block atom.
 */
const PageEmbed = Node.create({
  name: "pageEmbed",
  group: "block",
  atom: true,
  isolating: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      sourcePageId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-source-page-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.sourcePageId
            ? { "data-source-page-id": attrs.sourcePageId }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="pageEmbed"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { "data-type": "pageEmbed", ...HTMLAttributes }];
  },
});

/**
 * Block node types allowed inside a `transclusionSource` (mirrors
 * @docmost/editor-ext transclusion constants). Excludes transclusion nodes
 * (no nesting) and child-only nodes.
 */
const TRANSCLUSION_SOURCE_CONTENT_EXPRESSION =
  "(paragraph | heading | blockquote | codeBlock | horizontalRule | bulletList" +
  " | orderedList | taskList | image | video | audio | attachment | callout" +
  " | details | embed | mathBlock | table | drawio | excalidraw | pdf" +
  " | subpages | columns | youtube)+";

/** Sync-source block: editable content shared into transclusion references. */
const TransclusionSource = Node.create({
  name: "transclusionSource",
  group: "block",
  content: TRANSCLUSION_SOURCE_CONTENT_EXPRESSION,
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.id ? { "data-id": attrs.id } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="transclusionSource"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { "data-type": "transclusionSource", ...HTMLAttributes }, 0];
  },
});

/** Live reference to a transcluded block/page. Block atom. */
const TransclusionReference = Node.create({
  name: "transclusionReference",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      sourcePageId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-source-page-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.sourcePageId
            ? { "data-source-page-id": attrs.sourcePageId }
            : {},
      },
      transclusionId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-transclusion-id"),
        renderHTML: (attrs: Record<string, any>) =>
          attrs.transclusionId
            ? { "data-transclusion-id": attrs.transclusionId }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="transclusionReference"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      { "data-type": "transclusionReference", ...HTMLAttributes },
    ];
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
    // #515: StarterKit's stock `code` mark declares `excludes: "_"`, which makes
    // ProseMirror drop EVERY co-occurring inline mark on the HTML -> PM parse
    // (generateJSON). CommonMark parses ``**`code`**`` as
    // `<strong><code>code</code></strong>`, so bold/italic/… around inline code
    // were silently lost (or slid onto the separator) on markdown import.
    // Disable it and register the local `excludes: "code"` override below.
    code: false,
  }),
  // Canonical policy lives in `@docmost/editor-ext` (`Code`), but this vendored
  // mirror must stay framework-free (importing editor-ext would drag React node
  // views into the markdown converter — see the header and #293), so the SAME
  // `excludes: "code"` is set locally. `test/schema-code-excludes-parity.test.ts`
  // fails loudly if the two ever drift apart.
  //
  // `"code"` (exclude only myself = ProseMirror's default), NOT `""` (exclude
  // nothing): y-prosemirror hashes the Yjs attribute key of any mark that does
  // not exclude itself (`code--<hash>`), which would give inline code a SECOND
  // persistence canon — see the rationale on the canonical mark in editor-ext.
  Code.extend({ excludes: "code" }),
  // Preserve image width/height as the AUTHORED string. Without an explicit
  // parseHTML the stock Image node attribute falls back to tiptap core's
  // `fromString`, which coerces a numeric width like "320" into the number 320
  // — changing the stored type on every markdown round-trip (Docmost stores
  // these as strings, e.g. "320" or "50%", matching how video/audio/pdf are
  // handled in this mirror). The node attribute is applied AFTER the global
  // DocmostAttributes one, so the fix must live on the Image node itself.
  Image.extend({
    addAttributes() {
      const parent = (this.parent?.() ?? {}) as Record<string, any>;
      return {
        ...parent,
        width: {
          ...parent.width,
          parseHTML: (el: HTMLElement) => el.getAttribute("width"),
        },
        height: {
          ...parent.height,
          parseHTML: (el: HTMLElement) => el.getAttribute("height"),
        },
        // Empty-string-vs-absent idempotency (GS-EDIT-REVERT class). `marked`
        // renders `![](src)` as `<img alt="">`, so the stock Image `alt`
        // parseHTML (`getAttribute("alt")`) materializes `alt: ""` on an image
        // that was stored with NO alt (attr absent). That is a false diff against
        // the editor-stored form (a no-alt image has alt ABSENT, not ""), so a
        // git-sync / ai-chat touch of a page with a plain image produced phantom
        // churn. Coerce an empty string back to the attr's default (null) so the
        // import is idempotent. A real alt survives verbatim (`|| undefined` keeps
        // the truthy value; the default fills the empty case). `title` is coerced
        // the same way for the whole class, even though `marked` does not
        // currently emit `title=""` — defence in depth against any path that does.
        // NOTE: this DIVERGES from editor-ext's literal image `alt` parseHTML
        // (`getAttribute("alt")`, which returns "" verbatim), but CONVERGES on
        // editor-ext's real STORED shape: an editor image inserted without alt
        // renders with no `alt` attribute and re-parses as absent, never "".
        alt: {
          ...parent.alt,
          parseHTML: (el: HTMLElement) => el.getAttribute("alt") || null,
        },
        title: {
          ...parent.title,
          parseHTML: (el: HTMLElement) => el.getAttribute("title") || null,
        },
      };
    },
  }).configure({ inline: false }),
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
          ...(parent as Record<string, any>).color,
          parseHTML: (el: HTMLElement) =>
            sanitizeCssColor(
              el.getAttribute("data-color") ||
                getStyleProperty(el, "background-color") ||
                el.style.backgroundColor,
            ),
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
  Spoiler,
  Callout,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  Mention,
  MathInline,
  MathBlock,
  Details,
  DetailsSummary,
  DetailsContent,
  Attachment,
  Video,
  Youtube,
  Embed,
  Drawio,
  Excalidraw,
  Columns,
  Column,
  Subpages,
  Audio,
  Pdf,
  PageBreak,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
  HtmlEmbed,
  Status,
  PageEmbed,
  TransclusionSource,
  TransclusionReference,
  DocmostAttributes,
];
