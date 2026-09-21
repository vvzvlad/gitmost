/**
 * Inline-comment anchoring against a ProseMirror document.
 *
 * Docmost stores an inline comment's highlight as a `comment` MARK on the
 * document text (`{ type: "comment", attrs: { commentId, resolved } }`); the
 * `/comments/create` API only records the comment row + its `selection` text and
 * does NOT insert that mark, so the anchor has to be written into the page
 * content separately. This module finds where a selection lives in the document
 * and splices the comment mark across the matched range.
 *
 * Matching has to be robust because the agent supplies the selection as plain
 * text while the document stores rich inline content: a selection can span
 * several adjacent text nodes (inline code / bold / links each become their own
 * text node), and the document may use smart/typographic quotes, dash variants,
 * non-breaking spaces, or collapsed runs of whitespace that the agent typed as
 * ASCII quotes/hyphens/single spaces. We therefore normalize both sides before
 * comparing and match across maximal runs of consecutive text nodes within a
 * single block, while mapping every normalized character back to its raw index
 * so the mark lands on the exact original characters.
 *
 * MARKDOWN-STRIP FALLBACK: when the agent copies a selection that still carries
 * inline markdown (`**bold**`, `` `code` ``, `[t](u)`), the raw locator will not
 * match the document's plain text. Exactly like editPageText's json-edit
 * fallback, we first try the verbatim selection and, ONLY if it anchors nowhere
 * in the whole document, retry with `stripInlineMarkdown` applied. All four entry
 * points — `canAnchorInDoc`, `getAnchoredText`, `applyAnchorInDoc` and
 * `countAnchorMatches` — share this exact-wins / strip-fallback decision through the
 * SINGLE resolver `resolveAnchorSelection`; there is no second copy of the control
 * flow. `countAnchorMatches` just asks the resolver which selection form wins and
 * returns the raw occurrence count of that winning form. Because count and anchor
 * derive from the same resolver, the suggestion-uniqueness gate (which depends on
 * count) can never disagree with what actually anchors.
 */

import { stripInlineMarkdown } from "./text-normalize.js";
import {
  DOUBLE_QUOTES,
  SINGLE_QUOTES,
  DASHES,
  isLegacySpace,
  foldInvisibles,
} from "@docmost/prosemirror-markdown";
import { docmostSchema } from "./docmost-schema.js";

/** Guard against pathological/cyclic documents in the depth-first walk. */
const MAX_DEPTH = 200;

// Node types with inline (text) content whose spec forbids the `comment` mark
// (TipTap codeBlock declares `marks: ""`). Anchoring a comment mark inside such
// a node poisons the Y.Doc: on the next schema-full materialization
// y-prosemirror deletes the WHOLE node (permanent data loss). Derived from the
// schema so a future mark-forbidding block type is covered automatically.
const MARK_FORBIDDING_BLOCKS: ReadonlySet<string> = new Set(
  Object.values(docmostSchema.nodes)
    .filter((t) => t.inlineContent && !t.allowsMarkType(docmostSchema.marks.comment))
    .map((t) => t.name),
);

/**
 * True when a node's OWN content is allowed to hold a comment-mark anchor
 * (i.e. its type is not a mark-forbidding block). This gates ONLY the
 * own-content match at each traversal step — recursion into children is never
 * gated (harmless for codeBlock, whose children are bare text, and required
 * for containers like tables whose paragraphs must keep matching).
 */
const canMatchIn = (node: any): boolean => !MARK_FORBIDDING_BLOCKS.has(node?.type);

/** The comment mark Docmost stores on anchored text. */
function makeCommentMark(commentId: string): any {
  // The comment mark schema declares both commentId and resolved; include
  // resolved:false for completeness so the stored mark matches the editor's.
  return { type: "comment", attrs: { commentId, resolved: false } };
}

/**
 * Normalize a string for matching and return both the normalized text and a
 * `map` where `map[i]` is the index into the ORIGINAL `s` of the i-th
 * normalized character.
 *
 * Rules: map smart quotes / dashes / special spaces to their ASCII forms,
 * collapse any run of whitespace to a SINGLE space (whose map entry points at
 * the FIRST raw whitespace char of the run), and DO NOT lowercase (anchoring is
 * case-sensitive to match the exact document text).
 *
 * Whitespace class + glyph tables come from the shared fold canon (#658,
 * `@docmost/prosemirror-markdown`) — `isLegacySpace` is byte-identical to the
 * former local `isWhitespaceChar` (U+FEFF stays a SPACE here), so this rebuild
 * is provably equivalent to the historic normalizer (golden test).
 */
