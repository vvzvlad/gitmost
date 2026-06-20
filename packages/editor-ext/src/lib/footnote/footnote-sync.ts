import { Plugin, PluginKey, Transaction } from "@tiptap/pm/state";
import { Node as ProseMirrorNode, Fragment } from "@tiptap/pm/model";
import {
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
} from "./footnote-util";

export const footnoteSyncPluginKey = new PluginKey("footnoteSync");

const SYNC_META = "footnoteSyncApplied";

interface FootnoteScan {
  /** Reference ids in document order, first occurrence only, de-duplicated. */
  referenceIds: string[];
  /** definition id -> node (last occurrence wins, matching scan order). */
  definitions: Map<string, ProseMirrorNode>;
  /** Every top-level footnotesList node, in document order. */
  lists: Array<{ pos: number; node: ProseMirrorNode }>;
}

function scan(doc: ProseMirrorNode): FootnoteScan {
  const referenceIds: string[] = [];
  const seenRefs = new Set<string>();
  const definitions = new Map<string, ProseMirrorNode>();
  const lists: Array<{ pos: number; node: ProseMirrorNode }> = [];

  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE_REFERENCE_NAME) {
      const id = node.attrs.id;
      if (id && !seenRefs.has(id)) {
        seenRefs.add(id);
        referenceIds.push(id);
      }
    }
    if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
      const id = node.attrs.id;
      if (id) definitions.set(id, node);
    }
    if (node.type.name === FOOTNOTES_LIST_NAME) {
      lists.push({ pos, node });
    }
  });

  return { referenceIds, definitions, lists };
}

/**
 * Idempotent integrity pass for footnotes. Runs only on LOCAL document changes
 * (skips remote/collaboration steps and — crucially — its own appended meta) so
 * the plugin can never re-trigger itself, guaranteeing termination.
 *
 * Everything is computed against the CURRENT document in a SINGLE invocation and
 * emitted as AT MOST ONE transaction, always tagged with SYNC_META (and
 * addToHistory:false). The strategy is "rebuild the canonical footnotes section
 * from the desired end-state" rather than running several self-triggering
 * passes:
 *
 *  1. Collect every footnote reference id in document order (the source of
 *     truth for which definitions must exist and in what order).
 *  2. Compute the desired list of definitions: one per referenced id, in
 *     reference order, reusing the existing definition node when present or
 *     creating an empty one when missing. Orphan definitions (no matching
 *     reference) are dropped.
 *  3. Compare against the actual footnotesList state:
 *       - no references           -> there must be NO list (remove any);
 *       - references present       -> there must be exactly ONE list, holding
 *                                     exactly the desired definitions, and it
 *                                     must sit after all real body content.
 *  4. If the document already matches the desired end-state, return null (no
 *     transaction) — this idempotence is what stops oscillation.
 *
 * Placement note: the list is considered correctly placed when nothing but
 * EMPTY paragraphs follow it. This is deliberate so the plugin coexists with a
 * trailing-node plugin (which keeps an empty paragraph at the very end of the
 * doc): the footnote list does not need to be the literal last child, only the
 * last block of meaningful content. Without this, the two plugins would
 * ping-pong forever (list moved to end -> trailing paragraph appended -> list
 * no longer last -> moved again ...).
 *
 * Paste id-collision regeneration is left to the paste handler / v2; the common
 * cases (orphans, missing definitions, multiple/empty/misplaced lists) are
 * covered here.
 */
export function footnoteSyncPlugin(
  isRemoteTransaction?: (tr: Transaction) => boolean,
): Plugin {
  return new Plugin({
    key: footnoteSyncPluginKey,
    appendTransaction(transactions, _oldState, newState) {
      // Only react to document changes.
      if (!transactions.some((t) => t.docChanged)) return null;
      // Skip our OWN appended transaction. This is the guard that makes the
      // plugin loop-safe: the transaction we emit carries SYNC_META, so when
      // ProseMirror feeds it back to appendTransaction we bail out immediately
      // and never produce a follow-up. (Termination invariant.)
      if (transactions.some((t) => t.getMeta(SYNC_META))) return null;
      // Skip remote/collab steps (orphan cleanup must run only on local edits).
      if (
        isRemoteTransaction &&
        transactions.some((t) => isRemoteTransaction(t))
      ) {
        return null;
      }

      const { doc, schema } = newState;
      const defType = schema.nodes[FOOTNOTE_DEFINITION_NAME];
      const listType = schema.nodes[FOOTNOTES_LIST_NAME];
      const paragraphType = schema.nodes.paragraph;
      if (!defType || !listType || !paragraphType) return null;

      const info = scan(doc);

      // 1) Desired definitions: one per referenced id, in reference order,
      //    reusing existing definition nodes (preserving their content) and
      //    synthesizing empty ones for references that lack a definition.
      const desiredDefs: ProseMirrorNode[] = info.referenceIds.map((id) => {
        const existing = info.definitions.get(id);
        if (existing) return existing;
        return defType.create({ id }, paragraphType.create());
      });

      // 2) Determine whether the document already matches the desired end-state.
      const hasRefs = desiredDefs.length > 0;

      // Is the existing single list already exactly the desired list, placed
      // after all meaningful content (nothing but empty paragraphs after it)?
      const isEmptyParagraph = (node: ProseMirrorNode) =>
        node.type === paragraphType && node.content.size === 0;

      let alreadyCanonical = false;
      if (!hasRefs) {
        // Canonical when there is no footnotesList at all.
        alreadyCanonical = info.lists.length === 0;
      } else if (info.lists.length === 1) {
        const { pos, node } = info.lists[0];
        // Same definitions, same order, same identity (no rewrite needed)?
        const sameDefs =
          node.childCount === desiredDefs.length &&
          desiredDefs.every((d, i) => node.child(i) === d);

        // Placement: only empty paragraphs may follow the list.
        const listEnd = pos + node.nodeSize;
        let onlyEmptyParasAfter = true;
        doc.nodesBetween(listEnd, doc.content.size, (child, childPos) => {
          // Only inspect top-level children that start at/after the list end.
          if (childPos >= listEnd && child !== node) {
            if (!isEmptyParagraph(child)) onlyEmptyParasAfter = false;
          }
          return false; // do not descend
        });

        alreadyCanonical = sameDefs && onlyEmptyParasAfter;
      }

      if (alreadyCanonical) return null;

      // 3) Rebuild: produce exactly ONE transaction that reaches the end-state.
      const tr = newState.tr;

      // Delete every existing footnotesList (from the end so earlier positions
      // stay valid while we mutate).
      [...info.lists]
        .sort((a, b) => b.pos - a.pos)
        .forEach(({ pos, node }) => {
          tr.delete(pos, pos + node.nodeSize);
        });

      if (hasRefs) {
        // Insert a single canonical list holding the desired definitions. Place
        // it after the last meaningful (non-empty-paragraph) top-level block, so
        // it lands before any trailing empty paragraph the trailing-node plugin
        // maintains. This keeps both plugins idempotent.
        const mappedDoc = tr.doc;
        let insertPos = mappedDoc.content.size;
        for (let i = mappedDoc.childCount - 1; i >= 0; i--) {
          const child = mappedDoc.child(i);
          if (isEmptyParagraph(child)) {
            // skip trailing empty paragraphs; insert before them
            insertPos -= child.nodeSize;
          } else {
            break;
          }
        }

        const merged = listType.create(null, Fragment.fromArray(desiredDefs));
        tr.insert(insertPos, merged);
      }

      if (!tr.docChanged) return null;

      tr.setMeta(SYNC_META, true);
      tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
