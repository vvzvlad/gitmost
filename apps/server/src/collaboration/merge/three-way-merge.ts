/**
 * Pure block-level THREE-WAY merge planner (diff3) over arrays of opaque block
 * keys. Used by the git-sync body write to merge an incoming git body into the
 * live page using the last-synced version as the common ancestor (review #5):
 *
 *   - a block only the human changed (live != base, git == base) -> keep LIVE
 *   - a block only git changed       (git != base, live == base) -> take GIT
 *   - a block both sides changed (a real conflict)               -> GIT wins
 *   - inserts/deletes from either side are preserved when unambiguous
 *
 * Content-agnostic: it works on string keys and returns the merged block order as
 * picks ({ src: 'live'|'target', index }) — the caller (the Yjs applier)
 * materializes them — so the whole algorithm is unit-testable on plain arrays.
 *
 * Algorithm: anchor on base blocks present (unchanged) in BOTH live and target
 * (their LCS-with-base intersection). Between consecutive anchors lies one region
 * the human and/or git rewrote; resolve each region three-way. Stable anchor
 * blocks are emitted from LIVE so the applier keeps the existing Yjs block
 * instances (and the human's in-flight edits) in place.
 *
 * LOCATION (deferred): this and its `lcs.ts` sibling are pure, framework-free and
 * could conceptually live in `packages/git-sync` (the engine). They are kept in
 * the server integration on purpose: `packages/git-sync` is a VENDORED engine
 * (pinned upstream, manually re-synced), so adding first-party files there
 * complicates the re-sync story, and the only consumer today is the server. Move
 * them into the engine only once the vendoring re-sync story is settled.
 */

import { buildLcsTable } from './lcs';

/** Matched index pairs of the longest common subsequence of `a` and `b`. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp = buildLcsTable(a, b);
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** o-index -> matched index in the other side (only for LCS-matched blocks). */
function matchMap(pairs: Array<[number, number]>): Map<number, number> {
  const m = new Map<number, number>();
  for (const [o, x] of pairs) m.set(o, x);
  return m;
}

/**
 * One change `side` made to `base` within a region: base blocks `[oStart,oEnd)`
 * were replaced by the side's blocks listed in `content` (region-local indices).
 * A pure insert has `oStart === oEnd`; a pure delete has empty `content`.
 */
interface Hunk {
  oStart: number;
  oEnd: number;
  content: number[];
}

/**
 * Diff `o` against one side as a list of non-overlapping hunks (the base spans
 * the side rewrote/inserted/deleted), derived from their LCS alignment.
 */
function buildHunks(o: string[], side: string[]): Hunk[] {
  const pairs = lcsPairs(o, side); // [oIdx, sideIdx] kept (unchanged) blocks
  const hunks: Hunk[] = [];
  let prevO = -1;
  let prevS = -1;
  const flush = (curO: number, curS: number): void => {
    const oStart = prevO + 1;
    const oEnd = curO;
    const content: number[] = [];
    for (let s = prevS + 1; s < curS; s++) content.push(s);
    if (oEnd > oStart || content.length > 0) hunks.push({ oStart, oEnd, content });
  };
  for (const [oIdx, sIdx] of pairs) {
    flush(oIdx, sIdx);
    prevO = oIdx;
    prevS = sIdx;
  }
  flush(o.length, side.length);
  return hunks;
}

/**
 * Do two hunks (one per side) touch the same base region? Pure inserts only
 * collide when nested strictly inside the other hunk's base span (or, for two
 * inserts, at the same gap); changes sitting at a shared boundary do not.
 */
function hunksOverlap(a: Hunk, b: Hunk): boolean {
  const aIns = a.oStart === a.oEnd;
  const bIns = b.oStart === b.oEnd;
  if (aIns && bIns) return a.oStart === b.oStart;
  if (aIns) return b.oStart < a.oStart && a.oStart < b.oEnd;
  if (bIns) return a.oStart < b.oStart && b.oStart < a.oEnd;
  return Math.max(a.oStart, b.oStart) < Math.min(a.oEnd, b.oEnd);
}

interface LocalPick {
  src: 'live' | 'target';
  local: number;
}

/**
 * Fine-grained three-way merge of ONE inter-anchor region. Combines the human's
 * and git's NON-overlapping hunks (e.g. a human edit to one block plus a git
 * insert/delete of OTHER blocks in the same region) so neither change is lost.
 * Returns the merged region as region-local picks, or `null` when the two sides
 * changed the SAME base block — a genuine conflict the caller resolves by the
 * original all-or-nothing rule (git wins the whole region).
 */