export function normalizeForMatch(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isLegacySpace(ch)) {
      // Collapse the whole whitespace run to one space mapped to the run start.
      const runStart = i;
      while (i < s.length && isLegacySpace(s[i])) i++;
      norm += " ";
      map.push(runStart);
      continue;
    }
    let mapped = ch;
    if (DOUBLE_QUOTES.indexOf(ch) !== -1) mapped = '"';
    else if (SINGLE_QUOTES.indexOf(ch) !== -1) mapped = "'";
    else if (DASHES.indexOf(ch) !== -1) mapped = "-";
    norm += mapped;
    map.push(i);
    i++;
  }
  return { norm, map };
}

/**
 * FOLD variant of {@link normalizeForMatch} for the createComment fold TIER
 * (#658): fold invisible characters (delete SHY/ZWSP/ZWJ/WJ/BOM, collapse
 * NBSP-family runs) AND typographic quotes/dashes, returning the same
 * `{ norm, map }` shape so every anchoring call site can consume it identically.
 * Built on the canonical `foldInvisibles` for the invisible-char + run-collapse
 * map, then the same 1:1 quote/dash glyph mapping normalizeForMatch applies.
 */
export function foldForMatch(s: string): { norm: string; map: number[] } {
  const { folded, map } = foldInvisibles(s);
  let norm = "";
  for (const ch of folded) {
    if (DOUBLE_QUOTES.indexOf(ch) !== -1) norm += '"';
    else if (SINGLE_QUOTES.indexOf(ch) !== -1) norm += "'";
    else if (DASHES.indexOf(ch) !== -1) norm += "-";
    else norm += ch;
  }
  return { norm, map };
}

/** A locator normalizer used by an anchoring tier: raw text -> {norm, map}. */
export type MatchNormalizer = (s: string) => { norm: string; map: number[] };

/** Descriptor of a matched range inside one block's `content` array. */
export interface AnchorMatch {
  startChild: number;
  startOffset: number;
  endChild: number;
  endOffset: number;
}

/** Per-raw-char location inside a run: which child node and offset within it. */
interface RawLoc {
  childIdx: number;
  offset: number;
}

/**
 * Find a selection inside a SINGLE block's direct `content` array.
 *
 * Builds maximal runs of consecutive `text` nodes (any non-text inline node,
 * e.g. a mention, breaks the run), normalizes each run and the selection the
 * same way, then searches each run for the normalized selection. Returns the
 * child/offset range of the FIRST matching run, or `null` if none match.
 */
export function findAnchorInBlock(
  blockContent: any[],
  selection: string,
  normalizer: MatchNormalizer = normalizeForMatch,
): AnchorMatch | null {
  if (!Array.isArray(blockContent)) return null;

  const normSelObj = normalizer(selection);
  // Trim leading/trailing spaces on the NORMALIZED selection only.
  const normSel = normSelObj.norm.trim();
  if (normSel.length === 0) return null;

  let i = 0;
  while (i < blockContent.length) {
    const node = blockContent[i];
    if (!node || typeof node !== "object" || node.type !== "text") {
      i++;
      continue;
    }
    // Accumulate a maximal run of consecutive text nodes.
    let rawRun = "";
    const rawToChild: RawLoc[] = [];
    let j = i;
    while (j < blockContent.length) {
      const n = blockContent[j];
      if (!n || typeof n !== "object" || n.type !== "text") break;
      const text = typeof n.text === "string" ? n.text : "";
      for (let k = 0; k < text.length; k++) {
        rawToChild.push({ childIdx: j, offset: k });
      }
      rawRun += text;
      j++;
    }

    // Try to match within this run.
    const { norm, map } = normalizer(rawRun);
    const idx = norm.indexOf(normSel);
    if (idx !== -1) {
      const rawStart = map[idx];
      const rawEndExclusive =
        idx + normSel.length < map.length
          ? map[idx + normSel.length]
          : rawRun.length;
      const startLoc = rawToChild[rawStart];
      // rawEndExclusive points at the raw char AFTER the match; the last matched
      // raw char is at rawEndExclusive-1, so endOffset is its offset + 1.
      const lastLoc = rawToChild[rawEndExclusive - 1];
      return {
        startChild: startLoc.childIdx,
        startOffset: startLoc.offset,
        endChild: lastLoc.childIdx,
        endOffset: lastLoc.offset + 1,
      };
    }

    // No match in this run: continue scanning AFTER it.
    i = j > i ? j : i + 1;
  }
  return null;
}

