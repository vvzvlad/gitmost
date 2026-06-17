/**
 * Surgical text edits on a ProseMirror document without re-importing it.
 *
 * Each edit replaces an exact substring of a block's inline text, preserving
 * every node id, mark and attribute around it. Matching works at the
 * INLINE-CONTAINER (block) level: a block's text nodes are flattened into a
 * per-character array, so a `find` may freely cross bold/italic/link
 * boundaries (separate text nodes). The replacement inherits marks from the
 * unchanged common prefix/suffix of the match, so editing plain text next to a
 * bold word keeps the bold word bold, and editing the inside of a bold word
 * keeps the inserted text bold. This is the safe alternative to a full markdown
 * re-import for small wording fixes.
 */

import { stripInlineMarkdown } from "./text-normalize.js";

export interface TextEdit {
  find: string;
  replace: string;
  /** Replace every occurrence; otherwise the edit must match exactly once. */
  replaceAll?: boolean;
}

export interface TextEditResult {
  find: string;
  replacements: number;
  /** True when the match required the markdown-stripped fallback locator. */
  normalized?: boolean;
}

export interface TextEditFailure {
  find: string;
  reason: string;
}

/** One flattened inline slot: a single UTF-16 code unit, or an opaque atom. */
interface CharSlot {
  ch: string;
  marks: any[];
  /** Set for non-text inline nodes (hardBreak/mention/image/emoji/...). */
  atom?: any;
}

/** Placeholder code unit standing in for one opaque (non-text) inline node. */
const ATOM_PLACEHOLDER = "￼"; // OBJECT REPLACEMENT CHARACTER

/**
 * Find every VALID occurrence of `needle` in a block's flattened slots.
 *
 * A candidate occurrence at slot range [start, start+needle.length) is valid
 * ONLY IF none of the slots in that range are atoms (non-text inline nodes).
 * This makes atom matching collision-safe against the U+FFFC placeholder: an
 * atom slot can never be part of a match, while a real text node containing a
 * literal U+FFFC code unit still matches normally (its slot has no `.atom`).
 *
 * Overlapping candidates that touch an atom are skipped (not counted, not
 * spliced); the scan resumes one code unit past the rejected start so a valid
 * match that begins just after an atom is not missed.
 */
function findValidMatches(
  chars: CharSlot[],
  plain: string,
  needle: string,
): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  let idx = plain.indexOf(needle);
  while (idx !== -1) {
    const end = idx + needle.length;
    let hasAtom = false;
    for (let i = idx; i < end; i++) {
      if (chars[i] && chars[i].atom) {
        hasAtom = true;
        break;
      }
    }
    if (!hasAtom) {
      positions.push(idx);
      // Non-overlapping: skip past this match.
      idx = plain.indexOf(needle, end);
    } else {
      // This candidate crosses an atom: reject it and resume one unit later so
      // an overlapping valid match starting after the atom is still found.
      idx = plain.indexOf(needle, idx + 1);
    }
  }
  return positions;
}

