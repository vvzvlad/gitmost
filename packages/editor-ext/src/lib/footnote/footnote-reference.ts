import { mergeAttributes, Node } from "@tiptap/core";
import { TextSelection, Transaction } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import {
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
  generateFootnoteId,
} from "./footnote-util";
import { footnoteNumberingPlugin } from "./footnote-numbering";
import { footnoteSyncPlugin } from "./footnote-sync";

export interface FootnoteReferenceOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
  /**
   * Optional predicate identifying remote/collaboration transactions so the
   * sync plugin skips them (orphan cleanup must run only on local changes).
   */
  isRemoteTransaction?: (tr: Transaction) => boolean;
  /**
   * When false, the footnote sync/integrity plugin is fully disabled — it never
   * appends a transaction. Numbering decorations stay active. Set this in
   * read-only / share editors so a viewer's doc is decorated (numbered) but
   * never mutated (e.g. by a programmatic setContent). Defaults to true.
   */
  enableSync?: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: {
      /**
       * Insert a footnote reference at the cursor and create the matching
       * (empty) definition in the bottom footnotes list, in one transaction.
       */
      setFootnote: () => ReturnType;
      /**
       * Remove a footnote reference and cascade-delete its definition (one
       * transaction so a single undo restores both).
       */
      removeFootnote: (id: string) => ReturnType;
      /** Scroll to (and focus) a footnote definition by id. */
      scrollToFootnote: (id: string) => ReturnType;
      /** Scroll to (and select) a footnote reference by id. */
      scrollToReference: (id: string) => ReturnType;
    };
  }
}

/**
 * Inline atom that marks a footnote reference in the body text. It holds only
 * an `id` linking it to its `footnoteDefinition`; the visible number is NOT
 * stored — it is rendered by the numbering plugin as a decoration (see
 * footnote-numbering.ts). Modeled on mention.ts (inline atom).
 *
 * The reference is forbidden inside code blocks and inside footnote definitions
 * (no nested footnotes); those restrictions are enforced by the `setFootnote`
 * command and the sync plugin rather than by schema content expressions, since
 * an inline group node cannot express "not inside X" declaratively.
 */