/** True when a text node already carries any `comment` mark. */
function hasCommentMark(node: any): boolean {
  return (
    !!node &&
    Array.isArray(node.marks) &&
    node.marks.some((m: any) => m && m.type === "comment")
  );
}

/**
 * Like {@link findAnchorInBlock}, but returns the first matched range whose text
 * nodes do NOT already carry a comment mark. This lets the regraft place several
 * anchors that share IDENTICAL text onto DISTINCT occurrences: once an occurrence
 * has been grafted (its nodes now carry a comment mark) the next span with the
 * same text skips past it to the next free occurrence, instead of all piling onto
 * occurrence #0. That collision matters because a text span can carry only ONE
 * comment mark — the mark excludes itself, so y-prosemirror keys it by bare type
 * name and a second same-type mark on the same span is silently overwritten at
 * toYdoc (see {@link regraftResolvedComments}). Returns null when every occurrence
 * of `selection` is already taken (or it does not occur at all).
 */
function findFreeAnchorInBlock(
  blockContent: any[],
  selection: string,
  normalizer: MatchNormalizer = normalizeForMatch,
): AnchorMatch | null {
  if (!Array.isArray(blockContent)) return null;

  const normSel = normalizer(selection).norm.trim();
  if (normSel.length === 0) return null;

  let i = 0;
  while (i < blockContent.length) {
    const node = blockContent[i];
    if (!node || typeof node !== "object" || node.type !== "text") {
      i++;
      continue;
    }
    // Accumulate a maximal run of consecutive text nodes (as findAnchorInBlock).
    let rawRun = "";
    const rawToChild: RawLoc[] = [];
    let j = i;
    while (j < blockContent.length) {
      const n = blockContent[j];
      if (!n || typeof n !== "object" || n.type !== "text") break;
      const text = typeof n.text === "string" ? n.text : "";
      for (let k = 0; k < text.length; k++) {
        rawToChild.push({ childIdx: j, offset: k });
      }
      rawRun += text;
      j++;
    }

    // Walk every non-overlapping occurrence in this run; return the FIRST whose
    // matched child range is free of a pre-existing comment mark.
    const { norm, map } = normalizer(rawRun);
    let from = 0;
    for (;;) {
      const idx = norm.indexOf(normSel, from);
      if (idx === -1) break;
      const rawStart = map[idx];
      const rawEndExclusive =
        idx + normSel.length < map.length
          ? map[idx + normSel.length]
          : rawRun.length;
      const startLoc = rawToChild[rawStart];
      const lastLoc = rawToChild[rawEndExclusive - 1];
      const match: AnchorMatch = {
        startChild: startLoc.childIdx,
        startOffset: startLoc.offset,
        endChild: lastLoc.childIdx,
        endOffset: lastLoc.offset + 1,
      };
      let free = true;
      for (let c = match.startChild; c <= match.endChild; c++) {
        if (hasCommentMark(blockContent[c])) {
          free = false;
          break;
        }
      }
      if (free) return match;
      // Occurrence already taken: advance past it (non-overlapping).
      from = idx + normSel.length;
    }

    // No FREE occurrence in this run: continue scanning AFTER it.
    i = j > i ? j : i + 1;
  }
  return null;
}

/**
 * Reconstruct the RAW text spanned by an AnchorMatch inside one block's
 * `content` array. `startChild..endChild` are all text nodes (guaranteed by
 * findAnchorInBlock, which only builds runs of `text` nodes), so concatenate
 * each node's text slice: from `startOffset` on the first node, up to
 * `endOffset` on the last, and the whole `.text` for any node fully inside the
 * range. Mirrors spliceCommentMark's per-node slicing so the string returned
 * here is EXACTLY the characters the comment mark will cover.
 */
function reconstructRawText(blockContent: any[], match: AnchorMatch): string {
  const { startChild, startOffset, endChild, endOffset } = match;
  let out = "";
  for (let k = startChild; k <= endChild; k++) {
    const n = blockContent[k];
    const text: string = typeof n.text === "string" ? n.text : "";
    const sliceStart = k === startChild ? startOffset : 0;
    const sliceEnd = k === endChild ? endOffset : text.length;
    out += text.slice(sliceStart, sliceEnd);
  }
  return out;
}

