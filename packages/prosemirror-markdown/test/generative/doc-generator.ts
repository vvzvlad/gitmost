/**
 * Nested whole-document generator (#351, PR 2) — "variant A": a random walk over
 * the schema's ContentMatch automaton.
 *
 * Where the FLAT generator (node-generators.ts) emits `{doc:[ <one target> ]}`,
 * this module produces arbitrarily DEEP, valid ProseMirror documents. Validity is
 * NOT hand-asserted: it comes straight from the schema. To fill a container's
 * block content we start at `nodeType.contentMatch` and walk the automaton —
 * enumerate the legal next node types (`match.edge(i).type`), let fast-check pick
 * one (or STOP once `match.validEnd`), generate that child RECURSIVELY, then
 * advance the automaton via `match.matchType(childType)`. A bad walk therefore
 * cannot emit a structurally-invalid doc (the `generator validity` test guards
 * this with `schema.nodeFromJSON(json).check()`).
 *
 * ── What the walk drives, and what it delegates ──────────────────────────────
 * The walk owns BLOCK STRUCTURE (which blocks nest inside which containers, in
 * what order and how deep). Two things it deliberately delegates, to avoid
 * REGRESSING the byte-stable space the flat suite already proved empirically:
 *
 *   - INLINE content of textblocks (paragraph/heading/codeBlock/detailsSummary)
 *     is filled from text-arbitraries.ts — the exact hostile-but-byte-stable
 *     inline corpus the flat suite established. Walking the inline ContentMatch
 *     instead would re-derive (and re-fail) the text-space limitations the flat
 *     suite already pins, which is not this generator's job.
 *   - Node ATTRS come from nodeAttrsArb(type, 'p1') — the round-trip-safe
 *     attribute space. Attribute-degenerate fuzzing (P2/P3 over 'fuzz') is the
 *     flat suite's concern; the nested suite isolates STRUCTURAL round-trip, so
 *     it stays in 'p1' and does not re-litigate frozen/pinned attributes.
 *
 * ── Coordination the automaton cannot express ────────────────────────────────
 * A ContentMatch guarantees a child SEQUENCE is legal, but not cross-sibling
 * invariants. Two nodes need coordination the walk injects by hand:
 *   - `table`: GFM needs a RECTANGULAR grid with column-consistent alignment.
 *     The automaton happily allows ragged rows / per-cell align, which are not a
 *     converter bug — just a malformed table. So a table is generated ATOMICALLY
 *     (same shape the flat suite proved) rather than walked.
 *   - `columns`: the `layout` attr must agree with the column COUNT. We pick the
 *     layout, derive the count, then walk each column's block body normally — so
 *     columns still gain real nested content, only the count is coordinated.
 *
 * ── Excluded from the nested walk ────────────────────────────────────────────
 * Footnote nodes (footnoteReference / footnotesList / footnoteDefinition) need a
 * DOCUMENT-GLOBAL id match between a reference and its definition. That
 * coordination is owned by the flat suite's `footnotes` generator; placing them
 * independently here would fabricate id mismatches that look like converter bugs
 * but are generator defects. They are filtered out of the walk (documented in
 * EXCLUDED). The completeness contract lives in the FLAT suite and is unaffected.
 *
 * ── Termination / budgets ────────────────────────────────────────────────────
 * Two bounds keep every doc finite and the suite fast:
 *   - MAX_DEPTH — a hard cap on block-nesting depth. A precomputed `minDepth`
 *     fixpoint (the minimum extra nesting a subtree of each type needs to be
 *     valid) lets the walk pick a CONTAINER child only when there is depth
 *     headroom to complete it — so the walk can never paint itself into a corner
 *     where a required child cannot fit (no invalid docs, guaranteed termination).
 *   - NODE_BUDGET — a soft cap on total nodes; as it runs low the walk biases
 *     toward STOP (when validEnd) or toward cheap terminating children.
 */
import fc from 'fast-check';
import { getSchema } from '@tiptap/core';
import { docmostExtensions } from '../../src/lib/docmost-schema.js';
import { nodeAttrsArb } from './attr-arbitraries.js';
import {
  inlineContentArb,
  headingInlineContentArb,
  plainInlineContentArb,
  phraseArb,
} from './text-arbitraries.js';

