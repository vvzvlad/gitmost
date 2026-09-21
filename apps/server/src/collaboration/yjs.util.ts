import {
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { Document } from '@hocuspocus/server';
import { getSchema } from '@tiptap/core';
import { tiptapExtensions } from './collaboration.util';

export type YjsSelection = {
  anchor: any;
  head: any;
};

export function setYjsMark(
  doc: Document,
  fragment: Y.XmlFragment,
  yjsSelection: YjsSelection,
  markName: string,
  markAttributes: Record<string, any>,
) {
  const schema = getSchema(tiptapExtensions);
  const { mapping } = initProseMirrorDoc(fragment, schema);

  // Convert JSON positions to Y.js RelativePosition objects
  const anchorRelPos = Y.createRelativePositionFromJSON(yjsSelection.anchor);
  const headRelPos = Y.createRelativePositionFromJSON(yjsSelection.head);

  const anchor = relativePositionToAbsolutePosition(
    doc,
    fragment,
    anchorRelPos,
    mapping,
  );
  const head = relativePositionToAbsolutePosition(
    doc,
    fragment,
    headRelPos,
    mapping,
  );

  if (anchor === null || head === null) {
    throw new Error(
      'Could not resolve Y.js relative positions to absolute positions',
    );
  }

  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);

  // Apply mark directly to Y.js XmlText nodes
  // This bypasses updateYFragment which has compatibility issues
  applyMarkToYFragment(fragment, from, to, markName, markAttributes);
}

function applyMarkToYFragment(
  fragment: Y.XmlFragment,
  from: number,
  to: number,
  markName: string,
  markAttributes: Record<string, any>,
) {
  let pos = 0;

  const processItem = (item: any, parentNodeName?: string): boolean => {
    if (pos >= to) return false;

    if (item instanceof Y.XmlText) {
      const textLength = item.length;
      const itemEnd = pos + textLength;

      if (itemEnd > from && pos < to && parentNodeName !== 'codeBlock') {
        const formatFrom = Math.max(0, from - pos);
        const formatTo = Math.min(textLength, to - pos);
        const formatLength = formatTo - formatFrom;

        if (formatLength > 0) {
          item.format(formatFrom, formatLength, { [markName]: markAttributes });
        }
      }
      pos = itemEnd;
    } else if (item instanceof Y.XmlElement) {
      pos++; // Opening tag
      for (let i = 0; i < item.length; i++) {
        if (!processItem(item.get(i), item.nodeName)) return false;
      }
      pos++; // Closing tag
    }
    return true;
  };

  for (let i = 0; i < fragment.length; i++) {
    if (!processItem(fragment.get(i))) break;
  }
}

/**
 * Removes a mark from all text in the fragment that has the specified attribute value.
 * Useful for deleting comments by commentId.
 */