/**
 * Return the RAW document substring that `selection` would anchor to — the exact
 * characters the comment mark will cover — or `null` when the selection cannot
 * be anchored anywhere in `doc`.
 *
 * This mirrors canAnchorInDoc / applyAnchorInDoc EXACTLY (same depth-first,
 * document-order traversal and the same findAnchorInBlock match on the FIRST
 * matching block), but instead of a boolean / an in-place mutation it
 * reconstructs the raw text spanned by the matched range. Because
 * findAnchorInBlock maps the normalized selection back to raw text-node
 * positions, the returned string is the document's ORIGINAL characters (smart
 * quotes, em-dashes, nbsp, collapsed whitespace) — NOT the normalized ASCII
 * agent input.
 *
 * Callers store THIS as the comment's `selection` so the stored value equals the
 * text actually under the mark, which is what the apply-suggestion equality
 * check (replaceYjsMarkedText's `joinedText !== expectedText`) compares against.
 * Without it a suggestion whose anchor only matched via normalization would be
 * un-appliable (spurious 409).
 */
export function getAnchoredText(doc: any, selection: string): string | null {
  const { selection: effective, found, normalizer } = resolveAnchorSelection(
    doc,
    selection,
  );
  if (!found) return null;
  const visit = (node: any, depth: number): string | null => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return null;
    if (!Array.isArray(node.content)) return null;
    // Own-content match only where a comment mark may live (see canMatchIn).
    const match = canMatchIn(node)
      ? findAnchorInBlock(node.content, effective, normalizer)
      : null;
    if (match) return reconstructRawText(node.content, match);
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        const foundText = visit(child, depth + 1);
        if (foundText !== null) return foundText;
      }
    }
    return null;
  };
  return visit(doc, 0);
}

/**
 * RAW (no markdown-strip fallback) depth-first check that `selection` anchors
 * somewhere in `doc`. This is the primitive `resolveAnchorSelection` builds on;
 * public callers should use `canAnchorInDoc`, which adds the strip fallback.
 *
 * `includeMarkForbidding` is an INTERNAL escape hatch: when true, the
 * mark-forbidding-block guard is disabled so `resolveAnchorSelection` can
 * distinguish "the text is absent" from "the text exists only inside a
 * codeBlock" for its diagnostic flag. It must never be used to actually anchor.
 */
function rawCanAnchorInDoc(
  doc: any,
  selection: string,
  includeMarkForbidding = false,
  normalizer: MatchNormalizer = normalizeForMatch,
): boolean {
  const visit = (node: any, depth: number): boolean => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return false;
    if (!Array.isArray(node.content)) return false;
    if (
      (includeMarkForbidding || canMatchIn(node)) &&
      findAnchorInBlock(node.content, selection, normalizer)
    )
      return true;
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        if (visit(child, depth + 1)) return true;
      }
    }
    return false;
  };
  return visit(doc, 0);
}

/**
 * Decide the locator that ACTUALLY anchors `selection` in `doc`, applying the
 * markdown-strip fallback once (so every public entry point agrees):
 *  - EXACT WINS: if the verbatim selection anchors anywhere, use it as-is.
 *  - FALLBACK: only if the verbatim selection anchors nowhere, and the
 *    markdown-stripped form differs and DOES anchor, use the stripped form and
 *    flag `normalized` so callers can surface a soft warning.
 *  - otherwise `found` is false and `selection` is returned unchanged.
 *
 * The stripped form is used ONLY to LOCATE the anchor; getAnchoredText still
 * reconstructs and stores the RAW document substring, so the strip never leaks
 * into what gets persisted.
 *
 * When neither form anchors in ALLOWED content, the resolver re-checks with the
 * mark-forbidding-block guard disabled and sets `inMarkForbiddingBlock` when
 * the selection WOULD have matched inside such a block (e.g. a codeBlock) —
 * so callers can explain WHY anchoring is refused instead of claiming the text
 * is missing. `found` stays false either way.
 *
 * FOLD TIER (#658): the fallback lattice is two-axis — { verbatim, md-strip } ×
 * { pass-1, fold } — tried in the fixed order pass-1/verbatim → pass-1/md-strip
 * → fold/verbatim → fold/md-strip. pass-1 tiers run FIRST and byte-for-byte
 * unchanged, so an existing anchor's first match never shifts; the fold tiers
 * add anchors only where pass-1 found ZERO (a selection built from searchInPage
 * output — which carries the document's invisibles — still anchors). The winning
 * normalizer is returned so uniqueness counting runs in the SAME tier's space
 * (no count-vs-anchor drift, #494).
 */
