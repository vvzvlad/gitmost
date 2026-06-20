import { Plugin, PluginKey, Transaction } from "@tiptap/pm/state";
import { Node as ProseMirrorNode, Fragment, Slice } from "@tiptap/pm/model";
import {
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
  deriveFootnoteId,
} from "./footnote-util";

export const footnoteSyncPluginKey = new PluginKey("footnoteSync");

const SYNC_META = "footnoteSyncApplied";

interface RefOccurrence {
  /** Position of the reference node in the document. */
  pos: number;
  /** The id the reference currently carries. */
  id: string;
  node: ProseMirrorNode;
}

interface DefOccurrence {
  /** Position of the definition node in the document. */
  pos: number;
  /** The id the definition currently carries. */
  id: string;
  node: ProseMirrorNode;
}

interface FootnoteScan {
  /**
   * Every reference occurrence in document order (NOT de-duplicated). Needed so
   * that duplicate ids — which would otherwise be silently collapsed — can be
   * detected and (together with their definitions) re-id'd instead of dropped.
   */
  refOccurrences: RefOccurrence[];
  /**
   * Every definition occurrence in document order (NOT de-duplicated). The old
   * implementation used a last-wins Map here, which is exactly what caused
   * silent data loss: two definitions sharing an id collapsed to one.
   */
  defOccurrences: DefOccurrence[];
  /** Every top-level footnotesList node, in document order. */
  lists: Array<{ pos: number; node: ProseMirrorNode }>;
}

function scan(doc: ProseMirrorNode): FootnoteScan {
  const refOccurrences: RefOccurrence[] = [];
  const defOccurrences: DefOccurrence[] = [];
  const lists: Array<{ pos: number; node: ProseMirrorNode }> = [];

  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE_REFERENCE_NAME) {
      const id = node.attrs.id;
      if (id) refOccurrences.push({ pos, id, node });
    }
    if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
      const id = node.attrs.id;
      if (id) defOccurrences.push({ pos, id, node });
    }
    if (node.type.name === FOOTNOTES_LIST_NAME) {
      lists.push({ pos, node });
    }
  });

  return { refOccurrences, defOccurrences, lists };
}

/**
 * Result of resolving id collisions: a 1:1, de-duplicated pairing plan plus the
 * concrete reference re-id edits that must be applied to the body so the doc no
 * longer contains two footnotes sharing a single id.
 *
 * The overriding invariant is that NO definition is ever dropped here: every
 * definition occurrence ends up with a unique id and therefore survives the
 * canonical rebuild. Duplicate references are likewise re-id'd (and paired with
 * a duplicate definition when one exists) so importing/pasting `[^d]` twice with
 * two `[^d]:` definitions yields TWO distinct footnotes rather than one.
 */
interface CollisionPlan {
  /**
   * Reference ids in document order, de-duplicated AFTER re-id. This is the
   * source of truth for definition order/numbering, exactly as before — only
   * now collisions have been resolved so it no longer hides duplicates.
   */
  referenceIds: string[];
  /** id -> definition node, after duplicates were re-id'd. One entry per id. */
  definitions: Map<string, ProseMirrorNode>;
  /**
   * Body reference re-id edits to apply (position of a reference node -> the
   * fresh id it must carry). Empty when there are no colliding references.
   */
  refReids: Array<{ pos: number; node: ProseMirrorNode; newId: string }>;
  /** True when any collision required a re-id (refs and/or defs). */
  changed: boolean;
}

/**
 * Resolve duplicate-id collisions among references and definitions WITHOUT ever
 * dropping a definition.
 *
 * Strategy:
 *  - Walk references in document order. The FIRST reference for an id keeps it.
 *    Any later reference sharing that id is a duplicate and gets a fresh unique
 *    id; if a still-unclaimed duplicate definition with the original id exists,
 *    it is re-id'd to the SAME fresh id so the (ref, def) pair stays matched.
 *  - Walk definitions in document order. The FIRST definition for an id keeps
 *    it; later duplicates that were not already claimed by a duplicate reference
 *    get their own fresh unique id (surviving as a distinct footnote/orphan).
 *
 * Re-id determinism: every fresh id is DERIVED from document state via
 * deriveFootnoteId (e.g. `X__2`, `X__3`, collision-bumped against the set of ids
 * already present) — NEVER random/time-based. Because the sync plugin runs
 * identically on every collaborating client, a deterministic re-id is the only
 * way they can converge on the SAME ids; a random id (the previous
 * implementation) made two clients editing the same duplicate-id document mint
 * DIFFERENT ids for the same duplicate, causing permanent Yjs divergence.
 */