/** The exact ProseMirror schema the converter targets (built per the issue). */
export const schema = getSchema(docmostExtensions as never);

/** Hard cap on block-nesting depth (doc = depth 0). Kept in the issue's 4–5 band. */
export const MAX_DEPTH = 4;
/**
 * Soft cap on total node count per generated document. Kept moderate: every P1/P2
 * run parses the emitted markdown through jsdom (heavy), so 100+ node docs across
 * hundreds of runs exhaust the worker heap. 60 still yields deeply-nested docs
 * (depth 4) while keeping the suite within memory.
 */
export const NODE_BUDGET = 60;

/**
 * Nodes kept OUT of the nested walk: footnote nodes need a doc-global id match a
 * local walk cannot coordinate (owned by the flat suite's `footnotes` generator).
 */
const EXCLUDED = new Set<string>([
  'footnoteReference',
  'footnotesList',
  'footnoteDefinition',
]);

/**
 * Structural-only children that carry `group: "block"` in the schema and so leak
 * into EVERY block container's ContentMatch, even though the editor only ever
 * places them inside their one true parent. Choosing them freely (e.g. a bare
 * `column` at the document root) fabricates documents no editor produces and that
 * the converter is not designed to round-trip — a GENERATOR artifact, not a
 * converter bug. They are admitted ONLY when the container being filled is their
 * dedicated parent. (`column` is in fact always built inside columnsArb, so this
 * just double-guards it.)
 */
const DEDICATED_PARENT: Record<string, string> = {
  column: 'columns',
  detailsSummary: 'details',
  detailsContent: 'details',
};

/** Is child type `t` legal as a freely-chosen child of container `parentType`? */
function childAllowedUnder(t: string, parentType: string): boolean {
  const dedicated = DEDICATED_PARENT[t];
  return dedicated === undefined || dedicated === parentType;
}

/** Textblock (inlineContent) types — filled from the proven inline corpus. */
function isTextblock(typeName: string): boolean {
  return !!schema.nodes[typeName]?.isTextblock;
}
/** Leaf/atom types — no content, only generated attrs. */
function isLeaf(typeName: string): boolean {
  return !!schema.nodes[typeName]?.isLeaf;
}

// ---------------------------------------------------------------------------
// minDepth fixpoint: the minimum EXTRA block-nesting depth a valid subtree
// rooted at each node type requires. Leaves and textblocks need 0 (a textblock
// is satisfied by inline content, no block recursion). A container needs
// 1 + the cheapest way to satisfy its ContentMatch. Computed as a min–max path
// to `validEnd` over the automaton, iterated to a fixpoint over node types.
// ---------------------------------------------------------------------------

/** Cheapest (min over reachable validEnd of max child minDepth) to complete a match. */
function minCompletion(
  match: any,
  md: Record<string, number>,
  seen: Set<any>,
  parentType: string,
): number {
  let best = match.validEnd ? 0 : Infinity;
  if (seen.has(match)) return best; // a cycle never completes more cheaply
  seen.add(match);
  for (let i = 0; i < match.edgeCount; i++) {
    const edge = match.edge(i);
    const t = edge.type.name;
    if (EXCLUDED.has(t) || t === 'text') continue;
    if (!childAllowedUnder(t, parentType)) continue;
    const childCost = md[t];
    if (childCost === undefined || childCost === Infinity) continue;
    const rest = minCompletion(edge.next, md, seen, parentType);
    if (rest === Infinity) continue;
    best = Math.min(best, Math.max(childCost, rest));
  }
  seen.delete(match);
  return best;
}

function computeMinDepth(): Record<string, number> {
  const md: Record<string, number> = {};
  for (const name of Object.keys(schema.nodes)) {
    md[name] = isLeaf(name) || isTextblock(name) ? 0 : Infinity;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of Object.keys(schema.nodes)) {
      if (md[name] === 0) continue; // leaves/textblocks fixed at 0
      const nt: any = schema.nodes[name];
      const completion = minCompletion(nt.contentMatch, md, new Set(), name);
      const next = completion === Infinity ? Infinity : 1 + completion;
      if (next < md[name]) {
        md[name] = next;
        changed = true;
      }
    }
  }
  return md;
}

const MIN_DEPTH = computeMinDepth();