export const FootnoteReference = Node.create<FootnoteReferenceOptions>({
  name: FOOTNOTE_REFERENCE_NAME,

  // Higher than the default (100) so its parse rule is considered before the
  // Superscript mark's <sup> rule.
  priority: 101,

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
      isRemoteTransaction: undefined,
      enableSync: true,
    };
  },

  addProseMirrorPlugins() {
    const plugins = [footnoteNumberingPlugin()];
    // Numbering always runs (decoration-only). The sync/integrity plugin is
    // skipped entirely when sync is disabled (read-only / share) so the viewer's
    // doc is never mutated.
    if (this.options.enableSync !== false) {
      plugins.push(footnoteSyncPlugin(this.options.isRemoteTransaction));
    }
    return plugins;
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
        // High priority so the Superscript mark (which also matches <sup>) does
        // not claim a footnote reference and drop it as empty content.
        tag: "sup[data-footnote-ref]",
        priority: 100,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "sup",
      mergeAttributes(
        { "data-footnote-ref": "", class: "footnote-ref" },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
    ];
  },

  // Plain-text representation (used by generateText / markdown text fallbacks).
  renderText({ node }) {
    return `[^${node.attrs.id ?? ""}]`;
  },

  addNodeView() {
    if (!this.options.view) return null;
    // Force the react node view to render immediately using flush sync.
    this.editor.isInitialized = true;
    return ReactNodeViewRenderer(this.options.view);
  },

  addCommands() {
    return {
      setFootnote:
        () =>
        ({ state, tr, dispatch, editor }) => {
          const { schema, selection } = state;
          const refType = schema.nodes[FOOTNOTE_REFERENCE_NAME];
          const listType = schema.nodes[FOOTNOTES_LIST_NAME];
          const defType = schema.nodes[FOOTNOTE_DEFINITION_NAME];
          if (!refType || !listType || !defType) return false;

          const { $from } = selection;

          // Forbid references inside code blocks and inside footnote definitions
          // (no nested footnotes).
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (
              node.type.spec.code ||
              node.type.name === FOOTNOTE_DEFINITION_NAME ||
              node.type.name === FOOTNOTES_LIST_NAME
            ) {
              return false;
            }
          }

          // Make sure the parent accepts an inline atom here.
          const insertPos = selection.from;
          if (!$from.parent.type.spec.content?.includes("inline") &&
              !$from.parent.isTextblock) {
            return false;
          }

          const id = generateFootnoteId();

          // 1) Count references that occur strictly before the insertion point;
          //    the new definition goes at that index in the bottom list so the
          //    list order matches reference order.
          let refsBefore = 0;
          state.doc.nodesBetween(0, insertPos, (node) => {
            if (node.type.name === FOOTNOTE_REFERENCE_NAME) refsBefore++;
          });

          // 2) Insert the reference at the cursor.
          tr.insert(insertPos, refType.create({ id }));

          // 3) Locate (or create) the footnotes list, then insert the new
          //    definition at index `refsBefore`.
          const emptyParagraph = schema.nodes.paragraph.create();
          const definition = defType.create({ id }, emptyParagraph);

          // Find existing list (always the last top-level child if present).
          let listPos: number | null = null;
          let listNode: any = null;
          tr.doc.forEach((child, offset) => {
            if (child.type.name === FOOTNOTES_LIST_NAME) {
              listPos = offset;
              listNode = child;
            }
          });

          let defInsidePos: number | null = null;
          if (listNode == null) {
            // Create a new list at the very end of the document.
            const list = listType.create(null, definition);
            const end = tr.doc.content.size;
            tr.insert(end, list);
            // Cursor target: inside the new definition's first paragraph.
            // end -> list open, +1 definition open, +1 paragraph open.
            defInsidePos = end + 3;
          } else {
            // Insert at the right index within the existing list.
            const listStart = listPos! + 1; // position of the first definition
            let pos = listStart;
            let index = 0;
            listNode.forEach((defChild: any, defOffset: number) => {
              if (index < refsBefore) {
                pos = listStart + defOffset + defChild.nodeSize;
                index++;
              }
            });
            tr.insert(pos, definition);
            defInsidePos = pos + 2; // +1 enter definition, +1 enter paragraph
          }

          if (dispatch) {
            // Move the cursor into the new definition's paragraph so the user
            // can immediately type the footnote text.
            try {
              const resolved = tr.doc.resolve(
                Math.min(defInsidePos!, tr.doc.content.size),
              );
              tr.setSelection(TextSelection.near(resolved));
            } catch {
              // Selection placement is best-effort; ignore failures.
            }
            tr.scrollIntoView();
            dispatch(tr);
          }

          return true;
        },

      removeFootnote:
        (id: string) =>
        ({ state, tr, dispatch }) => {
          if (!id) return false;

          // Collect: reference range(s), the definition range, and the list.
          const refRanges: Array<{ from: number; to: number }> = [];
          let defRange: { from: number; to: number } | null = null;
          let listInfo: { pos: number; size: number; count: number } | null =
            null;

          state.doc.descendants((node, pos) => {
            if (
              node.type.name === FOOTNOTE_REFERENCE_NAME &&
              node.attrs.id === id
            ) {
              refRanges.push({ from: pos, to: pos + node.nodeSize });
            }
            if (
              node.type.name === FOOTNOTE_DEFINITION_NAME &&
              node.attrs.id === id
            ) {
              defRange = { from: pos, to: pos + node.nodeSize };
            }
            if (node.type.name === FOOTNOTES_LIST_NAME) {
              listInfo = {
                pos,
                size: node.nodeSize,
                count: node.childCount,
              };
            }
          });

          if (refRanges.length === 0 && !defRange) return false;

          // Build the list of ranges to delete. If removing this definition
          // would empty the list (it is the list's only child), delete the
          // entire list instead — an empty footnotesList is invalid schema and
          // a leftover empty list would be ugly.
          const ranges: Array<{ from: number; to: number }> = [...refRanges];
          if (defRange) {
            if (listInfo && (listInfo as any).count <= 1) {
              const li = listInfo as { pos: number; size: number };
              ranges.push({ from: li.pos, to: li.pos + li.size });
            } else {
              ranges.push(defRange);
            }
          }

          // Delete from the end so earlier positions stay valid.
          ranges
            .sort((a, b) => b.from - a.from)
            .forEach(({ from, to }) => tr.delete(from, to));

          if (dispatch) dispatch(tr);
          return true;
        },

      scrollToFootnote:
        (id: string) =>
        ({ editor }) => {
          if (!id) return false;
          const dom = editor.view.dom.querySelector(
            `[data-footnote-def][data-id="${id}"]`,
          ) as HTMLElement | null;
          if (!dom) return false;
          dom.scrollIntoView({ behavior: "smooth", block: "center" });
          return true;
        },

      scrollToReference:
        (id: string) =>
        ({ editor }) => {
          if (!id) return false;
          const dom = editor.view.dom.querySelector(
            `sup[data-footnote-ref][data-id="${id}"]`,
          ) as HTMLElement | null;
          if (!dom) return false;
          dom.scrollIntoView({ behavior: "smooth", block: "center" });
          return true;
        },
    };
  },
});
