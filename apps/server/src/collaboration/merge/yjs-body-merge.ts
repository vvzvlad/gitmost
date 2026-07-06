import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';

import { tiptapExtensions } from '../collaboration.util';
import { diff3PlanWithConflicts } from './three-way-merge';
import { buildLcsTable } from './lcs';

/**
 * Block-level merge of an incoming (git) page body into a LIVE Yjs document,
 * replacing the previous full-body "delete everything + re-insert" write that
 * clobbered concurrent human edits on every sync (review #5 — "do the write as a
 * merge").
 *
 * Strategy: diff the two documents at TOP-LEVEL BLOCK granularity (an LCS over a
 * canonical structural serialization of each block) and apply only the minimal
 * insert/delete operations. Blocks that are byte-identical on both sides are
 * left UNTOUCHED in the live doc — so a human editing one paragraph is unaffected
 * when git changes a different paragraph, and an unchanged re-sync is a complete
 * no-op (zero Yjs operations). Yjs then CRDT-merges the minimal ops with any
 * concurrent edits.
 *
 * Merge mode: a THREE-WAY merge (live vs incoming vs base) runs whenever the
 * engine plumbs the last-synced base (`baseMarkdown` from refs/docmost/last-pushed)
 * — which it now does end-to-end — so a block both sides changed is a genuine
 * conflict resolved deterministically (git wins that block; the prior state is
 * preserved in page history). Only when NO base is available (a brand-new file)
 * does it fall back to a 2-way merge (live vs incoming). Common cases — unchanged
 * resync and edits to DIFFERENT blocks — are lossless in both modes.
 */

type XmlNode = Y.XmlElement | Y.XmlText | Y.XmlHook;

/**
 * Node attributes that are VOLATILE identity (not content) and so must be
 * excluded from the block comparison key.
 *
 * `id` is the per-block UniqueID the editor stamps on every heading/paragraph
 * (and transclusionSource). It exists ONLY in the live Yjs document — a body
 * arriving from git is parsed from clean markdown, which carries no block ids
 * (`markdownToProseMirror` materializes `id: null`, which the Yjs transform then
 * drops). If `id` were part of the key, an UNCHANGED live block (id "abc123")
 * would never match the SAME block coming from git (no id), so the three-way
 * merge's LCS could not anchor on it. The merge would then treat every live
 * block as deleted-and-reinserted and, when an incoming block has no matching
 * anchor (e.g. content inserted at the very TOP of the page), RE-ADD a copy of
 * it on every sync cycle — a non-convergent, unbounded duplication loop
 * (start-of-document content duplicating each push/pull cycle).
 *
 * Excluding `id` makes blocks compare by CONTENT, so an unchanged block matches
 * across the git round-trip and the reconciliation is idempotent. Block identity
 * is still preserved in the merged output: `diff3Plan` keeps the LIVE block
 * INSTANCE (with its id) for an anchor — picks are by index, not by key — so the
 * stable Yjs block (and any in-flight human edit on it) stays put. This mirrors
 * `canonicalize.ts`, which already strips the regenerated block `id` from the
 * round-trip idempotency comparison for exactly the same reason.
 *
 * Known limitation (accepted trade-off of content-based matching): two GENUINELY
 * DISTINCT blocks whose content is byte-identical now collapse to the same content
 * key, so when git deletes one of the duplicates the LCS may drop the OTHER live
 * instance instead. The visible result is identical (one copy removed, one kept),
 * but a concurrent in-flight human edit on the dropped instance could be lost.
 */
const VOLATILE_KEY_ATTRS = new Set(['id']);

