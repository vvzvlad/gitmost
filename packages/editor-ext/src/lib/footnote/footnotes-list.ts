import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { FOOTNOTES_LIST_NAME } from "./footnote-util";

export interface FootnotesListOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

/**
 * Block container that holds all footnote definitions. There is a single
 * instance per document and it is always the last child of the doc (enforced by
 * the sync plugin). Modeled on the callout block node.
 */
export const FootnotesList = Node.create<FootnotesListOptions>({
  name: FOOTNOTES_LIST_NAME,

  group: "block",
  content: "footnoteDefinition+",
  isolating: true,
  selectable: false,
  defining: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  parseHTML() {
    return [
      {
        tag: "section[data-footnotes]",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      mergeAttributes(
        { "data-footnotes": "", class: "footnotes" },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      0,
    ];
  },

  addNodeView() {
    if (!this.options.view) return null;
    this.editor.isInitialized = true;
    return ReactNodeViewRenderer(this.options.view);
  },
});