export function resolveAnchorSelection(
  doc: any,
  selection: string,
): {
  selection: string;
  found: boolean;
  normalized: boolean;
  /** The normalizer of the WINNING tier — count in the same space (#494). */
  normalizer: MatchNormalizer;
  /** True when the fold tier (not pass-1) won. */
  foldPass?: boolean;
  /** The selection matches ONLY inside a mark-forbidding block (codeBlock). */
  inMarkForbiddingBlock?: boolean;
} {
  const stripped = stripInlineMarkdown(selection);
  // Fixed-order tier lattice; first anchoring tier wins.
  if (rawCanAnchorInDoc(doc, selection, false, normalizeForMatch)) {
    return { selection, found: true, normalized: false, normalizer: normalizeForMatch };
  }
  if (
    stripped !== selection &&
    rawCanAnchorInDoc(doc, stripped, false, normalizeForMatch)
  ) {
    return { selection: stripped, found: true, normalized: true, normalizer: normalizeForMatch };
  }
  if (rawCanAnchorInDoc(doc, selection, false, foldForMatch)) {
    return {
      selection,
      found: true,
      normalized: false,
      normalizer: foldForMatch,
      foldPass: true,
    };
  }
  if (
    stripped !== selection &&
    rawCanAnchorInDoc(doc, stripped, false, foldForMatch)
  ) {
    return {
      selection: stripped,
      found: true,
      normalized: true,
      normalizer: foldForMatch,
      foldPass: true,
    };
  }
  // Anchors nowhere in allowed content: flag when the miss is caused by the
  // mark-forbidding guard (all four tiers are re-checked, guard off).
  if (
    rawCanAnchorInDoc(doc, selection, true, normalizeForMatch) ||
    (stripped !== selection &&
      rawCanAnchorInDoc(doc, stripped, true, normalizeForMatch)) ||
    rawCanAnchorInDoc(doc, selection, true, foldForMatch) ||
    (stripped !== selection &&
      rawCanAnchorInDoc(doc, stripped, true, foldForMatch))
  ) {
    return {
      selection,
      found: false,
      normalized: false,
      normalizer: normalizeForMatch,
      inMarkForbiddingBlock: true,
    };
  }
  return { selection, found: false, normalized: false, normalizer: normalizeForMatch };
}

/**
 * True when `selection` cannot anchor anywhere in allowed content but DOES
 * occur inside a mark-forbidding block (e.g. a codeBlock). Implemented via
 * `resolveAnchorSelection` so this diagnostic can never disagree with what the
 * anchoring entry points actually refuse.
 */
export function selectionOnlyInMarkForbiddingBlock(
  doc: any,
  selection: string,
): boolean {
  return resolveAnchorSelection(doc, selection).inMarkForbiddingBlock === true;
}

/**
 * Depth-first, document-order check for whether `selection` can be anchored
 * anywhere in `doc` (with the markdown-strip fallback). At each node with an
 * array `content`, first try to match within that node's own content, then
 * recurse into children that themselves have a `content` array.
 */
export function canAnchorInDoc(doc: any, selection: string): boolean {
  return resolveAnchorSelection(doc, selection).found;
}

/**
 * Split the matched text nodes and splice the comment mark across the range.
 * `blockContent` is mutated IN PLACE. `match.startChild..endChild` are all text
 * nodes (guaranteed by findAnchorInBlock building runs of text nodes).
 */
function spliceCommentMark(
  blockContent: any[],
  match: AnchorMatch,
  commentMark: any,
): void {
  const { startChild, startOffset, endChild, endOffset } = match;
  const fragments: any[] = [];

  for (let k = startChild; k <= endChild; k++) {
    const n = blockContent[k];
    const text: string = typeof n.text === "string" ? n.text : "";
    const sliceStart = k === startChild ? startOffset : 0;
    const sliceEnd = k === endChild ? endOffset : text.length;

    const before = k === startChild ? text.slice(0, startOffset) : "";
    const marked = text.slice(sliceStart, sliceEnd);
    const after = k === endChild ? text.slice(endOffset) : "";

    // Process per-node so each node's OWN marks/attrs are preserved.
    const ownMarks: any[] = Array.isArray(n.marks) ? n.marks : [];
    // Drop any pre-existing comment mark from the marked fragment so it ends up
    // with exactly one comment mark (the new one) rather than two.
    const markedBaseMarks = ownMarks.filter(
      (m: any) => !(m && m.type === "comment"),
    );

    if (before.length > 0) {
      fragments.push({ ...n, text: before, marks: [...ownMarks] });
    }
    if (marked.length > 0) {
      fragments.push({
        ...n,
        text: marked,
        marks: [...markedBaseMarks, commentMark],
      });
    }
    if (after.length > 0) {
      fragments.push({ ...n, text: after, marks: [...ownMarks] });
    }
  }

  blockContent.splice(startChild, endChild - startChild + 1, ...fragments);
}