/**
 * The editor (ProseMirror) schema, built ONCE from the same `tiptapExtensions`
 * the collaboration server uses to materialize Yjs docs. Memoized: building the
 * schema is non-trivial and the block key is computed per block per cycle.
 *
 * Why the schema (not a hardcoded denylist): the LIVE Yjs document is produced by
 * `TiptapTransformer.toYdoc(pm, 'default', tiptapExtensions)`, which STAMPS every
 * schema-default attribute onto every node and mark — `indent: 0` on every
 * paragraph/heading, `image.align: "center"`, the link mark's `internal: false`,
 * `highlight.colorName: null`, and so on for youtube/pdf/any future node. A body
 * re-imported from git comes through the engine's `markdownToProseMirror`, whose
 * schema declares those attrs with DIFFERENT (usually null) defaults; the
 * resulting null/absent element attrs are then DROPPED by `y-prosemirror`'s
 * toYdoc. So the SAME block carries materialized defaults on the live side and
 * nothing on the git side, its key diverges, the three-way merge anchors on
 * NOTHING, and the whole body is RE-APPENDED every reconcile cycle — an unbounded
 * duplication loop with no client connected.
 *
 * Deriving the defaults from the actual schema normalizes ALL such attributes
 * generally (it is not another per-attribute denylist): any attribute whose value
 * equals the schema default — or is null/undefined — is dropped from the key, on
 * BOTH element attributes and the mark attributes inside each XmlText delta, so a
 * live block compares equal to its git-round-tripped twin and an unchanged resync
 * applies zero ops. Genuinely non-default values (a real `indent: 2`, an
 * `align: "left"`, a real `link.href`, a real highlight color) are content and
 * stay in the key, so real edits still diff and land.
 */
let memoSchema: Schema | null = null;
let memoSchemaTried = false;
function getMergeSchema(): Schema | null {
  if (!memoSchemaTried) {
    memoSchemaTried = true;
    try {
      memoSchema = getSchema(tiptapExtensions as any);
    } catch {
      // Defensive: if the schema can't be built (e.g. a degenerate extension
      // set in a unit test that stubs `tiptapExtensions`), fall back to dropping
      // only null/undefined attrs. The real server always builds it fine.
      memoSchema = null;
    }
  }
  return memoSchema;
}

/** True if `value` is the schema default for `attrName` of `attrSpecs`, or is
 * null/undefined (which a git round-trip drops). Such attributes are excluded
 * from the comparison key. `attrSpecs` is a ProseMirror node/mark spec attr map
 * (`{ [name]: { default } }`); a missing map (unknown node/mark) only drops
 * null/undefined. (A non-null value matching an attr declared without a default
 * cannot occur — `spec.default === value` is then `undefined === value`, false.) */
function isDefaultAttr(
  attrSpecs: Record<string, any> | undefined | null,
  attrName: string,
  value: unknown,
): boolean {
  if (value === null || value === undefined) return true;
  const spec = attrSpecs?.[attrName];
  return !!spec && spec.default === value;
}

/**
 * Normalize one XmlText delta op's mark attributes: drop every mark-attr whose
 * value equals the mark's schema default (or is null/undefined), so the link
 * mark's materialized `internal: false`/`target: "_blank"` and a highlight's
 * `colorName: null` no longer diverge from a git round-trip that carries neither.
 * The text (op.insert) and genuinely-set mark attrs (a real `href`, a real
 * highlight color) are preserved verbatim. `attributes` maps markName -> mark
 * attrs object (or `true`/boolean for attr-less marks); each is handled safely.
 */
function normalizeDelta(delta: any[]): any[] {
  const schema = getMergeSchema();
  return delta.map((op) => {
    if (!op || op.attributes == null || typeof op.attributes !== 'object') {
      return op;
    }
    const marks: Record<string, unknown> = {};
    for (const markName of Object.keys(op.attributes).sort()) {
      const markVal = op.attributes[markName];
      if (markVal === null || markVal === undefined) continue;
      if (typeof markVal !== 'object') {
        // attr-less mark stored as a primitive (e.g. `true`) — keep as-is.
        marks[markName] = markVal;
        continue;
      }
      const markSpec = schema?.marks[markName]?.spec.attrs as
        | Record<string, any>
        | undefined;
      const cleaned: Record<string, unknown> = {};
      for (const ak of Object.keys(markVal as object).sort()) {
        const av = (markVal as Record<string, unknown>)[ak];
        if (isDefaultAttr(markSpec, ak, av)) continue;
        cleaned[ak] = av;
      }
      marks[markName] = cleaned;
    }
    return { ...op, attributes: marks };
  });
}