/** Order-sensitive deep-equality of two marks arrays. */
function marksEqual(a: any[], b: any[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

/** A block is any node that DIRECTLY contains at least one inline text child. */
function isInlineBlock(node: any): boolean {
  return (
    Array.isArray(node?.content) &&
    node.content.some((child: any) => child && child.type === "text")
  );
}

/** Flatten a block's inline content into a per-code-unit slot array. */
function flattenBlock(node: any): CharSlot[] {
  const chars: CharSlot[] = [];
  for (const child of node.content || []) {
    if (child && child.type === "text" && typeof child.text === "string") {
      const marks = child.marks || [];
      // Iterate by UTF-16 code unit so indices align with String.indexOf.
      for (let i = 0; i < child.text.length; i++) {
        chars.push({ ch: child.text[i], marks });
      }
    } else {
      // Any non-text inline node becomes one opaque slot.
      chars.push({
        ch: ATOM_PLACEHOLDER,
        marks: (child && child.marks) || [],
        atom: child,
      });
    }
  }
  return chars;
}

/** Re-tokenize a slot array back into ProseMirror inline nodes. */
function tokenizeChars(chars: CharSlot[]): any[] {
  const out: any[] = [];
  let buffer = "";
  let bufferMarks: any[] | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const textNode: any = { type: "text", text: buffer };
    if (bufferMarks && bufferMarks.length > 0) textNode.marks = bufferMarks;
    out.push(textNode);
    buffer = "";
    bufferMarks = null;
  };

  for (const slot of chars) {
    if (slot.atom) {
      flush();
      out.push(slot.atom);
      continue;
    }
    if (bufferMarks !== null && !marksEqual(bufferMarks, slot.marks)) {
      flush();
    }
    if (bufferMarks === null) bufferMarks = slot.marks;
    buffer += slot.ch;
  }
  flush();
  return out;
}

/** Longest common prefix length of two strings. */
function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Longest common suffix length of two strings, capped so it can't overlap. */
function commonSuffixLen(a: string, b: string, cap: number): number {
  const max = Math.min(a.length, b.length, cap);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Apply one edit to one block's flattened slot array.
 *
 * The caller passes only VALID (atom-free) match positions (see
 * findValidMatches), so no match range can overlap an atom slot here.
 */
function applyEditToChars(
  chars: CharSlot[],
  edit: TextEdit,
  matchPositions: number[],
): { newChars: CharSlot[]; spliced: number } {
  // Pre-compute the diff slices once (find/replace are constant per edit).
  const p = commonPrefixLen(edit.find, edit.replace);
  const s = commonSuffixLen(
    edit.find,
    edit.replace,
    Math.min(edit.find.length, edit.replace.length) - p,
  );
  const insertText = edit.replace.slice(p, edit.replace.length - s);

  // Rebuild the slot array in a single left-to-right pass, splicing at each
  // match start. Offsets into `chars` stay valid because we copy through.
  const newChars: CharSlot[] = [];
  let cursor = 0;
  let spliced = 0;
  for (const mStart of matchPositions) {
    const mEnd = mStart + edit.find.length;
    const changedStart = mStart + p;
    const changedEnd = mEnd - s;

    // Copy through everything up to the changed region (incl. the prefix).
    for (; cursor < changedStart; cursor++) newChars.push(chars[cursor]);

    const removed = chars.slice(changedStart, changedEnd);

    // Choose the marks for the inserted characters.
    let chosenMarks: any[] = [];
    if (
      removed.length > 0 &&
      removed.every((r) => marksEqual(r.marks, removed[0].marks))
    ) {
      // Uniform removed region: inherit its marks directly.
      chosenMarks = removed[0].marks;
    } else {
      // Empty or non-uniform removed region: inherit from the nearest TEXT
      // neighbour, skipping atom slots (an atom carries marks that do not
      // belong on inserted text). Scan left first, then right; fall back to [].
      let inherited: any[] | null = null;
      for (let i = changedStart - 1; i >= 0; i--) {
        if (!chars[i].atom) {
          inherited = chars[i].marks;
          break;
        }
      }
      if (inherited === null) {
        for (let i = changedEnd; i < chars.length; i++) {
          if (!chars[i].atom) {
            inherited = chars[i].marks;
            break;
          }
        }
      }
      chosenMarks = inherited === null ? [] : inherited;
    }

    // Emit the inserted text (one slot per code unit).
    for (let i = 0; i < insertText.length; i++) {
      newChars.push({ ch: insertText[i], marks: chosenMarks });
    }

    // Skip the removed region.
    cursor = changedEnd;
    spliced++;
  }
  // Copy through the tail.
  for (; cursor < chars.length; cursor++) newChars.push(chars[cursor]);

  return { newChars, spliced };
}

/**
 * Apply text edits to a ProseMirror doc (operates on a deep copy, returns it).
 *
 * Returns { doc, results, failed }:
 *  - results: edits that applied (replacements >= 1).
 *  - failed:  edits that matched zero times, were ambiguous (multi-match
 *    without replaceAll), or whose changed region crosses a non-text inline
 *    node. These do NOT throw — they are recorded so the caller can surface an
 *    actionable message and still keep the edits that did apply.
 *
 * Edits apply IN ORDER to the same working copy, so a later edit can target
 * text produced by an earlier one. The input doc is never mutated. The only
 * thrown error is for invalid input (an empty `edit.find`).
 */
export function applyTextEdits(
  doc: any,
  edits: TextEdit[],
): { doc: any; results: TextEditResult[]; failed: TextEditFailure[] } {
  const copy = JSON.parse(JSON.stringify(doc));
  const results: TextEditResult[] = [];
  const failed: TextEditFailure[] = [];

  for (const edit of edits) {
    if (!edit.find) throw new Error("edit.find must be a non-empty string");

    // Gather every inline block in document order (recurse the whole tree so
    // nested containers — callouts, list items, table cells, blockquotes — are
    // all covered).
    const blocks: any[] = [];
    (function collect(node: any) {
      if (isInlineBlock(node)) blocks.push(node);
      for (const child of node.content || []) collect(child);
    })(copy);

    // Find every VALID (atom-free) occurrence per block. A candidate whose slot
    // range overlaps a non-text inline atom is never a match (collision-safe vs
    // the U+FFFC placeholder), so it is excluded from both the uniqueness count
    // and the splicing.
    const blockChars = blocks.map((b) => flattenBlock(b));
    const blockPlain = blockChars.map((chars) =>
      chars.map((c) => c.ch).join(""),
    );
    // EXACT MATCH WINS: try the verbatim locator first.
    let effectiveFind = edit.find;
    let normalized = false;
    let validPerBlock: number[][] = blockChars.map((chars, b) =>
      findValidMatches(chars, blockPlain[b], edit.find),
    );
    let total = 0;
    for (const positions of validPerBlock) total += positions.length;

    // FALLBACK: only if the verbatim locator matched nothing, retry with the
    // markdown-stripped form. `edit.replace` is never touched — this only
    // changes what we LOCATE, not what we insert.
    const stripped = stripInlineMarkdown(edit.find);
    if (total === 0 && stripped !== edit.find && stripped.length > 0) {
      const strippedPerBlock: number[][] = blockChars.map((chars, b) =>
        findValidMatches(chars, blockPlain[b], stripped),
      );
      let strippedTotal = 0;
      for (const positions of strippedPerBlock) strippedTotal += positions.length;
      if (strippedTotal >= 1) {
        validPerBlock = strippedPerBlock;
        total = strippedTotal;
        effectiveFind = stripped;
        normalized = true;
      }
    }

    if (total === 0) {
      // Distinguish "the text exists but only across an atom" from a plain
      // not-found: if a raw substring scan (atoms included) WOULD have hit —
      // for EITHER the verbatim or the stripped locator — the only thing
      // blocking the edit is the atom, so report that.
      const existsAcrossAtom = blockPlain.some(
        (plain) =>
          plain.indexOf(edit.find) !== -1 ||
          (stripped !== edit.find && plain.indexOf(stripped) !== -1),
      );
      let reason: string;
      if (existsAcrossAtom) {
        reason =
          "match crosses a non-text inline node (image/break/mention); use update_page_json for structural changes.";
      } else {
        // Append a bounded "closest text" hint: find the FIRST block that
        // contains the longest whitespace-delimited token (>= 3 chars) of the
        // (stripped, then raw) locator, and quote that block's plain text.
        reason = "text not found in the document.";
        const tokenSource = stripped.length > 0 ? stripped : edit.find;
        const longestToken = tokenSource
          .split(/\s+/)
          .filter((t) => t.length >= 3)
          .sort((a, b) => b.length - a.length)[0];
        if (longestToken) {
          const hitBlock = blockPlain.find((plain) =>
            plain.includes(longestToken),
          );
          if (hitBlock) {
            // Truncate by code point (spread iterates by code point) so a
            // surrogate pair is never split; append the ellipsis only when the
            // text was actually longer than the limit.
            const points = [...hitBlock];
            const snippet =
              points.length > 120
                ? points.slice(0, 120).join("") + "…"
                : hitBlock;
            reason += ` Closest block text: "${snippet}".`;
          }
        }
      }
      failed.push({ find: edit.find, reason });
      continue;
    }
    if (total > 1 && !edit.replaceAll) {
      failed.push({
        find: edit.find,
        reason: `matches ${total} times. Provide a longer, unique fragment or set replaceAll: true.`,
      });
      continue;
    }

    // Plan the splices from the valid positions. For a non-replaceAll edit we
    // splice only the first valid match (left-to-right across blocks); for
    // replaceAll we splice every valid match.
    const plannedPerBlock: number[][] = blockChars.map(() => []);
    let takenFirst = false;
    for (let b = 0; b < validPerBlock.length; b++) {
      for (const idx of validPerBlock[b]) {
        if (edit.replaceAll) {
          plannedPerBlock[b].push(idx);
        } else if (!takenFirst) {
          plannedPerBlock[b].push(idx);
          takenFirst = true;
          break;
        } else {
          break;
        }
      }
      if (!edit.replaceAll && takenFirst) break;
    }

    // Apply the splices block-by-block and re-tokenize changed blocks. The
    // local edit uses `effectiveFind` (verbatim or normalized) so the
    // prefix/suffix diff is computed against the ACTUALLY matched text, while
    // `edit.replace` stays literal — never stripped.
    const effectiveEdit: TextEdit = {
      find: effectiveFind,
      replace: edit.replace,
      replaceAll: edit.replaceAll,
    };
    let spliced = 0;
    for (let b = 0; b < blocks.length; b++) {
      if (plannedPerBlock[b].length === 0) continue;
      const { newChars, spliced: n } = applyEditToChars(
        blockChars[b],
        effectiveEdit,
        plannedPerBlock[b],
      );
      spliced += n;
      blocks[b].content = tokenizeChars(newChars);
    }

    // Keep `find: edit.find` (the original) so the caller can correlate.
    const result: TextEditResult = { find: edit.find, replacements: spliced };
    if (normalized) result.normalized = true;
    results.push(result);
  }

  // Safety net: drop any empty text nodes (ProseMirror forbids them). The
  // re-tokenizer never emits empty text nodes, but untouched blocks could in
  // principle carry one in from upstream.
  (function prune(node: any) {
    if (Array.isArray(node.content)) {
      node.content = node.content.filter(
        (child: any) => !(child.type === "text" && child.text === ""),
      );
      for (const child of node.content) prune(child);
    }
  })(copy);

  return { doc: copy, results, failed };
}