/**
 * Count how many times `selection` occurs across the whole document, using the
 * same normalization and run-matching as findAnchorInBlock but WITHOUT stopping
 * at the first hit: every non-overlapping occurrence within each block's text
 * runs is counted and summed across all blocks (depth-first, the same traversal
 * as canAnchorInDoc).
 *
 * This is the uniqueness gate for SUGGESTIONS: because applying a suggestion
 * rewrites the exact anchored text, an ambiguous anchor (>1 occurrence) would
 * silently edit the wrong place, so a suggestion is only allowed when this
 * returns exactly 1. Ordinary comments keep first-occurrence anchoring and do
 * not use this. (Note: counts OCCURRENCES, not just matching blocks, so two
 * occurrences inside one block are correctly reported as 2.)
 */
function rawCountAnchorMatches(
  doc: any,
  selection: string,
  normalizer: MatchNormalizer = normalizeForMatch,
): number {
  const normSel = normalizer(selection).norm.trim();
  if (normSel.length === 0) return 0;

  // Count non-overlapping occurrences of the normalized selection within a
  // single block's direct content, matching findAnchorInBlock's run building.
  const countInBlock = (blockContent: any[]): number => {
    if (!Array.isArray(blockContent)) return 0;
    let count = 0;
    let i = 0;
    while (i < blockContent.length) {
      const node = blockContent[i];
      if (!node || typeof node !== "object" || node.type !== "text") {
        i++;
        continue;
      }
      // Accumulate a maximal run of consecutive text nodes.
      let rawRun = "";
      let j = i;
      while (j < blockContent.length) {
        const n = blockContent[j];
        if (!n || typeof n !== "object" || n.type !== "text") break;
        rawRun += typeof n.text === "string" ? n.text : "";
        j++;
      }
      const norm = normalizer(rawRun).norm;
      // Count every non-overlapping occurrence in this run.
      let from = 0;
      for (;;) {
        const idx = norm.indexOf(normSel, from);
        if (idx === -1) break;
        count++;
        from = idx + normSel.length;
      }
      i = j > i ? j : i + 1;
    }
    return count;
  };

  let total = 0;
  const visit = (node: any, depth: number): void => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return;
    if (!Array.isArray(node.content)) return;
    // Count own-content occurrences only where a comment mark may live.
    if (canMatchIn(node)) total += countInBlock(node.content);
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(doc, 0);
  return total;
}

/**
 * Uniqueness gate for suggestions. Delegates the exact-wins / markdown-strip
 * FALLBACK DECISION to `resolveAnchorSelection` — the single resolver every
 * other entry point (canAnchorInDoc / getAnchoredText / applyAnchorInDoc) shares
 * — then counts occurrences of the resolved form. This removes the parallel
 * exact-wins control flow (#494): counting can no longer drift from anchoring
 * about WHICH selection form wins, because both ask the same resolver. Behaviour
 * is unchanged: `resolveAnchorSelection` reports `found` iff the verbatim (else
 * stripped) selection anchors — the same condition under which the old
 * raw>0 / strippedCount>0 branches fired — and it returns the same winning form,
 * whose raw occurrence count is what we return (EXACT WINS: a raw match yields the
 * raw count, so a selection unique raw stays unique; only an absent verbatim
 * selection falls back to the stripped form's count).
 */
export function countAnchorMatches(doc: any, selection: string): number {
  const { selection: effective, found, normalizer } = resolveAnchorSelection(
    doc,
    selection,
  );
  if (!found) return 0;
  return rawCountAnchorMatches(doc, effective, normalizer);
}

/**
 * Depth-first (same order as canAnchorInDoc) over `doc`; on the FIRST block
 * whose content matches `selection`, splice the comment mark across the matched
 * range in place and return true. Returns false (and does NOT mutate) when no
 * block matches.
 */
export function applyAnchorInDoc(
  doc: any,
  selection: string,
  commentId: string,
): boolean {
  return applyCommentMarkInDoc(doc, selection, makeCommentMark(commentId));
}

/**
 * Core of {@link applyAnchorInDoc}, but splices an ARBITRARY comment mark object
 * (not just a fresh `{ commentId, resolved:false }`) across the first matching
 * range. This lets a caller re-apply a mark that carries `resolved:true` and any
 * other stored attrs. Depth-first (same order as canAnchorInDoc); mutates in
 * place on the first matching block and returns true, else returns false without
 * mutating.
 */