function resolveCollisions(scan: FootnoteScan): CollisionPlan {
  const definitions = new Map<string, ProseMirrorNode>();
  const refReids: Array<{
    pos: number;
    node: ProseMirrorNode;
    newId: string;
  }> = [];
  const referenceIds: string[] = [];
  const seenRefIds = new Set<string>();
  let changed = false;

  // `taken` is the set of every id that must be avoided when minting a derived
  // id: all original reference + definition ids in the document PLUS every id we
  // mint during this pass. It is pure document state, so the derivation stays
  // deterministic across clients. Per-original occurrence counters make the k-th
  // duplicate of `X` deterministically become `X__2`, `X__3`, ...
  const taken = new Set<string>();
  for (const occ of scan.refOccurrences) taken.add(occ.id);
  for (const occ of scan.defOccurrences) taken.add(occ.id);
  const occurrenceOf = new Map<string, number>();
  // Mint a deterministic unique id for a duplicate of `originalId`. The first
  // duplicate is occurrence 2 (the keeper is occurrence 1), then 3, 4, ...
  const mintId = (originalId: string): string => {
    const next = (occurrenceOf.get(originalId) ?? 1) + 1;
    occurrenceOf.set(originalId, next);
    const id = deriveFootnoteId(originalId, next, taken);
    taken.add(id);
    return id;
  };

  // Bucket definition occurrences by their original id so a duplicate reference
  // can claim a matching (as-yet-unclaimed) duplicate definition and re-id the
  // pair together. defByOriginalId[id] is consumed front-to-back.
  const defByOriginalId = new Map<string, DefOccurrence[]>();
  for (const occ of scan.defOccurrences) {
    const arr = defByOriginalId.get(occ.id);
    if (arr) arr.push(occ);
    else defByOriginalId.set(occ.id, [occ]);
  }
  // The FIRST definition for each id is the canonical keeper of that id.
  const claimed = new Set<DefOccurrence>();

  for (const ref of scan.refOccurrences) {
    if (!seenRefIds.has(ref.id)) {
      // First reference with this id keeps it.
      seenRefIds.add(ref.id);
      referenceIds.push(ref.id);
      continue;
    }
    // Duplicate reference: assign a deterministic derived id. Pair it with the
    // next unclaimed duplicate definition (NOT the first keeper) carrying the
    // same original id, if one exists, so the (ref, def) pairing is preserved
    // 1:1.
    const newId = mintId(ref.id);
    refReids.push({ pos: ref.pos, node: ref.node, newId });
    seenRefIds.add(newId);
    referenceIds.push(newId);
    changed = true;

    const candidates = defByOriginalId.get(ref.id) ?? [];
    // Skip the first occurrence (it keeps the original id); pick the first
    // duplicate not already claimed.
    for (let i = 1; i < candidates.length; i++) {
      const cand = candidates[i];
      if (!claimed.has(cand)) {
        claimed.add(cand);
        definitions.set(newId, cand.node);
        break;
      }
    }
  }

  // Now place every definition under a unique id. The first occurrence of each
  // original id keeps it; remaining duplicates either were paired with a
  // duplicate reference above (already placed) or get a fresh standalone id.
  const seenDefIds = new Set<string>();
  for (const occ of scan.defOccurrences) {
    if (claimed.has(occ)) continue; // already placed against a duplicate ref id
    if (!seenDefIds.has(occ.id)) {
      seenDefIds.add(occ.id);
      definitions.set(occ.id, occ.node);
    } else {
      // Duplicate definition with no duplicate reference to pair with: keep it
      // with a deterministic derived id so it is NEVER silently dropped. (It
      // becomes an orphan and is then subject to the normal orphan policy — but
      // only ever because it has no matching reference, never because it
      // collided.)
      const newId = mintId(occ.id);
      definitions.set(newId, occ.node);
      changed = true;
    }
  }

  return { referenceIds, definitions, refReids, changed };
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
 * Duplicate-id collisions (two references and/or two definitions sharing one
 * id — produced by importing `[^d]: a` / `[^d]: b`, or by pasting/duplicating a
 * reference+definition pair) are resolved up front by resolveCollisions(): the
 * duplicates are re-id'd to fresh unique ids so BOTH survive as distinct
 * footnotes. This guarantees the overriding invariant — no footnoteDefinition is
 * ever silently deleted by this automatic (addToHistory:false) transaction. A
 * definition is only ever removed when it has NO matching reference (orphan
 * policy), never because its id collided with another.
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

      // 0) Resolve duplicate-id collisions (two references and/or two
      //    definitions sharing one id) by re-id'ing duplicates to fresh unique
      //    ids. This is the critical defense: the old last-wins Map silently
      //    dropped all but the last definition for a shared id; here EVERY
      //    definition survives with a unique id, and duplicate references are
      //    paired with duplicate definitions so two same-id imports/pastes yield
      //    two distinct footnotes instead of one.
      const plan = resolveCollisions(info);
      const referenceIds = plan.referenceIds;

      // 1) Desired definitions: one per referenced id, in reference order,
      //    reusing existing definition nodes (preserving their content) and
      //    synthesizing empty ones for references that lack a definition.
      //    Definitions whose id has no matching reference (true orphans) are
      //    dropped per the existing orphan policy — but a collision is NEVER the
      //    cause of a drop, because collisions were re-id'd above.
      const desiredDefs: ProseMirrorNode[] = referenceIds.map((id) => {
        const existing = plan.definitions.get(id);
        if (existing) {
          // A definition paired to a re-id'd reference keeps its CONTENT but
          // must carry the new id. Rewrite the id attr when it differs (cheap
          // no-op when it already matches).
          if (existing.attrs.id !== id) {
            return defType.create({ id }, existing.content);
          }
          return existing;
        }
        return defType.create({ id }, paragraphType.create());
      });

      // 2) Determine whether the document already matches the desired end-state.
      const hasRefs = desiredDefs.length > 0;

      // Is the existing single list already exactly the desired list, placed
      // after all meaningful content (nothing but empty paragraphs after it)?
      const isEmptyParagraph = (node: ProseMirrorNode) =>
        node.type === paragraphType && node.content.size === 0;

      let alreadyCanonical = false;
      if (plan.changed) {
        // A collision was detected (duplicate ids among refs/defs). The doc must
        // be rewritten (re-id'd references + rebuilt list); it is never already
        // canonical in this case.
        alreadyCanonical = false;
      } else if (!hasRefs) {
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

      // 3a) Re-id colliding body references FIRST. A footnoteReference is an
      //     inline atom, so setNodeMarkup changes only its attrs (not its size),
      //     leaving every other position valid for the list deletions/insert
      //     that follow.
      for (const reid of plan.refReids) {
        tr.setNodeMarkup(reid.pos, undefined, {
          ...reid.node.attrs,
          id: reid.newId,
        });
      }

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

export const footnotePastePluginKey = new PluginKey("footnotePaste");

/**
 * Paste id-collision guard. When pasted content carries footnote reference or
 * definition ids that ALREADY EXIST in the current document, regenerate those
 * ids (consistently across the pasted slice, so a pasted reference and its
 * definition keep pointing at each other) BEFORE the slice is inserted.
 *
 * Without this, pasting a reference+definition pair copied from elsewhere — or
 * duplicating one in place — would merge with (or clobber) the existing footnote
 * of the same id. The schema-sync plugin already guarantees no definition is
 * ever silently deleted after the fact (it re-id's collisions), but regenerating
 * at paste time keeps the pasted footnote cleanly separate from the start and
 * avoids any transient merge.
 *
 * Only COLLIDING ids are remapped: a self-paste of a lone reference whose id is
 * not present elsewhere is left untouched (so it still resolves to its existing
 * definition).
 */
export function footnotePastePlugin(): Plugin {
  return new Plugin({
    key: footnotePastePluginKey,
    props: {
      transformPasted(slice, view) {
        // Collect ids already present in the current document.
        const existing = new Set<string>();
        view.state.doc.descendants((node) => {
          if (
            node.type.name === FOOTNOTE_REFERENCE_NAME ||
            node.type.name === FOOTNOTE_DEFINITION_NAME
          ) {
            const id = node.attrs.id;
            if (id) existing.add(id);
          }
        });
        if (existing.size === 0) return slice;

        // Build a remap (old id -> fresh id) for every COLLIDING id found in the
        // pasted slice, shared by references and definitions so a pasted pair
        // stays matched. A paste is a distinct local user action (not a
        // shared-state convergence point), so determinism is not strictly
        // required here — but we derive the new id deterministically anyway
        // (deriveFootnoteId against the current doc's id set) for consistency
        // with the sync/import paths and to keep Math.random off this code path.
        const remap = new Map<string, string>();
        const collectColliding = (node: ProseMirrorNode) => {
          if (
            node.type.name === FOOTNOTE_REFERENCE_NAME ||
            node.type.name === FOOTNOTE_DEFINITION_NAME
          ) {
            const id = node.attrs.id;
            if (id && existing.has(id) && !remap.has(id)) {
              const newId = deriveFootnoteId(id, 2, existing);
              remap.set(id, newId);
              // Reserve it so a second colliding id deriving to the same base
              // bumps instead of clashing.
              existing.add(newId);
            }
          }
          node.descendants(collectColliding);
        };
        slice.content.descendants(collectColliding);
        if (remap.size === 0) return slice;

        // Rewrite the colliding ids throughout the slice.
        const rewrite = (fragment: Fragment): Fragment => {
          const nodes: ProseMirrorNode[] = [];
          fragment.forEach((node) => {
            const isFootnote =
              node.type.name === FOOTNOTE_REFERENCE_NAME ||
              node.type.name === FOOTNOTE_DEFINITION_NAME;
            const newId = isFootnote ? remap.get(node.attrs.id) : undefined;
            const newContent = node.content.size
              ? rewrite(node.content)
              : node.content;
            if (newId) {
              nodes.push(
                node.type.create(
                  { ...node.attrs, id: newId },
                  newContent,
                  node.marks,
                ),
              );
            } else if (newContent !== node.content) {
              nodes.push(node.copy(newContent));
            } else {
              nodes.push(node);
            }
          });
          return Fragment.fromArray(nodes);
        };

        return new Slice(rewrite(slice.content), slice.openStart, slice.openEnd);
      },
    },
  });
}