// ---------------------------------------------------------------------------
// Leaf / textblock builders (attrs from 'p1', inline from the proven corpus).
// ---------------------------------------------------------------------------

function attachAttrs(typeName: string, base: Record<string, unknown> = {}) {
  return nodeAttrsArb(typeName, 'p1', base).map((attrs) => {
    const node: any = { type: typeName };
    if (Object.keys(attrs).length) node.attrs = attrs;
    return node;
  });
}

/** A leaf/atom block: attrs only, no content. */
function leafArb(typeName: string): fc.Arbitrary<any> {
  return attachAttrs(typeName);
}

/** A textblock, inline content taken from the byte-stable flat corpus. */
function textblockArb(typeName: string): fc.Arbitrary<any> {
  if (typeName === 'codeBlock') {
    return fc
      .tuple(
        nodeAttrsArb('codeBlock', 'p1'),
        // Fenced code re-imports with a TRAILING NEWLINE (flat suite finding);
        // author it so the doc is already at the round-trip fixpoint.
        fc.array(phraseArb, { minLength: 1, maxLength: 3 }).map((l) => l.join('\n') + '\n'),
      )
      .map(([attrs, code]) => ({
        type: 'codeBlock',
        ...(Object.keys(attrs).length ? { attrs } : {}),
        content: [{ type: 'text', text: code }],
      }));
  }
  const inline =
    typeName === 'heading'
      ? headingInlineContentArb
      : typeName === 'detailsSummary'
        ? plainInlineContentArb
        : inlineContentArb;
  return fc
    .tuple(nodeAttrsArb(typeName, 'p1'), inline)
    .map(([attrs, content]) => ({
      type: typeName,
      ...(Object.keys(attrs).length ? { attrs } : {}),
      content,
    }));
}

// ---------------------------------------------------------------------------
// Coordinated builders: table (atomic, rectangular, column-consistent align)
// and columns (layout coupled to count, bodies walked).
// ---------------------------------------------------------------------------

/** A rectangular GFM-safe table (mirrors the flat suite's proven shape). */
function tableArb(): fc.Arbitrary<any> {
  return fc.integer({ min: 1, max: 3 }).chain((cols) => {
    // One alignment per COLUMN, identical on header + every body cell, so the
    // second export cannot re-align and churn.
    const alignsArb = fc.array(fc.constantFrom(undefined, 'left', 'center', 'right'), {
      minLength: cols,
      maxLength: cols,
    });
    const cell = (header: boolean, align?: string) =>
      phraseArb.map((t) => ({
        type: header ? 'tableHeader' : 'tableCell',
        attrs: { colspan: 1, rowspan: 1, ...(align ? { align } : {}) },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
      }));
    return alignsArb.chain((aligns) => {
      const headerRow = fc
        .tuple(...aligns.map((a) => cell(true, a)))
        .map((cells) => ({ type: 'tableRow', content: cells }));
      const bodyRow = fc
        .tuple(...aligns.map((a) => cell(false, a)))
        .map((cells) => ({ type: 'tableRow', content: cells }));
      return fc
        .tuple(headerRow, fc.array(bodyRow, { minLength: 1, maxLength: 2 }))
        .map(([h, body]) => ({ type: 'table', content: [h, ...body] }));
    });
  });
}

/** A columns block: layout ↔ count coupled, each column body walked as blocks. */
function columnsArb(depth: number, budget: number): fc.Arbitrary<any> {
  return fc
    .constantFrom('two_equal', 'three_equal', 'left_sidebar', 'right_sidebar')
    .chain((layout) => {
      const count = layout === 'three_equal' ? 3 : 2;
      const columnType: any = schema.nodes.column;
      // Split the remaining budget across the fixed number of columns.
      const per = Math.max(2, Math.floor((budget - 1) / count));
      return nodeAttrsArb('columns', 'p1', { layout, widthMode: 'normal' }).chain((attrs) =>
        fc
          .tuple(
            ...Array.from({ length: count }, () =>
              fillMatch(columnType.contentMatch, depth + 1, per, 'column').map(({ children }) => ({
                type: 'column',
                content: children,
              })),
            ),
          )
          .map((cols) => ({ type: 'columns', attrs, content: cols })),
      );
    });
}

