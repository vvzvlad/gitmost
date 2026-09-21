import { EditorState, Plugin, PluginKey, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import {
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTE_REFERENCE_NAME,
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
  /** Whether the document contains ANY footnote reference/definition node.
   *  Cached so `apply` can skip the whole-doc walk on every keystroke in the
   *  common case (documents with no footnotes), recomputing only once a
   *  transaction actually inserts a footnote node (#343, PART 5). */
  hasFootnotes: boolean;
}

/** Reusable empty state for footnote-free documents — avoids reallocating an
 *  empty map/decoration set on every keystroke while there are no footnotes. */
const EMPTY_STATE: FootnoteNumberingState = {
  numbers: new Map(),
  refCounts: new Map(),
  decorations: DecorationSet.empty,
  hasFootnotes: false,
};

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

function numberDecoration(pos: number, nodeSize: number, num: number): Decoration {
  return Decoration.node(pos, pos + nodeSize, {
    'data-footnote-number': String(num),
    style: `--footnote-number: "${num}";`,
  });
}

/**
 * Compute the number map, reference counts AND the decorations for `doc` in a
 * SINGLE document walk (previously three separate O(n) traversals per
 * docChanged — computeFootnoteNumbers + computeFootnoteRefCounts + a decoration
 * pass, #343 PART 5). The plugin caches the result so NodeViews can read numbers
 * without recomputing.
 *
 * References are numbered and decorated as they are encountered (document
 * order). Definition positions are collected during the same walk and decorated
 * afterwards from the completed number map — so a definition that appears before
 * its reference in document order still resolves to the correct number, and the
 * output is identical to the previous three-pass implementation. (Decoration
 * insertion order does not matter: DecorationSet.create indexes by position.)
 */
function buildFootnoteNumberingState(
  doc: ProseMirrorNode,
): FootnoteNumberingState {
  const numbers = new Map<string, number>();
  const refCounts = new Map<string, number>();
  const decorations: Decoration[] = [];
  const definitions: { id: string; pos: number; nodeSize: number }[] = [];
  let n = 0;
  let hasFootnotes = false;

  doc.descendants((node, pos) => {
    const typeName = node.type.name;
    if (typeName === FOOTNOTE_REFERENCE_NAME) {
      hasFootnotes = true;
      const id = node.attrs.id;
      if (id) {
        if (!numbers.has(id)) numbers.set(id, ++n);
        refCounts.set(id, (refCounts.get(id) ?? 0) + 1);
        decorations.push(numberDecoration(pos, node.nodeSize, numbers.get(id)!));
      }
    } else if (typeName === FOOTNOTE_DEFINITION_NAME) {
      hasFootnotes = true;
      const id = node.attrs.id;
      if (id != null) definitions.push({ id, pos, nodeSize: node.nodeSize });
    }
  });

  if (!hasFootnotes) return EMPTY_STATE;

  for (const def of definitions) {
    const num = numbers.get(def.id);
    if (num != null) {
      decorations.push(numberDecoration(def.pos, def.nodeSize, num));
    }
  }

  return {
    numbers,
    refCounts,
    decorations: DecorationSet.create(doc, decorations),
    hasFootnotes: true,
  };
}

/**
 * Cheap check: does any of a transaction's inserted content contain a footnote
 * reference/definition node? Footnote nodes can only ENTER the document through
 * replace steps (ReplaceStep / ReplaceAroundStep both expose a `.slice`), so
 * scanning only the inserted slices — O(change size), not O(doc) — is sufficient
 * to detect a newly-added footnote. Mark/attr steps never introduce nodes.
 * Lets `apply` keep skipping the whole-doc walk until a footnote first appears.
 */
function transactionInsertsFootnote(tr: Transaction): boolean {
  for (const step of tr.steps) {
    const slice = (step as unknown as { slice?: Slice }).slice;
    if (!slice || slice.content.size === 0) continue;
    let found = false;
    slice.content.descendants((node) => {
      if (found) return false;
      const typeName = node.type.name;
      if (
        typeName === FOOTNOTE_REFERENCE_NAME ||
        typeName === FOOTNOTE_DEFINITION_NAME
      ) {
        found = true;
        return false;
      }
      return true;
    });
    if (found) return true;
  }
  return false;
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
        // Short-circuit the whole-doc walk while the document has no footnotes:
        // if there were none and this transaction did not INSERT one, there is
        // still nothing to number, so reuse the empty state (#343, PART 5). Once
        // a footnote exists we always rebuild (covers renumbering/deletion).
        if (!old.hasFootnotes && !transactionInsertsFootnote(tr)) {
          return old;
        }
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
