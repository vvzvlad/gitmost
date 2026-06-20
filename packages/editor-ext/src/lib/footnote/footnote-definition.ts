import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { FOOTNOTE_DEFINITION_NAME } from "./footnote-util";

export interface FootnoteDefinitionOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

/**
 * A single footnote definition: an editable block (paragraphs only, no nested
 * footnotes) keyed by `id` to its reference. Lives only inside `footnotesList`.
 */
export const FootnoteDefinition = Node.create<FootnoteDefinitionOptions>({
  name: FOOTNOTE_DEFINITION_NAME,

  // paragraph+ keeps definitions simple. Note this does NOT block nested
  // footnote references on its own: a footnoteReference is inline and the
  // paragraphs here accept inline content, so the schema would permit one.
  // Nested references are instead prevented by the setFootnote command and the
  // sync plugin (which refuse to create/keep a reference inside a definition).
  content: "paragraph+",
  defining: true,
  isolating: true,
  selectable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-id"),
        renderHTML: (attributes) => {
          if (!attributes.id) return {};
          return { "data-id": attributes.id };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-footnote-def]",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        { "data-footnote-def": "", class: "footnote-def" },
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