/**
 * Canonical, comparable serialization of a Yjs XML node (structure + text +
 * marks + attributes), with attribute keys sorted so equal blocks always produce
 * an identical string regardless of attribute insertion order. The volatile
 * block `id` (see `VOLATILE_KEY_ATTRS`) and every schema-default attribute (see
 * `getMergeSchema`) are excluded at every level — on element attributes AND on
 * the mark attributes inside each XmlText delta — so a block compares equal by
 * CONTENT across the git round-trip (which materializes neither), keeping the
 * merge anchor-able and idempotent.
 */
export function serializeXmlNode(node: unknown): unknown {
  if (node instanceof Y.XmlText) {
    return { t: normalizeDelta(node.toDelta()) };
  }
  if (node instanceof Y.XmlElement) {
    const attrs = node.getAttributes() as Record<string, unknown>;
    const attrSpecs = getMergeSchema()?.nodes[node.nodeName]?.spec.attrs as
      | Record<string, any>
      | undefined;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(attrs).sort()) {
      if (VOLATILE_KEY_ATTRS.has(k)) continue;
      if (isDefaultAttr(attrSpecs, k, attrs[k])) continue;
      sorted[k] = attrs[k];
    }
    return {
      n: node.nodeName,
      a: sorted,
      c: node.toArray().map(serializeXmlNode),
    };
  }
  // XmlHook / unknown: fall back to a stable string so it compares by identity
  // of its serialized form (these do not occur in the Docmost block schema).
  return { u: String(node) };
}

const key = (node: unknown): string => JSON.stringify(serializeXmlNode(node));

/**
 * Deep-clone a detached/owned Yjs XML node into a fresh node that can be inserted
 * into ANOTHER document (Yjs types are bound to their doc, so cross-doc moves are
 * impossible — we rebuild). Preserves nodeName, attributes, text+marks (via the
 * XmlText delta) and the full child subtree.
 */
export function cloneXmlNode(node: XmlNode): Y.XmlElement | Y.XmlText {
  if (node instanceof Y.XmlText) {
    const t = new Y.XmlText();
    const delta = node.toDelta();
    if (delta.length) t.applyDelta(delta);
    return t;
  }
  if (node instanceof Y.XmlElement) {
    const el = new Y.XmlElement(node.nodeName);
    const attrs = node.getAttributes() as Record<string, unknown>;
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k] as string);
    const kids = node.toArray().map((c) => cloneXmlNode(c as XmlNode));
    if (kids.length) el.insert(0, kids);
    return el;
  }
  // Best-effort for any other node type (XmlHook — does not occur in the
  // Docmost block schema): an empty paragraph so the merge never crashes.
  return new Y.XmlElement('paragraph');
}

type Op = { op: 'keep' } | { op: 'del' } | { op: 'ins'; bi: number };

/**
 * LCS-based edit script turning sequence `a` (live block keys) into `b` (incoming
 * block keys): a run of keep/del/ins ops. O(n*m) table — fine for page block
 * counts.
 */
export function diffBlocks(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = buildLcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'keep' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del' });
      i++;
    } else {
      ops.push({ op: 'ins', bi: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ op: 'del' });
    i++;
  }
  while (j < m) {
    ops.push({ op: 'ins', bi: j });
    j++;
  }
  return ops;
}

/**
 * Merge `target` block children into `live`, mutating `live` in place with the
 * minimal set of inserts/deletes. MUST be called inside a Yjs transaction.
 * Returns the number of block operations applied (0 == content already identical).
 */