export function applyCommentMarkInDoc(
  doc: any,
  selection: string,
  commentMark: any,
): boolean {
  const { selection: effective, found, normalizer } = resolveAnchorSelection(
    doc,
    selection,
  );
  if (!found) return false;
  const visit = (node: any, depth: number): boolean => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return false;
    if (!Array.isArray(node.content)) return false;
    // Never splice a comment mark into a mark-forbidding block (codeBlock):
    // the schema rejects it and y-prosemirror would delete the whole node on
    // the next materialization. Recursion into children stays unguarded.
    const match = canMatchIn(node)
      ? findAnchorInBlock(node.content, effective, normalizer)
      : null;
    if (match) {
      spliceCommentMark(node.content, match, commentMark);
      return true;
    }
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        if (visit(child, depth + 1)) return true;
      }
    }
    return false;
  };
  return visit(doc, 0);
}

/**
 * Graft a comment mark onto the FIRST FREE occurrence of `selection` — one whose
 * matched range does not already carry a comment mark (see findFreeAnchorInBlock).
 * Depth-first, document order (as applyCommentMarkInDoc). Mutates in place.
 * Returns:
 *  - "grafted": the mark was spliced onto a free occurrence;
 *  - "collision": the text still occurs but every occurrence is already taken by
 *    another comment mark (a span can hold only one comment mark), so this anchor
 *    cannot be placed;
 *  - "no-match": the text no longer anchors anywhere in the doc.
 */
function graftFreeCommentMark(
  doc: any,
  selection: string,
  commentMark: any,
): "grafted" | "collision" | "no-match" {
  const { selection: effective, found, normalizer } = resolveAnchorSelection(
    doc,
    selection,
  );
  // `found` is true iff SOME raw (or stripped) occurrence exists; if we then fail
  // to place the mark it is because every occurrence is already taken (collision),
  // not because the text is gone (no-match).
  if (!found) return "no-match";
  const visit = (node: any, depth: number): boolean => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return false;
    if (!Array.isArray(node.content)) return false;
    // Own-content match only where a comment mark may live (see canMatchIn):
    // never place a mark inside a mark-forbidding block (#603), even if the
    // identical text also occurs in one earlier in document order.
    const match = canMatchIn(node)
      ? findFreeAnchorInBlock(node.content, effective, normalizer)
      : null;
    if (match) {
      spliceCommentMark(node.content, match, commentMark);
      return true;
    }
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        if (visit(child, depth + 1)) return true;
      }
    }
    return false;
  };
  return visit(doc, 0) ? "grafted" : "collision";
}

/** A resolved-comment anchor the regraft could not place, surfaced via the sink. */
export interface RegraftWarning {
  /**
   * `no-match`: the span's text is gone from the new body (the agent rewrote or
   * deleted it) — the resolved anchor is simply lost (it was already resolved).
   * `collision`: the text still exists but every occurrence is already carrying a
   * comment mark; because the comment mark excludes itself, y-prosemirror keeps
   * only one comment mark per span at toYdoc, so this extra anchor cannot ride
   * along and is dropped.
   */
  code: "no-match" | "collision";
  /** The comment id whose resolved anchor was dropped. */
  commentId: string;
  /** The resolved span's text that failed to re-anchor. */
  text: string;
}

/** Sink for non-fatal regraft diagnostics (a dropped resolved anchor). */
export type RegraftWarningSink = (warning: RegraftWarning) => void;

/** A resolved inline-comment span lifted from a doc: its mark + anchored text. */
export interface ResolvedCommentSpan {
  commentId: string;
  /** The full comment mark (carrying `resolved:true` + any stored attrs). */
  mark: any;
  /** The concatenated raw text the mark spans — used as the re-anchor selection. */
  text: string;
}

/** True when a text node carries a RESOLVED comment mark; returns that mark. */
function resolvedCommentMarkOf(node: any): any | null {
  if (!node || node.type !== "text" || !Array.isArray(node.marks)) return null;
  return (
    node.marks.find(
      (m: any) =>
        m && m.type === "comment" && m.attrs?.resolved === true && m.attrs?.commentId,
    ) || null
  );
}

/**
 * Collect every RESOLVED inline-comment span in `doc`, in document order. Within
 * each block's direct content, a maximal run of consecutive text nodes sharing
 * the same resolved `commentId` is ONE span; its concatenated raw text is the
 * selection used to re-anchor it elsewhere. Active (unresolved) comment marks are
 * ignored — they survive a markdown round-trip on their own (a page read emits
 * their `<span data-comment-id>` wrapper), whereas resolved anchors are hidden
 * from agent reads (#337) and would be erased by a full-body markdown rewrite.
 */