// ---------------------------------------------------------------------------
// The ContentMatch walk.
// ---------------------------------------------------------------------------

/** Count every node in a subtree (block + inline), for budget accounting. */
function countNodes(node: any): number {
  let n = 1;
  for (const c of node.content ?? []) n += countNodes(c);
  return n;
}

/** Build a single child node of a given type at `depth`, within `budget`. */
function blockNode(typeName: string, depth: number, budget: number): fc.Arbitrary<any> {
  if (typeName === 'table') return tableArb();
  if (typeName === 'columns') return columnsArb(depth, budget);
  if (isTextblock(typeName)) return textblockArb(typeName);
  if (isLeaf(typeName)) return leafArb(typeName);
  // Generic container: attrs from 'p1', block content from the automaton walk.
  const nt: any = schema.nodes[typeName];
  return nodeAttrsArb(typeName, 'p1').chain((attrs) =>
    fillMatch(nt.contentMatch, depth, budget - 1, typeName).map(({ children }) => {
      const node: any = { type: typeName };
      if (Object.keys(attrs).length) node.attrs = attrs;
      if (children.length) node.content = children;
      return node;
    }),
  );
}

/**
 * Fill a container's block content by walking its ContentMatch automaton from
 * `match`. Returns the children array plus the budget left after them.
 */
function fillMatch(
  match: any,
  depth: number,
  budget: number,
  parentType: string,
): fc.Arbitrary<{ children: any[]; budget: number }> {
  const canStop = match.validEnd;
  // A child lives at depth+1; only pick it if its subtree can complete within
  // MAX_DEPTH. This headroom rule is what makes the walk deadlock-free.
  const headroom = MAX_DEPTH - (depth + 1);
  const edges: { t: string; next: any }[] = [];
  if (headroom >= 0) {
    for (let i = 0; i < match.edgeCount; i++) {
      const edge = match.edge(i);
      const t = edge.type.name;
      if (EXCLUDED.has(t) || t === 'text') continue;
      if (!childAllowedUnder(t, parentType)) continue;
      if ((MIN_DEPTH[t] ?? Infinity) > headroom) continue;
      edges.push({ t, next: edge.next });
    }
  }

  // Decide the next action: STOP (if allowed) or extend with one more child.
  // Bias toward stopping when the budget is spent; force a child only when the
  // match is not yet at a valid end.
  const pool: { weight: number; arbitrary: fc.Arbitrary<{ t: string; next: any } | null> }[] = [];
  const canGo = edges.length > 0 && (budget > 0 || !canStop);
  if (canStop) {
    // Stop is weighted higher when the budget is low so docs stay bounded.
    pool.push({ weight: budget > 0 ? 2 : 5, arbitrary: fc.constant(null) });
  }
  if (canGo && !(canStop && budget <= 0)) {
    pool.push({ weight: 3, arbitrary: fc.constantFrom(...edges) });
  }
  // Forced continuation: not a valid end yet and (budget exhausted) — must place
  // a mandatory child regardless of budget.
  if (pool.length === 0) {
    if (edges.length > 0) {
      pool.push({ weight: 1, arbitrary: fc.constantFrom(...edges) });
    } else {
      // No legal child and not required to place one: stop with what we have.
      return fc.constant({ children: [], budget });
    }
  }

  return fc.oneof(...pool).chain((choice) => {
    if (choice === null) return fc.constant({ children: [], budget });
    return blockNode(choice.t, depth + 1, budget).chain((node) => {
      const cost = countNodes(node);
      return fillMatch(choice.next, depth, budget - cost, parentType).map(
        ({ children, budget: left }) => ({
          children: [node, ...children],
          budget: left,
        }),
      );
    });
  });
}

/**
 * The nested-document arbitrary: a valid, arbitrarily-deep ProseMirror doc built
 * by walking the schema from the document root. Attrs stay in the round-trip-safe
 * 'p1' space; inline content reuses the byte-stable flat corpus.
 */
export const docArb: fc.Arbitrary<any> = fillMatch(
  schema.nodes.doc.contentMatch,
  0,
  NODE_BUDGET,
  'doc',
).map(({ children }) => ({ type: 'doc', content: children }));

/** The precomputed minDepth table, exported for inspection/debugging. */
export { MIN_DEPTH };
