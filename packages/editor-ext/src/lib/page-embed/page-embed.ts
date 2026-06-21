import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

export interface PageEmbedOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface PageEmbedAttributes {
  sourcePageId?: string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageEmbed: {
      insertPageEmbed: (attributes: PageEmbedAttributes) => ReturnType;
    };
  }
}

/**
 * Whole-page live embed. Holds only a `sourcePageId` reference; the node view
 * fetches the source page's current content at render time, so the embed stays
 * live (no snapshot is stored in the host document). Separate from
 * `transclusionReference` (which addresses a single block by `transclusionId`).
 */
export const PageEmbed = Node.create<PageEmbedOptions>({
  name: "pageEmbed",

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  group: "block",
  atom: true,
  isolating: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      sourcePageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-source-page-id"),
        renderHTML: (attrs) =>
          attrs.sourcePageId
            ? { "data-source-page-id": attrs.sourcePageId }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-type="${this.name}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
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
      insertPageEmbed:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: attributes,
          }),
    };
  },

  addNodeView() {
    if (!this.options.view) return null;
    this.editor.isInitialized = true;
    return ReactNodeViewRenderer(this.options.view);
  },
});
