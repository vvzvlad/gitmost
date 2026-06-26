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
 */

/** Typographic double-quote variants mapped to ASCII `"`. */
const DOUBLE_QUOTES = "«»„“”‟〝〞＂";
/** Typographic single-quote/apostrophe variants mapped to ASCII `'`. */
const SINGLE_QUOTES = "‘’‚‛";
/** Dash variants mapped to ASCII `-`. */
const DASHES = "–—―−‐‑‒";

/** Guard against pathological/cyclic documents in the depth-first walk. */
const MAX_DEPTH = 200;

/** The comment mark Docmost stores on anchored text. */
function makeCommentMark(commentId: string): any {
  // The comment mark schema declares both commentId and resolved; include
  // resolved:false for completeness so the stored mark matches the editor's.
  return { type: "comment", attrs: { commentId, resolved: false } };
}

/** True for any character we collapse/replace with a single normal space. */
function isWhitespaceChar(ch: string): boolean {
  // Regular ASCII whitespace plus the special spaces called out in the spec:
  // nbsp, narrow nbsp, en/em/thin/hair/figure spaces, etc. \s covers tab and
  // newline; the explicit code points cover the non-breaking variants \s misses
  // in some engines, so list them for determinism.
  return (
    /\s/.test(ch) ||
    ch === " " || // no-break space
    ch === " " || // figure space
    ch === " " || // narrow no-break space
    ch === " " || // thin space
    ch === " " || // hair space
    ch === " " || // en space
    ch === " " // em space
  );
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
 */
export function normalizeForMatch(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isWhitespaceChar(ch)) {
      // Collapse the whole whitespace run to one space mapped to the run start.
      const runStart = i;
      while (i < s.length && isWhitespaceChar(s[i])) i++;
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
): AnchorMatch | null {
  if (!Array.isArray(blockContent)) return null;

  const normSelObj = normalizeForMatch(selection);
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
    const { norm, map } = normalizeForMatch(rawRun);
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

/**
 * Depth-first, document-order check for whether `selection` can be anchored
 * anywhere in `doc`. At each node with an array `content`, first try to match
 * within that node's own content, then recurse into children that themselves
 * have a `content` array.
 */
export function canAnchorInDoc(doc: any, selection: string): boolean {
  const visit = (node: any, depth: number): boolean => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return false;
    if (!Array.isArray(node.content)) return false;
    if (findAnchorInBlock(node.content, selection)) return true;
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
 * Split the matched text nodes and splice the comment mark across the range.
 * `blockContent` is mutated IN PLACE. `match.startChild..endChild` are all text
 * nodes (guaranteed by findAnchorInBlock building runs of text nodes).
 */
function spliceCommentMark(
  blockContent: any[],
  match: AnchorMatch,
  commentId: string,
): void {
  const { startChild, startOffset, endChild, endOffset } = match;
  const commentMark = makeCommentMark(commentId);
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
  const visit = (node: any, depth: number): boolean => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return false;
    if (!Array.isArray(node.content)) return false;
    const match = findAnchorInBlock(node.content, selection);
    if (match) {
      spliceCommentMark(node.content, match, commentId);
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
