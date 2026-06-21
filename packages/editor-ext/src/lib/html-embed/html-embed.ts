import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

export interface HtmlEmbedOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface HtmlEmbedAttributes {
  // Raw HTML/CSS/JS string rendered inside a sandboxed iframe by the NodeView.
  source?: string;
  // Fixed iframe height in pixels. null/absent => auto-resize via postMessage.
  height?: number | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    htmlEmbed: {
      setHtmlEmbed: (attributes?: HtmlEmbedAttributes) => ReturnType;
    };
  }
}

/**
 * Encode the raw source to base64 for the `data-source` attribute.
 *
 * The source is arbitrary HTML/CSS/JS. Storing it raw inside an HTML attribute
 * would (a) require heavy escaping and (b) risk the parser interpreting markup
 * inside the attribute. Base64 makes the round-trip HTML <-> ProseMirror JSON
 * lossless and keeps the markup inert while it sits in the attribute.
 *
 * `encodeURIComponent`/`decodeURIComponent` wrap btoa/atob so that non-Latin1
 * (UTF-8) characters survive the base64 step.
 */
export function encodeHtmlEmbedSource(source: string): string {
  if (!source) return "";
  try {
    if (typeof btoa === "function") {
      return btoa(encodeURIComponent(source));
    }
    // Node fallback (server-side schema parsing has no global btoa).
    return Buffer.from(encodeURIComponent(source), "utf-8").toString("base64");
  } catch {
    // On an encoding error we drop to "" rather than returning the raw source.
    // Returning raw markup here is NOT a safe fallback: the value is stored in
    // the `data-source` attribute and read back through decodeHtmlEmbedSource,
    // which base64-decodes it — raw (un-encoded) HTML would make atob/
    // decodeURIComponent throw and decode to "" anyway, and an un-encoded value
    // sitting in the attribute defeats the inert-storage guarantee (it could
    // become an injection vector). So "" is the correct, decode-symmetric
    // failure mode. In practice this is essentially unreachable: btoa runs on
    // the output of encodeURIComponent, which is always Latin1-safe ASCII.
    return "";
  }
}

export function decodeHtmlEmbedSource(encoded: string): string {
  if (!encoded) return "";
  try {
    if (typeof atob === "function") {
      return decodeURIComponent(atob(encoded));
    }
    // Node fallback.
    return decodeURIComponent(
      Buffer.from(encoded, "base64").toString("utf-8"),
    );
  } catch {
    return "";
  }
}

export const HtmlEmbed = Node.create<HtmlEmbedOptions>({
  name: "htmlEmbed",
  inline: false,
  group: "block",
  // atom + isolating: the node has no editable ProseMirror children; its body
  // is the opaque `source` string rendered by the NodeView.
  atom: true,
  isolating: true,
  defining: true,
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  addAttributes() {
    return {
      source: {
        default: "",
        // Decode the base64 payload back to the raw source on parse.
        parseHTML: (element) =>
          decodeHtmlEmbedSource(element.getAttribute("data-source") || ""),
        // Encode the raw source to base64 on render so it round-trips losslessly
        // through the HTML <-> JSON conversions used by export/import/collab.
        renderHTML: (attributes: HtmlEmbedAttributes) => ({
          "data-source": encodeHtmlEmbedSource(attributes.source || ""),
        }),
      },
      // Fixed iframe height in px. null/absent => auto-resize on the client.
      height: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("data-height");
          if (!v) return null;
          const n = parseInt(v, 10);
          // A non-numeric data-height (e.g. crafted/corrupted import) must not
          // become NaN: NaN is typeof "number" and would disable auto-resize and
          // yield an unclamped iframe height downstream. Treat it as auto (null).
          return Number.isFinite(n) ? n : null;
        },
        renderHTML: (attrs: HtmlEmbedAttributes) =>
          attrs.height ? { "data-height": String(attrs.height) } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[data-type="${this.name}"]`,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // The static HTML representation is just a marker div carrying the encoded
    // source. The actual raw markup is NOT expanded here on purpose: the static
    // generateHTML output (used for previews, search indexing, exports) must not
    // itself become an injection vector. Only the client NodeView expands and
    // executes the source.
    return [
      "div",
      mergeAttributes(
        { "data-type": this.name },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
    ];
  },

  addCommands() {
    return {
      setHtmlEmbed:
        (attrs: HtmlEmbedAttributes) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: attrs,
          });
        },
    };
  },

  addNodeView() {
    // Force the react node view to render immediately using flush sync.
    this.editor.isInitialized = true;
    return ReactNodeViewRenderer(this.options.view);
  },
});
