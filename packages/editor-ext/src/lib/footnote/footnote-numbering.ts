import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTE_REFERENCE_NAME,
  computeFootnoteNumbers,
  computeFootnoteRefCounts,
} from './footnote-util';

export const footnoteNumberingPluginKey = new PluginKey<FootnoteNumberingState>(
  'footnoteNumbering',
);

/**
 * Cached state of the numbering plugin. Both the displayed-number map and the
 * decoration set are computed ONCE per doc-changing transaction (in `apply`) and
 * cached here, so NodeViews can read a footnote's number by id without walking
 * the whole document on every React render (which was O(n^2) per keystroke in
 * large docs).
 */
interface FootnoteNumberingState {
  /** referenceId -> 1-based display number, for the current doc. */
  numbers: Map<string, number>;
  /** referenceId -> number of reference occurrences (>= 1), for the definition's
   *  multi-backlink UI (#168). */
  refCounts: Map<string, number>;
  /** Decorations rendering those numbers (refs + definitions). */
  decorations: DecorationSet;
}

/**
 * Build the decoration set for footnote numbers. Pure function of the document:
 * walk references in document order, assign 1-based numbers, then attach a
 * node decoration (carrying the number via a CSS variable + data attribute) to
 * every reference and to every matching definition. Because it is deterministic
 * from the document alone, all collaborating clients compute identical numbers
 * with no document mutation.
 */
export function buildFootnoteDecorations(doc: ProseMirrorNode): DecorationSet {
  return buildFootnoteNumberingState(doc).decorations;
}

/**
 * Compute both the number map AND the decorations for `doc` in a single walk.
 * The plugin caches the result so NodeViews can read numbers without
 * recomputing.
 */
function buildFootnoteNumberingState(
  doc: ProseMirrorNode,
): FootnoteNumberingState {
  const numbers = computeFootnoteNumbers(doc);
  const refCounts = computeFootnoteRefCounts(doc);
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE_REFERENCE_NAME) {
      const num = numbers.get(node.attrs.id);
      if (num != null) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            'data-footnote-number': String(num),
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
            'data-footnote-number': String(num),
            style: `--footnote-number: "${num}";`,
          }),
        );
      }
    }
  });

  return {
    numbers,
    refCounts,
    decorations: DecorationSet.create(doc, decorations),
  };
}

/**
 * Read the cached footnote number for `id` from the numbering plugin's state.
 * This is the source NodeViews should use instead of calling
 * computeFootnoteNumbers() on every render (that walked the whole doc per
 * NodeView per render = O(n^2) per keystroke). Returns undefined if the plugin
 * is not installed or the id has no number yet.
 */
export function getFootnoteNumber(
  state: EditorState,
  id: string,
): number | undefined {
  return footnoteNumberingPluginKey.getState(state)?.numbers.get(id);
}

/**
 * Read the cached reference-occurrence count for `id` (how many `[^id]` links
 * point at this definition). Drives the definition's multi-backlink UI (#168):
 * `> 1` renders ↩ a b c …, each scrolling to its own occurrence. Returns 0 when
 * the plugin is not installed or the id is unknown (caller treats as single).
 */
export function getFootnoteRefCount(state: EditorState, id: string): number {
  return footnoteNumberingPluginKey.getState(state)?.refCounts.get(id) ?? 0;
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
        return buildFootnoteNumberingState(doc);
      },
      apply(tr, old) {
        // Recompute (and re-cache) only when the document actually changed, so
        // the number map NodeViews read stays current on every edit while
        // non-doc transactions (selection, etc.) reuse the cache for free.
        if (!tr.docChanged) return old;
        return buildFootnoteNumberingState(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return footnoteNumberingPluginKey.getState(state)?.decorations;
      },
    },
  });
}
