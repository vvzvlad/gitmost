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

import {
  stripInlineMarkdown,
  stripBalancedWrappers,
  closestBlockHint,
  foldInvisibles,
  foldTypography,
  escapeInvisibles,
  isFoldDelete,
  isFoldSpace,
} from "./text-normalize.js";

/** Which locator tier localized an edit (additive result field, #658). */
export type MatchedVia =
  | "exact"
  | "markdown"
  | "fold"
  | "markdown+fold"
  | "exact+fold";

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
  /**
   * Which locator tier localized this edit (#658). Additive/observability only:
   * `"exact"`/`"markdown"`/`"fold"`/`"markdown+fold"` for a single-tier match,
   * `"exact"`/`"fold"`/`"exact+fold"` for a merged replaceAll plan.
   */
  matchedVia?: MatchedVia;
  /**
   * Set when an edit applied via the literal-marker exception while ALSO being a
   * formatting toggle (strip-sides equal): the `find` matched LITERAL markers
   * present verbatim in the text, so it was allowed, but the caller may have
   * intended to change real formatting and hit the wrong target. Observable and
   * self-correcting; blocks nothing.
   */
  warning?: string;
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
 * True when `s` contains at least one BALANCED inline-markdown marker PAIR (or a
 * link/image) — markup that editPageText would write as LITERAL visible text.
 *
 * Two roles:
 *  - in a `replace`, it flags smuggled formatting markers (refuse), and
 *  - in a `find` matched VERBATIM (not markdown-stripped), it proves the LITERAL
 *    markers already exist in the document — the literal-exception that lets a
 *    cleanup edit (`**bold**` -> `bold`) through.
 *
 * Detected: `**bold**`, `__bold__`, `~~strike~~`, `` `code` ``, and
 * `[text](url)` / `![alt](src)` links/images. Single `*`/`_` runs are
 * DELIBERATELY NOT detected: `my_var_name` (`_var_` is balanced), `2 * 3 * 4`,
 * and a lone `*x*` italic wrapper would all false-positive; a lone italic added
 * to a `replace` is still caught by the symmetric formattingOnly toggle. A
 * dunder identifier (`__init__`) is an ACCEPTED false positive — refusing beats
 * silent corruption, and the reason offers a patchNode-with-node-JSON hatch.
 * A code-like `arr[i](x)` / `callbacks[0](evt)` string is the same ACCEPTED false
 * positive against the link pattern: refused with the same content hatch.
 */
/**
 * Linear-time detector for a markdown `[text](url)` / `![alt](src)` link/image,
 * equivalent (as a boolean) to `/!?\[[^\]]*\]\([^)]*\)/`. Written as a single
 * left-to-right pass instead of a regex because the regex is O(n^2) on a long
 * run of unmatched `[` (each `[` restarts the `[^\]]*` scan) — an agent-supplied
 * `replace` of `"[".repeat(100000)` would synchronously block the MCP server's
 * event loop for seconds (#657 review). A four-phase state machine can't
 * backtrack, so it is O(n) on every input.
 */
function hasMarkdownLinkPattern(s: string): boolean {
  // phase 0: seeking '['; 1: seeking ']' (after '['); 2: expecting '(' right
  // after ']'; 3: seeking ')'. Phase 1 accepts any char except ']' (mirrors
  // `[^\]]*`, which allows a nested '['); phase 3 accepts any char except ')'.
  let phase = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (phase === 0) {
      if (c === "[") phase = 1;
    } else if (phase === 1) {
      if (c === "]") phase = 2;
    } else if (phase === 2) {
      if (c === "(") phase = 3;
      else phase = c === "[" ? 1 : 0; // `]` not followed by `(` — restart
    } else {
      if (c === ")") return true;
    }
  }
  return false;
}

