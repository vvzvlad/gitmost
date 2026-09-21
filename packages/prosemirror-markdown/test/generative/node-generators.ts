/**
 * Flat single-node document generators (#351, PR 1).
 *
 * For every schema node type that can stand alone, a fast-check arbitrary
 * producing `{ type:'doc', content:[ <the target node> ] }` with generated attrs
 * (via nodeAttrsArb) and the minimal REQUIRED immediate children the schema
 * demands (a heading's inline text, a listItem's one paragraph, a table's
 * minimal rows, details' summary+content, a callout's one paragraph). Kept
 * FLAT: a single target node, no deep nesting — nested structural generation is
 * PR 2.
 *
 * The `mode` threads through to the attribute arbitraries:
 *   - 'p1'   : the round-trip-safe attribute space (P1 semantic round-trip).
 *   - 'fuzz' : adds degenerate attribute states (P2 byte-fixpoint tolerates the
 *              one-time normalization; P3 only needs totality).
 *
 * A COMPLETENESS CONTRACT (see flat-roundtrip.property.test.ts) enumerates the
 * whole schema and asserts every node/mark is EITHER produced by a generator
 * here OR listed in KNOWN_UNCOVERED with a reason — so a new schema type with no
 * generator turns the suite RED.
 */
import fc from 'fast-check';
import { type AttrMode, nodeAttrsArb } from './attr-arbitraries.js';
import {
  inlineContentArb,
  headingInlineContentArb,
  plainInlineContentArb,
  phraseArb,
  markedTextRunArb,
} from './text-arbitraries.js';

const doc = (node: any) => ({ type: 'doc', content: [node] });
const para = (content: any[]) => ({ type: 'paragraph', content });

/**
 * CORPUS GUARDRAIL — an inline `code` run inside a FOOTNOTE BODY may not contain
 * `[` or `]`.
 *
 * A footnote body is serialized INLINE as `^[…]`, and the importer's tokenizer
 * finds the closing `]` by counting brackets — it is blind to code spans. So the
 * serializer must escape a stray bracket in the body (`balanceBrackets`), or the
 * footnote does not parse at all. But a code span's content is LITERAL on import
 * (marked never decodes escapes inside backticks), so the `\` of that escape
 * survives into the text: `` `a [ 0` `` comes back as `` `a \[ 0` ``. The run's
 * TEXT silently mutates on every git-sync cycle.
 *
 * This is a PRE-EXISTING converter bug, NOT a #515 regression: the serializer on
 * `gitea/develop` produces the identical corrupted `` `a \[ 0` `` for a doc whose
 * code run carries NO other mark (a shape that has always been expressible). It
 * is pinned as a documented `it.fails` repro in markdown-converter-gaps.test.ts
 * ("footnote body + inline code + bracket"); fixing it means changing the
 * footnote canon (the bracket cannot simply be left raw — that breaks the
 * footnote parse outright), which is out of scope here.
 *
 * The corpus previously dodged this only by luck of the seed. Excluding the shape
 * keeps the generative properties honest about the SUPPORTED space instead of
 * flaking on a known, separately-tracked gap.
 */
const withoutBracketsInCodeRuns = (n: any): any => {
  if (n?.type !== 'text') return n;
  if (!(n.marks || []).some((m: any) => m.type === 'code')) return n;
  return { ...n, text: String(n.text ?? '').replace(/[[\]]/g, '(') };
};

/** A named flat-document generator. */
export interface NamedGen {
  name: string;
  arb: fc.Arbitrary<any>;
}

// ---------------------------------------------------------------------------
// Per-target generators, each a function of mode.
// ---------------------------------------------------------------------------

