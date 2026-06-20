import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTE_REFERENCE_NAME,
  computeFootnoteNumbers,
} from "./footnote-util";

export const footnoteNumberingPluginKey = new PluginKey("footnoteNumbering");

/**
 * Build the decoration set for footnote numbers. Pure function of the document:
 * walk references in document order, assign 1-based numbers, then attach a
 * node decoration (carrying the number via a CSS variable + data attribute) to
 * every reference and to every matching definition. Because it is deterministic
 * from the document alone, all collaborating clients compute identical numbers
 * with no document mutation.
 */
export function buildFootnoteDecorations(doc: ProseMirrorNode): DecorationSet {
  const numbers = computeFootnoteNumbers(doc);
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE_REFERENCE_NAME) {
      const num = numbers.get(node.attrs.id);
      if (num != null) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            "data-footnote-number": String(num),
            style: `--footnote-number: "${num}";`,
          }),
        );
      }
    }
    if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
      const num = numbers.get(node.attrs.id);
      if (num != null) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            "data-footnote-number": String(num),
            style: `--footnote-number: "${num}";`,
          }),
        );
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * ProseMirror plugin that renders footnote numbers as decorations. It never
 * mutates the document (safe in read-only / share and in collaboration) — it
 * only recomputes decorations from the current doc on each transaction.
 */
export function footnoteNumberingPlugin(): Plugin {
  return new Plugin({
    key: footnoteNumberingPluginKey,
    state: {
      init(_, { doc }) {
        return buildFootnoteDecorations(doc);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old;
        return buildFootnoteDecorations(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