function containsLiteralMarkerPairs(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  return (
    /\*\*[^*]+\*\*/.test(s) ||
    /__[^_]+__/.test(s) ||
    /~~[^~]+~~/.test(s) ||
    /`[^`]+`/.test(s) ||
    hasMarkdownLinkPattern(s)
  );
}

/**
 * A single planned splice on one block's slot array: replace slots
 * [changedStart, changedEnd) with `insertText`. Both bounds are SLOT indices
 * (into the block's flattened `chars`); the diff that produced them is per-tier
 * (raw for exact/markdown, folded-space for fold), see computeSplice.
 */
interface Splice {
  changedStart: number;
  changedEnd: number;
  insertText: string;
}

/**
 * Apply a set of pre-computed, disjoint splices to one block's flattened slot
 * array (sorted by changedStart). Mark inheritance over each changed region is
 * the historic uniform-region / nearest-text-neighbour logic (#658 keeps it: the
 * per-tier diff only changes WHICH slots are the changed region, not how the
 * inserted text inherits marks). The caller guarantees changed regions are
 * atom-free (valid match ranges).
 */
function applySplices(
  chars: CharSlot[],
  splices: Splice[],
): { newChars: CharSlot[]; spliced: number } {
  const newChars: CharSlot[] = [];
  let cursor = 0;
  let spliced = 0;
  for (const sp of splices) {
    // Copy through everything up to the changed region (incl. the prefix).
    for (; cursor < sp.changedStart; cursor++) newChars.push(chars[cursor]);

    const removed = chars.slice(sp.changedStart, sp.changedEnd);

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
      for (let i = sp.changedStart - 1; i >= 0; i--) {
        if (!chars[i].atom) {
          inherited = chars[i].marks;
          break;
        }
      }
      if (inherited === null) {
        for (let i = sp.changedEnd; i < chars.length; i++) {
          if (!chars[i].atom) {
            inherited = chars[i].marks;
            break;
          }
        }
      }
      chosenMarks = inherited === null ? [] : inherited;
    }

    // Emit the inserted text (one slot per code unit).
    for (let i = 0; i < sp.insertText.length; i++) {
      newChars.push({ ch: sp.insertText[i], marks: chosenMarks });
    }

    // Skip the removed region.
    cursor = sp.changedEnd;
    spliced++;
  }
  // Copy through the tail.
  for (; cursor < chars.length; cursor++) newChars.push(chars[cursor]);

  return { newChars, spliced };
}

/** Fold-haystack info for one block: the folded plain + slot map (#658). */
interface FoldInfo {
  folded: string;
  map: number[];
}

/** A localized candidate occurrence: a slot range plus (for fold tiers) the
 *  fold-haystack index where the match started (needed for the folded diff). */
interface Cand {
  startSlot: number;
  endSlot: number;
  /** Fold-haystack start index; undefined for raw (exact/markdown) tiers. */
  foldIndex?: number;
}

/** Whether a candidate tier localizes in FOLDED space (vs raw plain). */
function isFoldTier(tier: MatchedVia): boolean {
  return tier === "fold" || tier === "markdown+fold" || tier === "exact+fold";
}

/**
 * True when `s` carries a fold-SENSITIVE invisible: a char the fold erases
 * (isFoldDelete) or collapses away (a non-space fold-space, e.g. NBSP). A plain
 * space is fold-space too but survives the fold, so it does NOT count (#658 F2).
 */
function hasFoldSensitiveInvisible(s: string): boolean {
  for (const c of s) {
    if (isFoldDelete(c) || (isFoldSpace(c) && c !== " ")) return true;
  }
  return false;
}

/**
 * Scan a block's FOLDED haystack for `needle`, mapping each atom-free match to a
 * slot range starting at `map[i]` and ending at the exclusive end of the LAST
 * matched folded char's own extent (a copied char spans one slot; a collapsed
 * whitespace run spans the whole run — a plain `map[i+L-1]+1` would leave the
 * run's tail behind, see the endSlot computation) plus its fold index. `overlapping`
 * resumes one folded char past a valid match (for the replaceAll merge scan);
 * otherwise it resumes past the whole match (non-overlapping). A candidate whose
 * slot range touches an atom slot is skipped (range validity by slots, #658).
 */
function findValidFoldMatches(
  chars: CharSlot[],
  fold: FoldInfo,
  needle: string,
  overlapping: boolean,
): Cand[] {
  const out: Cand[] = [];
  if (!needle) return out;
  const { folded, map } = fold;
  const L = needle.length;
  let idx = folded.indexOf(needle);
  while (idx !== -1) {
    const startSlot = map[idx];
    // Exclusive end = the end of the LAST matched folded char's own extent.
    // `map[idx+L-1]+1` is right for a copied char but lands INSIDE a collapsed
    // multi-char whitespace run (e.g. two NBSPs -> one space), leaving the run's
    // tail behind; `map[idx+L]` (next folded char) overshoots when a standalone
    // DELETE char (a SHY between two visible chars) sits in the gap, so an append
    // would jump PAST that invisible. So: if the last matched folded char is a
    // whitespace run, extend through its fold-space/delete chars; else +1 (#658 F1).
    const lastSlot = map[idx + L - 1];
    let endSlot = lastSlot + 1;
    if (isFoldSpace(chars[lastSlot].ch)) {
      while (
        endSlot < chars.length &&
        (isFoldSpace(chars[endSlot].ch) || isFoldDelete(chars[endSlot].ch))
      ) {
        endSlot++;
      }
    }
    let hasAtom = false;
    for (let s = startSlot; s < endSlot; s++) {
      if (chars[s] && chars[s].atom) {
        hasAtom = true;
        break;
      }
    }
    if (!hasAtom) {
      out.push({ startSlot, endSlot, foldIndex: idx });
      idx = folded.indexOf(needle, overlapping ? idx + 1 : idx + L);
    } else {
      // Range crosses an atom: reject and resume one folded char later.
      idx = folded.indexOf(needle, idx + 1);
    }
  }
  return out;
}

/**
 * Compute the splice (changed slot range + literal insert text) for one matched
 * candidate. PER-TIER: exact/markdown tiers diff both sides RAW (the historic
 * path — never fold `replace`); fold tiers diff prefix/suffix in FOLDED space
 * and map the boundaries back through the haystack/replace maps, so invisibles
 * in the unchanged part are preserved and a collapsed run is atomic (#658 §3).
 */
function computeSplice(
  cand: Cand,
  tier: MatchedVia,
  needleText: string,
  foldNeedle: string,
  replace: string,
  fold: FoldInfo,
): Splice {
  if (!isFoldTier(tier) || cand.foldIndex === undefined) {
    // RAW diff (exact/markdown tiers): both sides raw — the historic path. Never
    // fold `replace` here, or edits of the invisibles THEMSELVES would die
    // (insert `{find:"5 шт",replace:"5·шт"}`, SHY removal `{find:"люд­ях",…}`).
    const p = commonPrefixLen(needleText, replace);
    const s = commonSuffixLen(
      needleText,
      replace,
      Math.min(needleText.length, replace.length) - p,
    );
    return {
      changedStart: cand.startSlot + p,
      changedEnd: cand.startSlot + needleText.length - s,
      insertText: replace.slice(p, replace.length - s),
    };
  }
  // FOLDED-space diff (fold tiers): the matched original width varies per
  // occurrence, so the prefix/suffix boundary is computed in folded space and
  // mapped back through the haystack/replace maps. Invisible chars in the
  // UNCHANGED part are preserved (they come from the document, not `replace`).
  const i = cand.foldIndex;
  const hayMap = fold.map;
  const fh = foldNeedle;
  const L = fh.length;
  const fr = foldInvisibles(replace);
  const frFolded = fr.folded;
  const Lr = frFolded.length;
  const replMap = fr.map;
  const p = commonPrefixLen(fh, frFolded);
  const s = commonSuffixLen(fh, frFolded, Math.min(L, Lr) - p);
  const changedStart = p < L ? hayMap[i + p] : cand.endSlot;
  const suffixStart = s > 0 ? hayMap[i + L - s] : cand.endSlot;
  const insertStart = p < Lr ? replMap[p] : replace.length;
  const insertEnd = s > 0 ? replMap[Lr - s] : replace.length;
  return {
    changedStart,
    changedEnd: suffixStart,
    insertText: replace.slice(insertStart, insertEnd),
  };
}

/** True when two slot ranges [aStart,aEnd) and [bStart,bEnd) overlap. */
function rangesOverlap(a: Cand, b: Cand): boolean {
  return a.startSlot < b.endSlot && b.startSlot < a.endSlot;
}

/** A planned occurrence carrying the tier that localized it (merged plans mix
 *  tiers, so the diff for each range must use its OWN tier's needle). */
interface PlannedCand extends Cand {
  tier: MatchedVia;
}

/**
 * Diagnose a total miss (no tier localized `find`). First matching rule wins;
 * document quotes escape invisibles. MESSAGE DISCIPLINE (#658/#657/#647): NO
 * reason may suggest a full-page tool (updatePageJson / updatePageMarkdown);
 * `patchNode <id>` is offered ONLY when the enclosing top-level block has a real
 * attrs.id (patchNode rejects `#idx`).
 */
function diagnoseMiss(
  blockChars: CharSlot[][],
  blockPlain: string[],
  blockFold: FoldInfo[],
  blockTopIndex: number[],
  blockTopNode: any[],
  find: string,
  stripped: string,
  foldFind: string,
  foldStripped: string,
): string {
  const hasStripped = stripped !== find && stripped.length > 0;

  // 1) ATOM CROSSING. Two haystack variants per block: (a) raw plain with U+FFFC
  //    (keeps the "literal U+FFFC in find" pinned case), and (b) atom-slot -> ' '
  //    BEFORE fold (so a space adjacent to a hardBreak folds into the run and the
  //    "space before break" case is detected instead of a false not-found).
  for (let b = 0; b < blockChars.length; b++) {
    // Rule 1 diagnoses an ATOM crossing only. A block with no atom that still
    // "hits" here would have been matched by the exact/fold tiers (so we'd never
    // reach diagnoseMiss) — EXCEPT when the fold tier was suppressed for a
    // fold-sensitive invisible in `replace` (#658 F2); in that case the honest
    // reason is the invisible/typography diff (rule 3), never a phantom break.
    if (!blockChars[b].some((c) => c.atom)) continue;
    const raw = blockPlain[b];
    const rawHit =
      raw.indexOf(find) !== -1 || (hasStripped && raw.indexOf(stripped) !== -1);
    let foldHit = false;
    if (foldFind.length > 0 || foldStripped.length > 0) {
      const spaced = blockChars[b].map((c) => (c.atom ? " " : c.ch)).join("");
      const spacedFold = foldInvisibles(spaced).folded;
      foldHit =
        (foldFind.length > 0 && spacedFold.indexOf(foldFind) !== -1) ||
        (foldStripped.length > 0 && spacedFold.indexOf(foldStripped) !== -1);
    }
    if (rawHit || foldHit) {
      const top = blockTopNode[b];
      const realId =
        top && top.attrs && typeof top.attrs.id === "string" && top.attrs.id.length > 0
          ? top.attrs.id
          : null;
      const hatch = realId
        ? ` To edit across it, use patchNode ${realId} on that block.`
        : " Split the edit so neither side crosses that boundary (or use the table tools for table cells).";
      return (
        "match crosses a line break or a non-text inline node (hardBreak, mention, image); " +
        "the change region cannot span that boundary." +
        hatch
      );
    }
  }

  // 2) BLOCK CROSSING. Join blocks' folded plain with a single space (document
  //    order, remembering each segment's offsets) and report when the folded
  //    needle straddles a boundary. i/j are TOP-LEVEL indices of the enclosing
  //    blocks (nested inline containers report their top-level ancestor's index).
  {
    let joined = "";
    const segStart: number[] = [];
    const segEnd: number[] = [];
    for (let b = 0; b < blockFold.length; b++) {
      if (b > 0) joined += " ";
      segStart[b] = joined.length;
      joined += blockFold[b].folded;
      segEnd[b] = joined.length;
    }
    const needles = [foldFind, foldStripped].filter((x) => x.length > 0);
    for (const nd of needles) {
      const pos = joined.indexOf(nd);
      if (pos === -1) continue;
      const end = pos + nd.length;
      const hitBlocks: number[] = [];
      for (let b = 0; b < blockFold.length; b++) {
        if (segStart[b] < end && pos < segEnd[b]) hitBlocks.push(b);
      }
      const tops = Array.from(new Set(hitBlocks.map((b) => blockTopIndex[b])));
      if (tops.length >= 2) {
        const i = Math.min(...tops);
        const j = Math.max(...tops);
        return `find crosses block boundaries #${i}-#${j}; split it into per-block edits.`;
      }
    }
  }

  // 3) TYPOGRAPHY ONLY. A block's typography-folded plain contains the needle's
  //    typography-fold, so the ONLY difference is quotes/dashes/spaces. Diagnose
  //    (with the exact document fragment, invisibles escaped) — never auto-apply
  //    a typographic fold (it would silently rewrite wiki typography).
  {
    const ftFind = foldTypography(find).folded;
    const ftStripped = hasStripped ? foldTypography(stripped).folded : "";
    const needles = [ftFind, ftStripped].filter((x) => x.length > 0);
    for (let b = 0; b < blockPlain.length; b++) {
      const ft = foldTypography(blockPlain[b]);
      for (const nd of needles) {
        const idx = ft.folded.indexOf(nd);
        if (idx === -1) continue;
        const rawStart = ft.map[idx];
        const rawEnd = ft.map[idx + nd.length - 1] + 1;
        const fragment = blockPlain[b].slice(rawStart, rawEnd);
        return (
          "differs only in typography (quotes/dashes/spaces); document text: \"" +
          escapeInvisibles(fragment) +
          "\". Copy the exact characters into find."
        );
      }
    }
  }

  // 4) CLOSEST HINT (escaped so invisible mismatches are visible).
  return "text not found in the document." + closestBlockHint(blockPlain, find, true);
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

    // HARD-REFUSE inline footnote tokens (#410). `^[...]` in a `replace` is
    // markdown that only becomes a real footnote when a whole markdown body is
    // written (createPage / update_page_content / importPageMarkdown). Written
    // through editPageText it stays a LITERAL string in the text — the exact
    // failure mode #410 fixes — so refuse it here (defense-in-depth) and point the
    // caller at insertFootnote, mirroring the formatting-marker refusal above.
    if (/\^\[[\s\S]*?\]/.test(edit.replace)) {
      failed.push({
        find: edit.find,
        reason:
          "editPageText writes the replacement as LITERAL text, so a `^[...]` footnote token does not parse into a real footnote (it would appear verbatim in the page). To add a footnote to existing text, use insertFootnote (anchorText = where, text = the note).",
      });
      continue;
    }

    // Gather every inline block in document order (recurse the whole tree so
    // nested containers — callouts, list items, table cells, blockquotes — are
    // all covered), remembering each block's TOP-LEVEL index/node so miss
    // diagnostics can address a real block id / index.
    const blocks: any[] = [];
    const blockTopIndex: number[] = [];
    const blockTopNode: any[] = [];
    const topContent: any[] = Array.isArray(copy.content) ? copy.content : [];
    topContent.forEach((top: any, ti: number) => {
      (function collect(node: any) {
        if (isInlineBlock(node)) {
          blocks.push(node);
          blockTopIndex.push(ti);
          blockTopNode.push(top);
        }
        for (const child of node.content || []) collect(child);
      })(top);
    });

    const blockChars = blocks.map((b) => flattenBlock(b));
    const blockPlain = blockChars.map((chars) =>
      chars.map((c) => c.ch).join(""),
    );
    // Fold each block's plain once (atoms stay U+FFFC in the folded haystack).
    const blockFold: FoldInfo[] = blockPlain.map((p) => foldInvisibles(p));

    // Tier needles. `stripped` is the markdown-stripped locator; `foldFind` /
    // `foldStrippedFull` are the invisible-folded locators. The fold GUARD skips
    // fold tiers when the folded needle is empty or trims to empty (a
    // whitespace-only needle would otherwise match every space in the document).
    const stripped = stripInlineMarkdown(edit.find);
    const hasStripped = stripped !== edit.find && stripped.length > 0;
    const foldFind = foldInvisibles(edit.find).folded;
    // Suppress the fold tiers when `replace` carries a fold-sensitive invisible:
    // the fold diff runs in a space where those invisibles are ERASED, so it
    // cannot faithfully apply a `replace` whose only difference from the matched
    // span is such an invisible (it would diff to an empty insert — a silent
    // no-op reported as replacements:1). Let only the exact/markdown (raw-diff)
    // tiers anchor it; if they miss, the honest result is replacements:0 (#658 F2).
    const replaceHasFoldSensitiveInvisible = hasFoldSensitiveInvisible(edit.replace);
    const foldEnabled = !replaceHasFoldSensitiveInvisible;
    const foldFindOk =
      foldEnabled && foldFind.length > 0 && foldFind.trim().length > 0;
    const foldStrippedFull = hasStripped ? foldInvisibles(stripped).folded : "";
    const foldStrippedOk =
      foldEnabled &&
      hasStripped &&
      foldStrippedFull.length > 0 &&
      foldStrippedFull.trim().length > 0;

    // Candidate builders per tier.
    const rawCands = (needle: string): Cand[][] =>
      blockChars.map((chars, b) =>
        findValidMatches(chars, blockPlain[b], needle).map((pos) => ({
          startSlot: pos,
          endSlot: pos + needle.length,
        })),
      );
    const foldCandsFor = (needle: string, overlapping: boolean): Cand[][] =>
      blockChars.map((chars, b) =>
        findValidFoldMatches(chars, blockFold[b], needle, overlapping),
      );
    const sumCands = (per: Cand[][]): number =>
      per.reduce((n, a) => n + a.length, 0);

    let matchedVia: MatchedVia | null = null;
    let normalized = false;
    let plannedPerBlock: PlannedCand[][] = blockChars.map(() => []);
    let total = 0;

    if (edit.replaceAll) {
      // MERGE PLAN exact ∪ fold: exact hits (non-overlapping raw scan) are ALL
      // included; fold candidates (OVERLAPPING folded scan) are added greedily
      // L->R, dropping any whose slot range overlaps a taken range. This avoids
      // silently under-replacing fold-equivalent occurrences vs searchInPage's
      // count, without double-splicing one physical occurrence.
      const exactPer = rawCands(edit.find);
      const foldPer = foldFindOk
        ? foldCandsFor(foldFind, true)
        : blockChars.map(() => [] as Cand[]);
      let anyExact = false;
      let anyFold = false;
      let mergedTotal = 0;
      const merged: PlannedCand[][] = blockChars.map(() => []);
      for (let b = 0; b < blockChars.length; b++) {
        const taken: Cand[] = [];
        for (const ec of exactPer[b]) {
          taken.push(ec);
          merged[b].push({ ...ec, tier: "exact" });
          anyExact = true;
        }
        for (const fc of foldPer[b]) {
          if (taken.some((t) => rangesOverlap(t, fc))) continue;
          taken.push(fc);
          merged[b].push({ ...fc, tier: "fold" });
          anyFold = true;
        }
        merged[b].sort((a, c) => a.startSlot - c.startSlot);
        mergedTotal += merged[b].length;
      }
      if (mergedTotal > 0) {
        plannedPerBlock = merged;
        total = mergedTotal;
        matchedVia =
          anyExact && anyFold ? "exact+fold" : anyExact ? "exact" : "fold";
      } else if (hasStripped) {
        // md-strip stays CASCADIC ("other text", not "same modulo invisibles").
        const mdPer = rawCands(stripped);
        const mdTotal = sumCands(mdPer);
        if (mdTotal > 0) {
          plannedPerBlock = mdPer.map((a) =>
            a.map((c) => ({ ...c, tier: "markdown" as MatchedVia })),
          );
          total = mdTotal;
          matchedVia = "markdown";
          normalized = true;
        } else if (foldStrippedOk) {
          const mfPer = foldCandsFor(foldStrippedFull, false);
          const mfTotal = sumCands(mfPer);
          if (mfTotal > 0) {
            plannedPerBlock = mfPer.map((a) =>
              a.map((c) => ({ ...c, tier: "markdown+fold" as MatchedVia })),
            );
            total = mfTotal;
            matchedVia = "markdown+fold";
            normalized = true;
          }
        }
      }
    } else {
      // Strict cascade exact -> markdown -> fold -> markdown+fold; each tier runs
      // only when the previous localized nothing. Uniqueness is counted WITHIN
      // the matched tier.
      const tierPlan: {
        tier: MatchedVia;
        guard: boolean;
        norm: boolean;
        per: () => Cand[][];
      }[] = [
        { tier: "exact", guard: true, norm: false, per: () => rawCands(edit.find) },
        {
          tier: "markdown",
          guard: hasStripped,
          norm: true,
          per: () => rawCands(stripped),
        },
        {
          tier: "fold",
          guard: foldFindOk,
          norm: false,
          per: () => foldCandsFor(foldFind, false),
        },
        {
          tier: "markdown+fold",
          guard: foldStrippedOk,
          norm: true,
          per: () => foldCandsFor(foldStrippedFull, false),
        },
      ];
      for (const t of tierPlan) {
        if (!t.guard) continue;
        const per = t.per();
        const n = sumCands(per);
        if (n > 0) {
          total = n;
          matchedVia = t.tier;
          normalized = t.norm;
          plannedPerBlock = per.map((a) =>
            a.map((c) => ({ ...c, tier: t.tier })),
          );
          break;
        }
      }
    }

    if (matchedVia === null) {
      failed.push({
        find: edit.find,
        reason: diagnoseMiss(
          blockChars,
          blockPlain,
          blockFold,
          blockTopIndex,
          blockTopNode,
          edit.find,
          stripped,
          foldFind,
          foldStrippedFull,
        ),
      });
      continue;
    }

    // ---- INTENT REFUSALS (AFTER localization) ----
    // editPageText edits PLAIN TEXT only and writes `replace` verbatim, so it
    // cannot add/remove marks and any markdown in `replace` becomes literal
    // asterisks/backticks in the page. These refusals run AFTER localization so
    // (a) a toggle whose `find` matched nothing already returned not-found (the
    // honest answer — the text isn't there), and (b) we can tell whether the
    // LITERAL markers are actually in the document.
    //
    // The LITERAL-EXCEPTION (shared by both checks below): bypass the refusal IFF
    // `find` matched via a NON-stripping tier (verbatim, i.e. normalized===false)
    // AND `find` itself contains literal marker-pairs. That strict conjunction
    // proves the LITERAL markers — not merely the text — are present, so a
    // cleanup edit (`**bold**` -> `bold`) applies as ordinary text. A bare
    // exact-match exception would revive the original bug for single markers
    // (`find:"жирный", replace:"*жирный*"` exact-matches, single `*` undetected).
    const literalException =
      normalized === false && containsLiteralMarkerPairs(edit.find);

    // A pure formatting TOGGLE: find/replace differ ONLY by balanced markdown
    // markers (strict stripBalancedWrappers, symmetric, to avoid the lenient
    // locator's false positives on trailing-space/snake_case/`2 * 3 * 4`/URLs).
    const formattingOnly =
      edit.find !== edit.replace &&
      stripBalancedWrappers(edit.find) === stripBalancedWrappers(edit.replace);
    if (formattingOnly && !literalException) {
      failed.push({
        find: edit.find,
        reason:
          "editPageText edits plain text only and cannot add or remove formatting marks (bold/italic/strike/code/link); it writes the replacement as LITERAL text. This edit looks like a formatting change (markdown markers in find/replace). To change marks, read the block with getPageJson and use patchNode to set the node's marks array. If you meant literal markers as content — use patchNode with node JSON (text there is literal).",
      });
      continue;
    }

    // MARKERS-IN-REPLACE: `replace` smuggles literal marker-pairs (a MIXED edit
    // — text change + markers — that the old formattingOnly toggle missed,
    // silently writing literal `**`). Refuse unless the literal-exception holds.
    // The reason branches by the tier that located `find` (a single text would
    // lie on some paths).
    if (containsLiteralMarkerPairs(edit.replace) && !literalException) {
      const reason = normalized
        ? // find located via markdown-strip: the markers are NOT in the document.
          "find matched after stripping markdown — there are no literal markers in the document; remove the markers from replace (the unchanged part keeps its formatting); to change formatting use getNode(format:\"json\") + patchNode."
        : // find matched verbatim but carries no marker-pairs (plain find +
          // `[link](url)`/`__init__` in replace): the replace is written literally.
          "replace is written literally; its markers become visible text. For formatting/links use patchNode; if the markers are content (`__init__`) use patchNode with node JSON (text there is literal).";
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

    // For a non-replaceAll edit, keep only the FIRST planned occurrence (in
    // document order); ambiguity (total > 1) was already rejected above, so at
    // this point there is exactly one planned candidate — but trim defensively.
    if (!edit.replaceAll) {
      let kept = false;
      for (let b = 0; b < plannedPerBlock.length; b++) {
        if (kept) {
          plannedPerBlock[b] = [];
        } else if (plannedPerBlock[b].length > 0) {
          plannedPerBlock[b] = [plannedPerBlock[b][0]];
          kept = true;
        }
      }
    }

    // Apply the splices block-by-block and re-tokenize changed blocks. The diff
    // is PER-TIER: exact/markdown ranges diff raw (both sides), fold ranges diff
    // in folded space (see computeSplice). `edit.replace` stays literal for the
    // raw tiers — never stripped, never folded — so edits of the invisibles
    // themselves keep working.
    const needleTextFor = (t: MatchedVia): string =>
      t === "markdown" ? stripped : edit.find;
    const foldNeedleFor = (t: MatchedVia): string =>
      t === "markdown+fold" ? foldStrippedFull : foldFind;
    let spliced = 0;
    for (let b = 0; b < blocks.length; b++) {
      if (plannedPerBlock[b].length === 0) continue;
      const splices: Splice[] = plannedPerBlock[b].map((pc) =>
        computeSplice(
          pc,
          pc.tier,
          needleTextFor(pc.tier),
          foldNeedleFor(pc.tier),
          edit.replace,
          blockFold[b],
        ),
      );
      const { newChars, spliced: n } = applySplices(blockChars[b], splices);
      spliced += n;
      blocks[b].content = tokenizeChars(newChars);
    }

    // Keep `find: edit.find` (the original) so the caller can correlate.
    const result: TextEditResult = { find: edit.find, replacements: spliced };
    if (normalized) result.normalized = true;
    if (matchedVia) result.matchedVia = matchedVia;
    // WARN on a formatting-toggle that only applied because the literal-exception
    // held: a markdown-docs page may hold BOTH a literal `**bold**` example and a
    // real bold word, so an exact match on the example silently edits the wrong
    // target instead of the guaranteed refusal. Observable + self-correcting.
    if (formattingOnly && literalException) {
      result.warning =
        "edited LITERAL markers found verbatim in the text; to change real formatting use patchNode.";
    }
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