function tryMergeRegion(
  o: string[],
  a: string[],
  b: string[],
): LocalPick[] | null {
  // Agreement short-circuit (review #11). When live (a) and target (b) are
  // identical, both sides converged on the SAME result — diff3 "agreement", NOT
  // a conflict. This is the dominant echo case (live == target != base) that
  // otherwise trips the overlap check below and is logged as a false "N same-block
  // conflict(s) resolved to the git version", masking REAL data-loss signals.
  // Emit the region straight from live (which equals target); no conflict.
  if (a.length === b.length && a.every((v, i) => v === b[i])) {
    return a.map((_v, i) => ({ src: 'live', local: i }) as LocalPick);
  }

  const aHunks = buildHunks(o, a);
  const bHunks = buildHunks(o, b);

  // Any overlap between a human hunk and a git hunk is a real conflict; bail so
  // the caller falls back to git-wins (preserving the original behavior).
  for (const ah of aHunks) {
    for (const bh of bHunks) {
      if (hunksOverlap(ah, bh)) return null;
    }
  }

  // Disjoint: live index of each base block that BOTH sides kept (stable).
  const aKept = matchMap(lcsPairs(o, a)); // base index -> live index

  const out: LocalPick[] = [];
  let pa = 0;
  let pb = 0;
  let oi = 0;
  while (oi < o.length || pa < aHunks.length || pb < bHunks.length) {
    const ah = pa < aHunks.length ? aHunks[pa] : null;
    const bh = pb < bHunks.length ? bHunks[pb] : null;
    const nextStart = Math.min(
      ah ? ah.oStart : o.length,
      bh ? bh.oStart : o.length,
    );

    // Emit stable base blocks (kept by both) until the next hunk, from LIVE.
    while (oi < nextStart) {
      out.push({ src: 'live', local: aKept.get(oi) as number });
      oi++;
    }
    if (!ah && !bh) break;

    // Apply the hunk at oi. When both sides act here they are disjoint, so the
    // pure-insert (oEnd === oi) is emitted before the side that consumes base oi.
    const aHere = ah !== null && ah.oStart === oi;
    const bHere = bh !== null && bh.oStart === oi;
    let useA: boolean;
    if (aHere && bHere) {
      useA = ah!.oEnd === oi; // insert side first; otherwise either order is fine
    } else {
      useA = aHere;
    }
    const h = (useA ? ah : bh) as Hunk;
    const src: 'live' | 'target' = useA ? 'live' : 'target';
    for (const idx of h.content) out.push({ src, local: idx });
    oi = h.oEnd;
    if (useA) pa++;
    else pb++;
  }
  return out;
}

export interface Pick {
  src: 'live' | 'target';
  index: number;
}

/**
 * The merged block order PLUS how many regions resolved as a genuine SAME-BLOCK
 * conflict (both sides rewrote the same base block — `tryMergeRegion` returned
 * null and git won the whole region, so the live/human version of those blocks
 * is NOT in `picks`). `conflicts > 0` is the OBSERVABLE signal the caller uses to
 * surface "git won a concurrent same-block edit" (log it + pin the human
 * baseline to page history) instead of dropping the human side silently.
 */
export interface Diff3Result {
  picks: Pick[];
  conflicts: number;
}

/**
 * Three-way merge of base `o`, live `a`, target `b` (arrays of block keys).
 * Returns the merged block order as picks from live/target. Thin wrapper over
 * `diff3PlanWithConflicts` (kept for the existing pure-array callers/tests).
 */
export function diff3Plan(o: string[], a: string[], b: string[]): Pick[] {
  return diff3PlanWithConflicts(o, a, b).picks;
}

/**
 * Like `diff3Plan` but also reports the SAME-BLOCK conflict count (see
 * `Diff3Result`). A region where both the human and git rewrote the same base
 * block cannot be merged automatically; the rule is deterministic — GIT WINS the
 * whole region — but the human's version of those blocks is then absent from the
 * picks, so we count it so the caller can make the loss observable/recoverable
 * rather than silent (the documented conflict contract).
 */
export function diff3PlanWithConflicts(
  o: string[],
  a: string[],
  b: string[],
): Diff3Result {
  const oToA = matchMap(lcsPairs(o, a));
  const oToB = matchMap(lcsPairs(o, b));

  const res: Pick[] = [];
  let conflicts = 0;
  let oi = 0;
  let ai = 0;
  let bi = 0;

  for (;;) {
    // Next anchor: a base block present (unchanged) in BOTH live and target.
    let anchor = oi;
    while (anchor < o.length && !(oToA.has(anchor) && oToB.has(anchor))) {
      anchor++;
    }
    const aEnd = anchor < o.length ? (oToA.get(anchor) as number) : a.length;
    const bEnd = anchor < o.length ? (oToB.get(anchor) as number) : b.length;

    // Resolve the region [oi,anchor) that one or both sides rewrote/inserted.
    // Try a fine-grained three-way merge first so a human block-edit survives a
    // git insert/delete of OTHER blocks in the same region; only a genuine
    // same-block conflict (null) falls back to the original git-wins rule.
    const merged = tryMergeRegion(
      o.slice(oi, anchor),
      a.slice(ai, aEnd),
      b.slice(bi, bEnd),
    );
    if (merged) {
      for (const p of merged) {
        res.push(
          p.src === 'live'
            ? { src: 'live', index: ai + p.local }
            : { src: 'target', index: bi + p.local },
        );
      }
    } else {
      // SAME-BLOCK CONFLICT: count it ONLY when the human side actually had
      // content in this region that git's win discards (live region non-empty).
      // A region only git rewrote (live region empty) is not a human loss.
      if (aEnd > ai) conflicts++;
      for (let k = bi; k < bEnd; k++) res.push({ src: 'target', index: k });
    }

    if (anchor >= o.length) break;

    // Emit the stable anchor block from LIVE, then advance past it on all sides.
    res.push({ src: 'live', index: aEnd });
    ai = aEnd + 1;
    bi = bEnd + 1;
    oi = anchor + 1;
  }

  return { picks: res, conflicts };
}