const gen = {
  paragraph: (m: AttrMode) =>
    fc.tuple(nodeAttrsArb('paragraph', m), inlineContentArb).map(([attrs, content]) =>
      doc({ type: 'paragraph', attrs, content }),
    ),

  heading: (m: AttrMode) =>
    fc.tuple(nodeAttrsArb('heading', m), headingInlineContentArb).map(([attrs, content]) =>
      doc({ type: 'heading', attrs, content }),
    ),

  blockquote: (_m: AttrMode) =>
    inlineContentArb.map((content) => doc({ type: 'blockquote', content: [para(content)] })),

  bulletList: (_m: AttrMode) =>
    fc
      .array(inlineContentArb, { minLength: 1, maxLength: 3 })
      .map((items) =>
        doc({
          type: 'bulletList',
          content: items.map((c) => ({ type: 'listItem', content: [para(c)] })),
        }),
      ),

  orderedList: (m: AttrMode) =>
    fc
      .tuple(nodeAttrsArb('orderedList', m), fc.array(inlineContentArb, { minLength: 1, maxLength: 3 }))
      .map(([attrs, items]) =>
        doc({
          type: 'orderedList',
          attrs,
          content: items.map((c) => ({ type: 'listItem', content: [para(c)] })),
        }),
      ),

  taskList: (m: AttrMode) =>
    fc
      .array(fc.tuple(nodeAttrsArb('taskItem', m), inlineContentArb), { minLength: 1, maxLength: 3 })
      .map((items) =>
        doc({
          type: 'taskList',
          content: items.map(([attrs, c]) => ({ type: 'taskItem', attrs, content: [para(c)] })),
        }),
      ),

  codeBlock: (m: AttrMode) =>
    fc
      .tuple(
        nodeAttrsArb('codeBlock', m),
        // A fenced code block always re-imports with a TRAILING NEWLINE in its
        // text (empirically confirmed). Author the newline so the doc is already
        // at the round-trip fixpoint (supported-space shaping, not a masked bug).
        fc.array(phraseArb, { minLength: 1, maxLength: 3 }).map((lines) => lines.join('\n') + '\n'),
      )
      .map(([attrs, code]) =>
        doc({ type: 'codeBlock', attrs, content: [{ type: 'text', text: code }] }),
      ),

  horizontalRule: (_m: AttrMode) => fc.constant(doc({ type: 'horizontalRule' })),

  pageBreak: (_m: AttrMode) => fc.constant(doc({ type: 'pageBreak' })),

  image: (m: AttrMode) => nodeAttrsArb('image', m).map((attrs) => doc({ type: 'image', attrs })),

  callout: (m: AttrMode) =>
    fc.tuple(nodeAttrsArb('callout', m), inlineContentArb).map(([attrs, content]) =>
      doc({ type: 'callout', attrs, content: [para(content)] }),
    ),

  mathBlock: (m: AttrMode) =>
    nodeAttrsArb('mathBlock', m).map((attrs) => doc({ type: 'mathBlock', attrs })),

  details: (m: AttrMode) =>
    fc
      .tuple(nodeAttrsArb('details', m), plainInlineContentArb, inlineContentArb)
      .map(([attrs, summary, body]) =>
        doc({
          type: 'details',
          attrs,
          content: [
            { type: 'detailsSummary', content: summary },
            { type: 'detailsContent', content: [para(body)] },
          ],
        }),
      ),

  table: (_m: AttrMode) =>
    fc.integer({ min: 1, max: 3 }).chain((cols) => {
      // GFM alignment is column-wide (encoded in the header separator), so a
      // column's alignment must be identical on the header and every body cell,
      // else the second export re-aligns and churns. Pick ONE align per column.
      const alignsArb = fc.array(fc.constantFrom(undefined, 'left', 'center', 'right'), {
        minLength: cols,
        maxLength: cols,
      });
      const cell = (header: boolean, align?: string) =>
        phraseArb.map((t) => ({
          type: header ? 'tableHeader' : 'tableCell',
          // colspan/rowspan pinned to 1 (GFM cannot express spans); optional
          // column-consistent align.
          attrs: { colspan: 1, rowspan: 1, ...(align ? { align } : {}) },
          content: [para([{ type: 'text', text: t }])],
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
          .map(([h, body]) => doc({ type: 'table', content: [h, ...body] }));
      });
    }),

  columns: (m: AttrMode) =>
    // Couple the column count to the layout so the two stay consistent
    // (two_equal/left_sidebar/right_sidebar -> 2, three_equal -> 3).
    fc
      .constantFrom('two_equal', 'three_equal', 'left_sidebar', 'right_sidebar')
      .chain((layout) => {
        const count = layout === 'three_equal' ? 3 : 2;
        return fc
          .tuple(
            nodeAttrsArb('columns', m, { layout, widthMode: 'normal' }),
            fc.array(inlineContentArb, { minLength: count, maxLength: count }),
          )
          .map(([attrs, bodies]) =>
            doc({
              type: 'columns',
              attrs,
              content: bodies.map((c) => ({ type: 'column', content: [para(c)] })),
            }),
          );
      }),

  subpages: (m: AttrMode) =>
    nodeAttrsArb('subpages', m).map((attrs) => doc({ type: 'subpages', attrs })),

  audio: (m: AttrMode) => nodeAttrsArb('audio', m).map((attrs) => doc({ type: 'audio', attrs })),
  video: (m: AttrMode) => nodeAttrsArb('video', m).map((attrs) => doc({ type: 'video', attrs })),
  pdf: (m: AttrMode) => nodeAttrsArb('pdf', m).map((attrs) => doc({ type: 'pdf', attrs })),
  youtube: (m: AttrMode) => nodeAttrsArb('youtube', m).map((attrs) => doc({ type: 'youtube', attrs })),
  embed: (m: AttrMode) => nodeAttrsArb('embed', m).map((attrs) => doc({ type: 'embed', attrs })),
  drawio: (m: AttrMode) => nodeAttrsArb('drawio', m).map((attrs) => doc({ type: 'drawio', attrs })),
  excalidraw: (m: AttrMode) =>
    nodeAttrsArb('excalidraw', m).map((attrs) => doc({ type: 'excalidraw', attrs })),
  attachment: (m: AttrMode) =>
    nodeAttrsArb('attachment', m).map((attrs) => doc({ type: 'attachment', attrs })),
  htmlEmbed: (m: AttrMode) =>
    nodeAttrsArb('htmlEmbed', m).map((attrs) => doc({ type: 'htmlEmbed', attrs })),
  pageEmbed: (m: AttrMode) =>
    nodeAttrsArb('pageEmbed', m).map((attrs) => doc({ type: 'pageEmbed', attrs })),
  transclusionReference: (m: AttrMode) =>
    nodeAttrsArb('transclusionReference', m).map((attrs) =>
      doc({ type: 'transclusionReference', attrs }),
    ),

  transclusionSource: (m: AttrMode) =>
    fc.tuple(nodeAttrsArb('transclusionSource', m), inlineContentArb).map(([attrs, content]) =>
      doc({ type: 'transclusionSource', attrs, content: [para(content)] }),
    ),

  // A footnote reference PLUS its definition (the reference has no standalone
  // markdown form without its definition — see KNOWN_UNCOVERED note for the
  // bare reference). Both carry the same id. The definition body uses
  // headingInlineContentArb (NO hard breaks): a footnote is serialized inline as
  // `^[...]`, so a hard break inside it collapses to a single space on re-parse
  // (empirically confirmed) — that is the container's markdown limitation, not
  // an attribute-level concern. The reference-bearing paragraph is a NORMAL
  // paragraph and keeps the full inline corpus.
  footnotes: (m: AttrMode) =>
    fc.tuple(fc.constantFrom('fn1', 'fn2', 'note'), inlineContentArb, headingInlineContentArb).map(
      ([id, refText, noteBody]) => ({
        type: 'doc',
        content: [
          para([...refText, { type: 'footnoteReference', attrs: { id } }]),
          {
            type: 'footnotesList',
            content: [
              {
                type: 'footnoteDefinition',
                attrs: { id },
                content: [para(noteBody.map(withoutBracketsInCodeRuns))],
              },
            ],
          },
        ],
      }),
    ),

  // ── inline targets wrapped in a paragraph ────────────────────────────────
  mention: (m: AttrMode) =>
    nodeAttrsArb('mention', m).map((attrs) => doc(para([{ type: 'mention', attrs }]))),

  mathInline: (m: AttrMode) =>
    fc.tuple(phraseArb, nodeAttrsArb('mathInline', m)).map(([t, attrs]) =>
      doc(para([{ type: 'text', text: t }, { type: 'mathInline', attrs }])),
    ),

  status: (m: AttrMode) =>
    nodeAttrsArb('status', m).map((attrs) => doc(para([{ type: 'status', attrs }]))),

  hardBreak: (_m: AttrMode) =>
    fc.tuple(phraseArb, phraseArb).map(([a, b]) =>
      doc(para([{ type: 'text', text: a }, { type: 'hardBreak' }, { type: 'text', text: b }])),
    ),

  // ── marks: a paragraph of marked runs (covers every mark type) ───────────
  marksOnText: (_m: AttrMode) =>
    fc.array(markedTextRunArb, { minLength: 1, maxLength: 5 }).map((runs) => {
      // Merge adjacent same-mark runs (see text-arbitraries.normalizeInline).
      const out: any[] = [];
      for (const r of runs) {
        const prev = out[out.length - 1];
        if (prev && JSON.stringify(prev.marks ?? []) === JSON.stringify(r.marks ?? [])) {
          prev.text += r.text;
        } else out.push({ ...r });
      }
      return doc(para(out));
    }),
};

/** Build the full list of named generators for a given mode. */
export function buildGenerators(mode: AttrMode): NamedGen[] {
  return Object.entries(gen).map(([name, f]) => ({ name, arb: f(mode) }));
}

// ---------------------------------------------------------------------------
// Completeness contract support.
// ---------------------------------------------------------------------------

/**
 * Schema node/mark types deliberately NOT covered by a P1/P2 generator, each
 * with a one-line reason. Excluding a type means it is kept OUT of the round-
 * trip generators — it does NOT weaken any property.
 *
 * NOTE (empirical): the candidates the issue flagged for review — pageEmbed,
 * subpages, transclusionSource/Reference, mention, status — were PROBED against
 * the live converter and DO round-trip P1/P2 with placeholder ids, so they are
 * COVERED by real generators rather than allowlisted here. The allowlist below
 * holds only types with no standalone flat generator by construction.
 */
export const KNOWN_UNCOVERED: Record<string, string> = {
  // The root node; it is the wrapper every generated doc already is, never a
  // "target" content node, so it has no standalone generator of its own.
  doc: 'the document root wrapper, not a content node with a standalone generator',
};

/** Recursively collect every node type and `mark:<type>` under a tree. */
export function collectTypes(node: any, seen = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return seen;
  if (node.type) seen.add(node.type);
  for (const m of node.marks ?? []) if (m?.type) seen.add(`mark:${m.type}`);
  for (const c of node.content ?? []) collectTypes(c, seen);
  return seen;
}

/**
 * Sample every generator and return the union of node/mark types they produce.
 * Deterministic (fixed seed) so the completeness contract is stable.
 */
export function coveredTypes(seed = 12345, perGen = 60): Set<string> {
  const seen = new Set<string>();
  for (const { arb } of buildGenerators('p1')) {
    for (const sample of fc.sample(arb, { numRuns: perGen, seed })) {
      collectTypes(sample, seen);
    }
  }
  return seen;
}