export function collectResolvedCommentSpans(doc: any): ResolvedCommentSpan[] {
  const spans: ResolvedCommentSpan[] = [];
  const visit = (node: any, depth: number): void => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return;
    if (!Array.isArray(node.content)) return;
    const content = node.content;
    let i = 0;
    while (i < content.length) {
      const mark = resolvedCommentMarkOf(content[i]);
      if (mark) {
        const commentId = mark.attrs.commentId;
        let text = "";
        let j = i;
        while (j < content.length) {
          const mj = resolvedCommentMarkOf(content[j]);
          if (!mj || mj.attrs.commentId !== commentId) break;
          text += typeof content[j].text === "string" ? content[j].text : "";
          j++;
        }
        if (text.length > 0) spans.push({ commentId, mark, text });
        i = j > i ? j : i + 1;
      } else {
        i++;
      }
    }
    for (const child of content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(doc, 0);
  return spans;
}

/**
 * Re-graft RESOLVED comment marks from `oldDoc` onto matching text ranges in
 * `newDoc`, returning a NEW doc (never mutates the inputs).
 *
 * WHY (#493): an agent read hides resolved-comment anchors (#337), so the
 * markdown it sends to a FULL-body rewrite (`updatePageMarkdown`) no longer
 * carries them — a naive full write would erase every resolved comment mark.
 * This restores them: each resolved span from the previous document is re-anchored
 * onto the SAME text in the newly-imported body (using the shared anchoring /
 * markdown-strip fallback), preserving `resolved:true` and the stored attrs.
 *
 * DISTINCT OCCURRENCES (#514 review / #555): two DIFFERENT resolved anchors can
 * carry IDENTICAL text (e.g. the word "note" was commented twice, in two places).
 * A naive first-occurrence re-anchor lands both on occurrence #0, and only ONE
 * survives: `spliceCommentMark` strips any pre-existing comment mark before adding
 * the new one, so the second graft onto the same span replaces the first. This is
 * unavoidable at the data-model level anyway — a span can hold only a single comment
 * mark: the comment mark excludes itself, so y-prosemirror keys Yjs formatting by the
 * bare mark-type name and a second comment mark on one span cannot coexist through
 * toYdoc. To keep BOTH anchors we place each span on the first FREE occurrence — one
 * not already carrying a comment mark (findFreeAnchorInBlock) — so N identical-text
 * spans spread over N occurrences in document order.
 *
 * MARK-FORBIDDING BLOCKS (#603): the free-occurrence search is gated by the same
 * `canMatchIn` guard as every other anchoring path, so it never places a comment
 * mark inside a mark-forbidding block (e.g. a codeBlock) — even when the identical
 * text also appears in such a block earlier in document order. A resolved span
 * whose text now survives ONLY inside a mark-forbidding block does not re-anchor
 * (its occurrence there is invisible to the guarded search) and is dropped.
 *
 * DROP DIAGNOSTICS (#514 review / #555): an anchor that cannot be placed is no
 * longer dropped silently. When the text is gone or survives only in a
 * mark-forbidding block (`no-match`), or every allowed occurrence is already taken
 * (`collision` — fewer allowed occurrences than distinct anchors on identical
 * text), a structured {@link RegraftWarning} is emitted through the optional
 * `onWarn` sink. The doc is still returned; the drop is non-fatal (the anchor was
 * already resolved), only now it is observable.
 *
 * Active comments are untouched — they ride through the markdown themselves.
 */
export function regraftResolvedComments<T = any>(
  oldDoc: any,
  newDoc: T,
  onWarn?: RegraftWarningSink,
): T {
  if (!newDoc || typeof newDoc !== "object") return newDoc;
  const spans = collectResolvedCommentSpans(oldDoc);
  if (spans.length === 0) return newDoc;
  const out =
    typeof structuredClone === "function"
      ? structuredClone(newDoc)
      : (JSON.parse(JSON.stringify(newDoc)) as T);
  for (const span of spans) {
    // Clone the mark so the new document never shares a mark object with oldDoc.
    const markClone = { type: "comment", attrs: { ...span.mark.attrs } };
    const outcome = graftFreeCommentMark(out, span.text, markClone);
    if (outcome !== "grafted" && onWarn) {
      onWarn({ code: outcome, commentId: span.commentId, text: span.text });
    }
  }
  return out;
}