export function removeYjsMarkByAttribute(
  fragment: Y.XmlFragment,
  markName: string,
  attributeName: string,
  attributeValue: string,
) {
  const processItem = (item: any) => {
    if (item instanceof Y.XmlText) {
      // Get all formatting deltas to find ranges with this mark
      const deltas = item.toDelta();
      let offset = 0;

      for (const delta of deltas) {
        const length = delta.insert?.length ?? 0;
        const attributes = delta.attributes ?? {};
        const markAttr = attributes[markName];

        if (markAttr && markAttr[attributeName] === attributeValue) {
          // Remove the mark by setting it to null
          item.format(offset, length, { [markName]: null });
        }
        offset += length;
      }
    } else if (item instanceof Y.XmlElement) {
      for (let i = 0; i < item.length; i++) {
        processItem(item.get(i));
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    processItem(fragment.get(i));
  }
}

/**
 * A single marked delta segment collected during the walk, together with the
 * Y.XmlText node that owns it, the segment's start offset within that node,
 * and the full `comment` mark attributes object (needed to re-attach the mark
 * to the replacement text).
 */
type MarkedSegment = {
  node: Y.XmlText;
  offset: number;
  length: number;
  text: string;
  markAttrs: Record<string, any>;
  // The FULL attribute set of this delta run — the `comment` mark plus any
  // inline formatting (bold/italic/code/link/…). Captured so apply can carry the
  // original run's formatting onto the replacement instead of dropping it.
  attributes: Record<string, any>;
};

/**
 * Atomically check-and-replace the text currently under a comment mark.
 *
 * Walks the fragment collecting every delta segment whose `comment` mark has the
 * given commentId. The replacement is applied ONLY if the marked run is intact:
 * it lives in a single Y.XmlText node, is contiguous (no unmarked text spliced
 * into the middle), and its joined text still equals `expectedText`. On success
 * the run is deleted and `newText` is inserted at the same offset carrying the
 * SAME comment attributes, so the comment thread stays anchored to the new text.
 *
 * This mutates the passed fragment/text directly and does NOT open its own Y
 * transaction — the caller is expected to wrap the call in connection.transact()
 * so the delete+insert are atomic (mirrors updateYjsMarkAttribute's direct
 * mutation style).
 *
 * @returns `{ applied: true, currentText: newText }` on replacement, otherwise
 * `{ applied: false, currentText }` where currentText is the text currently
 * under the mark (or null when the mark/anchor no longer exists).
 */
export function replaceYjsMarkedText(
  fragment: Y.XmlFragment,
  commentId: string,
  expectedText: string,
  newText: string,
): { applied: boolean; currentText: string | null } {
  // 1. Collect every marked segment in document order.
  const segments: MarkedSegment[] = [];

  const processItem = (item: any) => {
    if (item instanceof Y.XmlText) {
      const deltas = item.toDelta();
      let offset = 0;

      for (const delta of deltas) {
        const insert = delta.insert;
        // Non-string inserts (embeds) carry no text length we can splice on.
        if (typeof insert !== 'string') {
          // A Yjs embed occupies one unit in the index space used by delete/
          // insert/format — advance offset so a marked segment after an embed
          // gets the right position (and an embed inside a marked run creates a
          // gap → the contiguity guard rejects it as a changed anchor).
          offset += 1;
          continue;
        }
        const length = insert.length;
        const attributes = delta.attributes ?? {};
        const markAttr = attributes['comment'];

        if (markAttr && markAttr.commentId === commentId) {
          segments.push({
            node: item,
            offset,
            length,
            text: insert,
            markAttrs: markAttr,
            attributes,
          });
        }
        offset += length;
      }
    } else if (item instanceof Y.XmlElement) {
      for (let i = 0; i < item.length; i++) {
        processItem(item.get(i));
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    processItem(fragment.get(i));
  }

  const joinedText = segments.map((s) => s.text).join('');

  // 2a. No segments — the mark/anchor was deleted.
  if (segments.length === 0) {
    return { applied: false, currentText: null };
  }

  // 2b. Segments span more than one Y.XmlText node (paragraph split by Enter,
  // or the mark bled across blocks) — treat as changed.
  const node = segments[0].node;
  const sameNode = segments.every((s) => s.node === node);
  if (!sameNode) {
    return { applied: false, currentText: joinedText };
  }

  // 2c. Non-contiguous within the single node: unmarked text is spliced between
  // the first and last marked segment. Since collected segments are in document
  // order, contiguity holds iff each segment starts where the previous ended.
  let contiguous = true;
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].offset !== segments[i - 1].offset + segments[i - 1].length) {
      contiguous = false;
      break;
    }
  }
  if (!contiguous) {
    return { applied: false, currentText: joinedText };
  }

  // 2d. The text under the mark changed.
  if (joinedText !== expectedText) {
    return { applied: false, currentText: joinedText };
  }

  // 3. All guards passed: delete the marked run and re-insert newText at the
  // same offset. Atomic within the caller's transaction.
  const start = segments[0].offset;
  const len = segments.reduce((sum, s) => sum + s.length, 0);

  // Carry the ORIGINAL run's formatting onto the replacement (#496): inserting
  // with only the `comment` mark silently dropped bold/italic/code/link of the
  // replaced text. Yjs applies one flat attribute set to the whole insert, so
  // when the marked run mixes formatting we pick the DOMINANT segment (the one
  // covering the most characters) and apply its attributes — a v1 that preserves
  // the common single-format case exactly and, for a mixed run, keeps the
  // prevailing style rather than losing all of it. `attributes` already carries
  // the `comment` mark (every collected segment is filtered on it above), so the
  // anchor is preserved by copying the run's attribute set verbatim.
  const dominant = segments.reduce((a, b) => (b.length > a.length ? b : a));
  const insertAttrs = { ...dominant.attributes };

  node.delete(start, len);
  node.insert(start, newText, insertAttrs);

  return { applied: true, currentText: newText };
}

/**
 * Updates a mark's attributes for all text that has the specified attribute value.
 * Useful for resolving/unresolving comments by commentId.
 */
export function updateYjsMarkAttribute(
  fragment: Y.XmlFragment,
  markName: string,
  findByAttribute: { name: string; value: string },
  newAttributes: Record<string, any>,
) {
  const processItem = (item: any) => {
    if (item instanceof Y.XmlText) {
      const deltas = item.toDelta();
      let offset = 0;

      for (const delta of deltas) {
        const length = delta.insert?.length ?? 0;
        const attributes = delta.attributes ?? {};
        const markAttr = attributes[markName];

        if (
          markAttr &&
          markAttr[findByAttribute.name] === findByAttribute.value
        ) {
          // Update the mark with new attributes (merge with existing)
          item.format(offset, length, {
            [markName]: { ...markAttr, ...newAttributes },
          });
        }
        offset += length;
      }
    } else if (item instanceof Y.XmlElement) {
      for (let i = 0; i < item.length; i++) {
        processItem(item.get(i));
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    processItem(fragment.get(i));
  }
}