export function mergeXmlFragments(
  live: Y.XmlFragment,
  target: Y.XmlFragment,
): number {
  const liveKids = live.toArray();
  const targetKids = target.toArray();
  const liveKeys = liveKids.map(key);
  const targetKeys = targetKids.map(key);

  const ops = diffBlocks(liveKeys, targetKeys);

  let cursor = 0; // index into the LIVE fragment as we mutate it
  let applied = 0;
  for (const op of ops) {
    if (op.op === 'keep') {
      cursor++;
    } else if (op.op === 'del') {
      live.delete(cursor, 1); // remove the live block at the cursor; do not advance
      applied++;
    } else {
      live.insert(cursor, [cloneXmlNode(targetKids[op.bi] as XmlNode)]);
      cursor++;
      applied++;
    }
  }
  return applied;
}

/** Outcome of a 3-way block merge: ops applied + same-block conflict count. */
export interface Merge3WayResult {
  /** Number of block insert/delete operations spliced into `live`. */
  applied: number;
  /**
   * Regions where the human AND git rewrote the SAME base block. The rule is
   * deterministic (GIT WINS the region), so the human's version of those blocks
   * is dropped from the live doc. `conflicts > 0` is the OBSERVABLE signal the
   * caller uses to LOG the loss and pin the human baseline to page history (so it
   * is recoverable), instead of the edit vanishing silently.
   */
  conflicts: number;
}

/**
 * THREE-WAY block merge: reconcile `live` toward `target` using `base` (the
 * last-synced common ancestor) so a block only the human changed is KEPT and a
 * block only git changed is taken — instead of git's version always winning
 * (review #5). Conflicts (both changed the same block) resolve to git.
 *
 * Implementation: diff3Plan computes the merged block ORDER (picks from live or
 * target); we materialize that as a virtual target fragment and reuse the 2-way
 * `mergeXmlFragments` to splice it into `live` minimally (so untouched live block
 * instances — and their in-flight edits — stay put). MUST be called inside a Yjs
 * transaction. Returns the number of block operations applied. (Use
 * `mergeXmlFragments3WayWithStats` when the SAME-BLOCK conflict count is needed.)
 */
export function mergeXmlFragments3Way(
  live: Y.XmlFragment,
  target: Y.XmlFragment,
  base: Y.XmlFragment,
): number {
  return mergeXmlFragments3WayWithStats(live, target, base).applied;
}

/**
 * As `mergeXmlFragments3Way`, but also returns the SAME-BLOCK conflict count so
 * the caller can make a "git won a concurrent same-block edit" event OBSERVABLE
 * (the documented conflict contract: git wins deterministically, but the losing
 * human content is never destroyed silently — it is logged and recoverable via
 * page history).
 */
export function mergeXmlFragments3WayWithStats(
  live: Y.XmlFragment,
  target: Y.XmlFragment,
  base: Y.XmlFragment,
): Merge3WayResult {
  const liveKids = live.toArray();
  const targetKids = target.toArray();
  const liveKeys = liveKids.map(key);
  const targetKeys = targetKids.map(key);
  const baseKeys = base.toArray().map(key);

  const { picks: plan, conflicts } = diff3PlanWithConflicts(
    baseKeys,
    liveKeys,
    targetKeys,
  );

  // Build the merged block sequence in a throwaway doc, cloning from whichever
  // side each pick came from, then 2-way merge it back into the live fragment.
  const merged = new Y.Doc();
  const mergedFrag = merged.getXmlFragment('default');
  const nodes = plan.map((p) =>
    cloneXmlNode(
      (p.src === 'live' ? liveKids[p.index] : targetKids[p.index]) as XmlNode,
    ),
  );
  if (nodes.length) mergedFrag.insert(0, nodes);

  return { applied: mergeXmlFragments(live, mergedFrag), conflicts };
}
