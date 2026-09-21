import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

// These property tests run real ProseMirror<->Markdown conversion × NUM_RUNS, so
// each takes ~4–5s. Inputs are DETERMINISTIC (fixed SEED below) — the only source
// of flakiness is wall-clock: under the full suite's parallel worker load they can
// exceed vitest's default 5000ms per-test timeout. Give them ample headroom so CI
// (which gates the docker build, AGENTS.md) is deterministic regardless of load.
vi.setConfig({ testTimeout: 30000 });
// Import the converter DIRECTLY from src (NOT the docmost-client barrel) so we
// match the path used by the other converter unit tests.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
// markdownToProseMirror lives in collaboration.ts; importing it mutates the
// global DOM via jsdom at module load time — this is expected and required for
// @tiptap/html's generateJSON to run under Node.
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';
import { stripBlockIds } from './roundtrip-helpers.js';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS (SPEC §11 / "Задача №0")
//
// git is the state store, and git diffs byte-for-byte. The sync daemon does
// `export(markdown) -> import(ProseMirror) -> export(markdown)` on every pull,
// so if the *second* export differs from the first by even one byte, every
// pull produces a phantom diff -> endless commits/conflicts. The single
// property git actually needs is therefore MARKDOWN BYTE-STABILITY:
//
//     md2 := export(import(export(doc)))   MUST equal   md1 := export(doc)
//
// This file fuzzes that invariant with fast-check over randomly generated,
// representative Docmost ProseMirror documents.
//
// ---------------------------------------------------------------------------
// THE "SUPPORTED SPACE" PROBLEM
//
// A NAIVE generator surfaces two different kinds of `md2 !== md1`:
//
//   (a) GENUINE converter limitations — documented below as `it.fails` repros.
//   (b) Inputs the converter LEGITIMATELY normalizes, i.e. markdown that is
//       ambiguous or that the schema rewrites to a canonical form. These are
//       NOT byte-stable by construction and are NOT bugs; the fix is to keep
//       the generator inside the byte-stable / supported space.
//
// The following were all empirically confirmed (by probing the live converter)
// and are EXCLUDED from / canonicalized by the byte-stable arbitrary. Each is a
// markdown ambiguity or a schema/ProseMirror normalization, NOT a converter bug.
//
//   * Text that re-triggers block/inline markdown syntax on re-parse:
//       - a leading `>`/`*`/`-`/`#`/`1.` turns a paragraph into a blockquote/
//         list/heading;
//       - `a  b` (2+ spaces) collapses to `a b`;
//       - `<b>` / `</div>` parse as real HTML tags (and run-concatenation can
//         form `<word>` across a run boundary);
//       - `&amp;` / `&lt;` decode back to `&` / `<`;
//       - a lone backtick is a code-span delimiter and re-pairs globally.
//     -> The text arbitrary emits space-joined tokens that BEGIN and END with an
//        alphanumeric word, with any single special char confined to the middle
//        (space-flanked). Every char the task requires (* _ [ ] ( ) | < > &, and
//        more) is covered this way; the backtick is exercised via code spans.
//   * A purely numeric image `alt` ("0") or link `title` ("0") is parsed back as
//     a NUMBER and dropped by the converter's `value || ""` -> alt/title always
//     carry at least one letter.
//   * Callout types other than info/success/warning/danger normalize to `info`
//     (schema only knows those four) -> generator restricts to those four.
//   * A list item / callout / blockquote with MULTIPLE block children: the
//     converter joins them with a single "\n", which marked re-parses as ONE
//     merged paragraph ("- p1\n  p2" -> "- p1 p2"). -> container bodies hold a
//     SINGLE paragraph, optionally plus ONE nested list for lists.
//   * `orderedList.start` / `1)` markers normalize to `1.` -> not emitted.
//   * Two sibling lists sharing a marker family (bullet/task use "-", ordered
//     uses "1.") MERGE into one list -> no two list blocks are adjacent.
//   * TWO consecutive hard breaks render a blank line that marked eats as a
//     paragraph break, and a trailing hard break is trimmed -> consecutive/
//     trailing hard breaks are collapsed/removed.
//   * Adjacent text runs with IDENTICAL marks ("**a****b****c**" -> "**abc**").
//     A real ProseMirror doc never stores split same-mark runs (the editor
//     coalesces them) -> the generator merges them too (normalizeInline).
//
// The GENUINE, real-but-intentional non-roundtrip limitations are documented as
// dedicated blocks below (so the suite never goes green by hiding them):
//
//   1. FIXED in #515 (was: the `code` mark COMBINED with any other mark did not
//      round-trip, because the schema's `code` mark declared `excludes: "_"` and
//      import dropped every co-occurring mark -> the run came back as `code`
//      only). The mark now declares `excludes: ""`, the serializer nests the
//      backtick span INSIDE the other marks (``**`x`**``), and both marks survive
//      the cycle. The block below is now a REAL round-trip property (marks +
//      bytes), no longer a documented bug.
//   2. A BLOCK-level `image` placed BETWEEN other blocks. The Docmost image node
//      is block-level but `![](url)` is inline; marked wraps it in a <p>, the
//      schema hoists the <img> out and leaves an empty paragraph sibling, which
//      injects an extra blank gap on the second export. An image IS byte-stable
//      as the sole block (edge artifacts get trimmed) — covered by a green test.
// ---------------------------------------------------------------------------

// Run a full export -> import -> export cycle and return both markdown strings.
async function roundTrip(doc: unknown): Promise<{ md1: string; md2: string; doc2: any }> {
  const md1 = convertProseMirrorToMarkdown(doc);
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, md2, doc2 };
}

const SEED = 42;
const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Inline text arbitraries
// ---------------------------------------------------------------------------

// Alphanumeric "word" (no markdown-significant characters). Length 1..6.
const wordArb = fc
  .stringMatching(/^[A-Za-z0-9]{1,6}$/)
  .filter((w) => w.length > 0);

// A SINGLE markdown-significant character, emitted only as an isolated,
// space-flanked token. Every char the task calls out plus a few more; each was
// verified byte-stable in this position.
//
// NOTE: the backtick (`) is DELIBERATELY excluded from free-floating plain
// text. A lone backtick is a markdown code-span DELIMITER, so its round-trip
// depends on GLOBAL backtick pairing: a stray backtick in running text adjacent
// to a real code span ("A ` " + `code`) re-pairs into a different code span and
// loses a space — genuinely outside the byte-stable space. The backtick is
// still fully exercised as the `code`-mark delimiter and inside code blocks.
const specialCharArb = fc.constantFrom(
  '*', '_', '[', ']', '(', ')', '{', '}', '|', '<', '>', '&', '#', '!', '~', '=', '+', '-',
);

// Build a "safe special" text string: a space-joined sequence of tokens that
// always BEGINS and ENDS with an alphanumeric word, with any isolated special
// chars confined to the MIDDLE (each space-flanked by words).
//
// Both boundary guarantees matter:
//   * Leading word: the line never opens with a block/inline trigger
//     (">", "*", "-", "#", "1." ...).
//   * Trailing word: adjacent text runs CONCATENATE with no separator, so a run
//     ending in a bare "<" beside a run starting with a letter would form a fake
//     HTML tag ("...0 <" + "A >" -> "0 <A >"), which marked/jsdom strips. Ending
//     every run with an alphanumeric word keeps every special internal and
//     space-flanked even after concatenation.
const safeTextArb: fc.Arbitrary<string> = fc
  .tuple(
    wordArb,
    fc.array(fc.oneof(wordArb, specialCharArb), { minLength: 0, maxLength: 3 }),
    wordArb,
  )
  .map(([first, middle, last]) => [first, ...middle, last].join(' '));

// A plain alphanumeric phrase (1..3 words) for places where even isolated
// specials are not wanted (e.g. code-block language, mention labels).
const phraseArb: fc.Arbitrary<string> = fc
  .array(wordArb, { minLength: 1, maxLength: 3 })
  .map((ws) => ws.join(' '));

// A phrase guaranteed to contain at least one letter. Used for image alt text:
// a PURELY numeric alt (e.g. "0", "00") is parsed back by the schema as a
// NUMBER, and the converter's `alt || ""` then treats the number 0 as falsy and
// DROPS the alt ("![0](u)" -> "![](u)") — not byte-stable. A letter anywhere in
// the alt keeps it a string and avoids the coercion.
const letterPhraseArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z]{1,4}$/),
    fc.array(wordArb, { minLength: 0, maxLength: 2 }),
  )
  .map(([head, rest]) => [head, ...rest].join(' '));


// A text run with an OPTIONAL single non-code mark (bold/italic/strike), a
// `code` mark ALONE or COMBINED with another mark (#515 — `code` no longer
// excludes the other marks; the combination is byte-stable, either as nested
// markdown or, for a heterogeneous neighbour pair, via the lossless HTML
// fallback), or a link. Marks wrap safe text, which stays stable even when it
// contains isolated specials.
const markedTextRunArb: fc.Arbitrary<any> = fc.oneof(
  // Plain text.
  safeTextArb.map((t) => ({ type: 'text', text: t })),
  // Single formatting mark.
  fc
    .tuple(safeTextArb, fc.constantFrom('bold', 'italic', 'strike'))
    .map(([t, m]) => ({ type: 'text', text: t, marks: [{ type: m }] })),
  // Sole code mark (backtick span). safeTextArb is already backtick-free, so the
  // code span content cannot contain an inner backtick (which would be
  // ambiguous to re-parse).
  safeTextArb.map((t) => ({ type: 'text', text: t, marks: [{ type: 'code' }] })),
  // #515: `code` COMBINED with another mark on the same run.
  fc
    .tuple(
      safeTextArb,
      fc.constantFrom('bold', 'italic', 'strike', 'underline', 'highlight'),
    )
    .map(([t, m]) => ({
      type: 'text',
      text: t,
      marks: [{ type: 'code' }, { type: m }],
    })),
  // Link with safe text and a paren/space-free href, optionally with a title.
  // The title rides in a markdown link-title attribute; a purely numeric title
  // is coerced to a number and dropped on re-import (same class of quirk as the
  // image alt), so the title always carries at least one letter.
  fc
    .tuple(
      phraseArb,
      fc.webUrl().filter((u) => !/[()\s]/.test(u)),
      fc.option(letterPhraseArb, { nil: undefined }),
    )
    .map(([t, href, title]) => ({
      type: 'text',
      text: t,
      marks: [{ type: 'link', attrs: title ? { href, title } : { href } }],
    })),
  // Inline COMMENT anchor (SPEC §3): a span[data-comment-id] that must survive
  // the round-trip byte-for-byte. The commentId is an alphanumeric token (no
  // attribute-breaking chars), and `resolved` rides as data-resolved="true"
  // only when true — both forms were verified byte-stable.
  fc
    .tuple(safeTextArb, fc.stringMatching(/^[A-Za-z0-9]{4,10}$/), fc.boolean())
    .map(([t, commentId, resolved]) => ({
      type: 'text',
      text: t,
      marks: [
        {
          type: 'comment',
          attrs: resolved ? { commentId, resolved: true } : { commentId },
        },
      ],
    })),
);

// Inline math node carrying LaTeX that includes the `a < b` the task asks for.
const mathInlineArb: fc.Arbitrary<any> = fc
  .constantFrom('a < b', 'x^2 + y^2', 'a < b < c', '\\frac{1}{2}', 'E = mc^2')
  .map((text) => ({ type: 'mathInline', attrs: { text } }));

// Mention node (schema attrs); label/id are plain phrases.
const mentionArb: fc.Arbitrary<any> = fc
  .tuple(phraseArb, fc.uuid(), fc.uuid())
  .map(([label, id, entityId]) => ({
    type: 'mention',
    attrs: { id, label, entityType: 'user', entityId },
  }));

const hardBreakArb: fc.Arbitrary<any> = fc.constant({ type: 'hardBreak' });

// Canonicalize a generated inline-content array the way ProseMirror itself
// stores inline content, then trim the markdown-fragile edges. Applied to both
// paragraph and heading inline content.
//
//   1) MERGE adjacent `text` runs that carry IDENTICAL marks. A real
//      ProseMirror document never stores two neighbouring runs with the same
//      mark set — the editor coalesces them into one. A naive generator that
//      leaves them split produces UNREALISTIC docs AND breaks byte-stability:
//      three adjacent bold runs export as "**a****b****c**", whose inner
//      "****" boundaries are ambiguous and re-parse as a single "**abc**".
//      Merging makes the generated doc canonical and the markdown stable.
//   2) Collapse CONSECUTIVE hard breaks. Two in a row render as "  \n  \n",
//      whose middle whitespace-only line marked treats as a paragraph break, so
//      "a  \n  \nb" re-parses to "a\n\nb". A SINGLE hard break round-trips.
//   3) Drop a TRAILING hard break: "...  \n" sits at the paragraph edge and is
//      removed by the converter's .trim().
const sameMarks = (a: any[] | undefined, b: any[] | undefined): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function normalizeInline(nodes: any[]): any[] {
  const out: any[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    // Collapse a second consecutive hard break.
    if (node.type === 'hardBreak' && prev && prev.type === 'hardBreak') {
      continue;
    }
    // Merge an adjacent text run with the same marks.
    if (
      node.type === 'text' &&
      prev &&
      prev.type === 'text' &&
      sameMarks(prev.marks, node.marks)
    ) {
      prev.text += node.text;
      continue;
    }
    // Clone text nodes so the in-place merge above never mutates a shared value.
    out.push(node.type === 'text' ? { ...node } : node);
  }
  while (out.length > 1 && out[out.length - 1].type === 'hardBreak') {
    out.pop();
  }
  return out;
}

// Inline content for a paragraph: at least one marked text run, optionally with
// inline atoms (math/mention) and hard breaks interspersed. Always starts with a
// text run so the paragraph never opens with a block trigger.
const inlineContentArb: fc.Arbitrary<any[]> = fc
  .tuple(
    markedTextRunArb,
    fc.array(
      fc.oneof(
        { weight: 5, arbitrary: markedTextRunArb },
        { weight: 1, arbitrary: mathInlineArb },
        { weight: 1, arbitrary: mentionArb },
        { weight: 1, arbitrary: hardBreakArb },
      ),
      { minLength: 0, maxLength: 4 },
    ),
  )
  .map(([first, rest]) => normalizeInline([first, ...rest]));

// Inline content for a HEADING — identical to a paragraph's, but WITHOUT hard
// breaks. A hard break inside an ATX heading ("# a  \nb") is NOT byte-stable:
// marked does not honour a hard break inside a heading, so it re-parses as the
// heading "# a" plus a separate paragraph "b" (md2 = "# a\n\nb"). math/mention/
// link inside a heading are fine (verified) and stay in the menu.
const headingInlineContentArb: fc.Arbitrary<any[]> = fc
  .tuple(
    markedTextRunArb,
    fc.array(
      fc.oneof(
        { weight: 5, arbitrary: markedTextRunArb },
        { weight: 1, arbitrary: mathInlineArb },
        { weight: 1, arbitrary: mentionArb },
      ),
      { minLength: 0, maxLength: 4 },
    ),
  )
  .map(([first, rest]) => normalizeInline([first, ...rest]));

// ---------------------------------------------------------------------------
// Block arbitraries
// ---------------------------------------------------------------------------

const paragraphArb: fc.Arbitrary<any> = inlineContentArb.map((content) => ({
  type: 'paragraph',
  content,
}));

const headingArb: fc.Arbitrary<any> = fc
  .tuple(fc.integer({ min: 1, max: 6 }), headingInlineContentArb)
  .map(([level, content]) => ({ type: 'heading', attrs: { level }, content }));

// Code block content: 1..4 lines of plain phrases (may contain specials inline,
// which are inert inside a fenced block). Language is optional and is a single
// lowercase token.
const codeBlockArb: fc.Arbitrary<any> = fc
  .tuple(
    fc.option(fc.constantFrom('js', 'ts', 'python', 'go', 'rust', 'bash'), {
      nil: '',
    }),
    fc
      .array(safeTextArb, { minLength: 1, maxLength: 4 })
      .map((lines) => lines.join('\n')),
  )
  .map(([language, code]) => ({
    type: 'codeBlock',
    attrs: { language },
    content: [{ type: 'text', text: code }],
  }));

const blockquoteArb: fc.Arbitrary<any> = paragraphArb.map((p) => ({
  type: 'blockquote',
  content: [p],
}));

const horizontalRuleArb: fc.Arbitrary<any> = fc.constant({
  type: 'horizontalRule',
});

// Callout: ONE paragraph child; type restricted to the four the schema knows.
const calloutArb: fc.Arbitrary<any> = fc
  .tuple(
    fc.constantFrom('info', 'success', 'warning', 'danger'),
    paragraphArb,
  )
  .map(([type, p]) => ({ type: 'callout', attrs: { type }, content: [p] }));

const mathBlockArb: fc.Arbitrary<any> = fc
  .constantFrom('a < b', 'a < b < c', '\\sum_{i=0}^{n} i', 'x = \\frac{-b}{2a}', '')
  .map((text) => ({ type: 'mathBlock', attrs: { text } }));

const imageArb: fc.Arbitrary<any> = fc
  .tuple(
    fc.webUrl(),
    // alt is a letter-bearing phrase OR empty. Brackets/parens leak into the
    // markdown image syntax (not byte-stable) so they are excluded, and a purely
    // numeric alt is coerced to a number and dropped (see letterPhraseArb), so
    // alt always carries at least one letter when non-empty.
    fc.option(letterPhraseArb, { nil: '' }),
  )
  .map(([src, alt]) => ({ type: 'image', attrs: { src, alt } }));

// A simple list item: ONE paragraph, optionally followed by ONE nested bullet
// list (single level of nesting). depth controls whether nesting is allowed.
function listItemArb(allowNest: boolean): fc.Arbitrary<any> {
  if (!allowNest) {
    return paragraphArb.map((p) => ({ type: 'listItem', content: [p] }));
  }
  return fc
    .tuple(
      paragraphArb,
      fc.option(
        fc.array(
          paragraphArb.map((p) => ({ type: 'listItem', content: [p] })),
          { minLength: 1, maxLength: 3 },
        ),
        { nil: undefined },
      ),
    )
    .map(([p, nested]) => ({
      type: 'listItem',
      content: nested
        ? [p, { type: 'bulletList', content: nested }]
        : [p],
    }));
}

const bulletListArb: fc.Arbitrary<any> = fc
  .array(listItemArb(true), { minLength: 1, maxLength: 4 })
  .map((items) => ({ type: 'bulletList', content: items }));

const orderedListArb: fc.Arbitrary<any> = fc
  .array(listItemArb(true), { minLength: 1, maxLength: 4 })
  .map((items) => ({ type: 'orderedList', content: items }));

// Task item: ONE paragraph, optional ONE nested bullet list.
const taskItemArb: fc.Arbitrary<any> = fc
  .tuple(
    fc.boolean(),
    paragraphArb,
    fc.option(
      fc.array(listItemArb(false), { minLength: 1, maxLength: 2 }),
      { nil: undefined },
    ),
  )
  .map(([checked, p, nested]) => ({
    type: 'taskItem',
    attrs: { checked },
    content: nested ? [p, { type: 'bulletList', content: nested }] : [p],
  }));

const taskListArb: fc.Arbitrary<any> = fc
  .array(taskItemArb, { minLength: 1, maxLength: 4 })
  .map((items) => ({ type: 'taskList', content: items }));

// GFM table: a header row + 1..3 body rows, with a fixed column count (1..3) and
// per-column alignment. Cells hold a single short paragraph of safe text.
const tableArb: fc.Arbitrary<any> = fc
  .integer({ min: 1, max: 3 })
  .chain((cols) => {
    const cellArb = (header: boolean, align?: string) =>
      phraseArb.map((t) => ({
        type: header ? 'tableHeader' : 'tableCell',
        attrs: align ? { align } : {},
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
      }));
    const alignsArb = fc.array(
      fc.constantFrom(undefined, 'left', 'center', 'right'),
      { minLength: cols, maxLength: cols },
    );
    return fc
      .tuple(
        alignsArb,
        fc.array(
          fc.constant(null), // body-row placeholders; cells filled below
          { minLength: 1, maxLength: 3 },
        ),
      )
      .chain(([aligns, bodyRows]) => {
        const headerRow = fc
          .tuple(...aligns.map((a) => cellArb(true, a)))
          .map((cells) => ({ type: 'tableRow', content: cells }));
        const bodyRowArbs = bodyRows.map(() =>
          fc
            .tuple(...aligns.map(() => cellArb(false)))
            .map((cells) => ({ type: 'tableRow', content: cells })),
        );
        return fc
          .tuple(headerRow, fc.tuple(...bodyRowArbs))
          .map(([h, body]) => ({ type: 'table', content: [h, ...body] }));
      });
  });

// ---------------------------------------------------------------------------
// Top-level document arbitrary
// ---------------------------------------------------------------------------

// The full menu of block nodes that are byte-stable when SEQUENCED with other
// blocks. NOTE: `image` is deliberately NOT in this menu — see the dedicated
// image tests below. The Docmost `image` node is BLOCK-level, but its markdown
// form `![](url)` is INLINE; marked wraps it in a <p>, the schema then hoists
// the block <img> out and leaves an EMPTY paragraph beside it, so on the second
// export the stray empty paragraph injects extra blank lines between siblings
// ("p\n\n![](u)\n\nq" -> "p\n\n\n\n![](u)\n\nq"). An image is only byte-stable
// when it is the SOLE block (the edge artifacts get .trim()'d away). It is
// therefore covered by its own targeted tests, not mixed into multi-block docs.
const blockArb: fc.Arbitrary<any> = fc.oneof(
  { weight: 6, arbitrary: paragraphArb },
  { weight: 3, arbitrary: headingArb },
  { weight: 2, arbitrary: codeBlockArb },
  { weight: 2, arbitrary: bulletListArb },
  { weight: 2, arbitrary: orderedListArb },
  { weight: 2, arbitrary: taskListArb },
  { weight: 2, arbitrary: blockquoteArb },
  { weight: 2, arbitrary: tableArb },
  { weight: 2, arbitrary: calloutArb },
  { weight: 1, arbitrary: horizontalRuleArb },
  { weight: 1, arbitrary: mathBlockArb },
);

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

// A bounded document: 1..8 block nodes. Kept small so each run is cheap (each
// run does a real marked + jsdom parse) and shrinking stays fast.
//
// Post-process: never let two LIST blocks sit directly adjacent. Two sibling
// lists that share a marker family — bullet/task both use "-", ordered uses
// "1." — are MERGED by markdown into a single list when only a blank line
// separates them ("- a\n\n- b" -> one list -> "- a\n- b"), which is not
// byte-stable. (A non-list block between two lists separates them fine, as does
// a different marker family, but dropping every back-to-back list is the clean,
// always-correct rule.) We drop a list block whenever the previously kept block
// is also a list.
const docArb: fc.Arbitrary<any> = fc
  .array(blockArb, { minLength: 1, maxLength: 8 })
  .map((content) => {
    const out: any[] = [];
    for (const block of content) {
      const prev = out[out.length - 1];
      if (
        prev &&
        LIST_TYPES.has(prev.type) &&
        LIST_TYPES.has(block.type)
      ) {
        continue; // skip a list that would sit right after another list
      }
      out.push(block);
    }
    // Guarantee a non-empty document even if filtering removed everything but a
    // single dropped block (cannot happen here since the first block is always
    // kept, but keep the invariant explicit).
    return { type: 'doc', content: out.length ? out : content.slice(0, 1) };
  });

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe('markdown <-> ProseMirror round-trip (property-based)', () => {
  it('the generator covers every targeted node type at least once', () => {
    // A sanity check that the arbitrary actually exercises the intended node
    // variety within NUM_RUNS — not a correctness property, just coverage.
    const seen = new Set<string>();
    const collect = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type) seen.add(node.type);
      for (const m of node.marks ?? []) seen.add(`mark:${m.type}`);
      for (const c of node.content ?? []) collect(c);
    };
    fc.assert(
      fc.property(docArb, (doc) => {
        collect(doc);
        return true;
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
    // Core block types and marks we expect to appear.
    for (const t of [
      'paragraph',
      'heading',
      'codeBlock',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'table',
      'callout',
      'horizontalRule',
      'mathBlock',
      // 'image' is covered by its own dedicated tests, not docArb.
      'mention',
      'mathInline',
      'hardBreak',
      'mark:bold',
      'mark:italic',
      'mark:strike',
      'mark:code',
      'mark:link',
      'mark:comment',
    ]) {
      expect(seen, `expected the generator to produce ${t}`).toContain(t);
    }
  });

  it('markdown is byte-stable across export -> import -> export', async () => {
    // The property git needs: a second export reproduces the first byte-for-byte.
    await fc.assert(
      fc.asyncProperty(docArb, async (doc) => {
        const { md1, md2 } = await roundTrip(doc);
        expect(md2).toBe(md1);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('the document is semantically stable on a second cycle (ids stripped)', async () => {
    // Optional, stronger-feeling property. We do NOT compare doc vs doc2: the
    // converter reconstructs schema default attrs on the FIRST import (a known
    // SPEC §11 divergence). But once the markdown is byte-stable, importing the
    // SAME markdown twice must yield structurally identical docs (modulo the
    // regenerated block ids). So we compare doc2 (import of md1) with doc3
    // (import of md2 == md1) after stripping ids.
    await fc.assert(
      fc.asyncProperty(docArb, async (doc) => {
        const md1 = convertProseMirrorToMarkdown(doc);
        const doc2 = await markdownToProseMirror(md1);
        const md2 = convertProseMirrorToMarkdown(doc2);
        // Guard: this property only makes sense when md is byte-stable.
        expect(md2).toBe(md1);
        const doc3 = await markdownToProseMirror(md2);
        expect(stripBlockIds(doc3)).toEqual(stripBlockIds(doc2));
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('a SOLE image block is byte-stable', async () => {
    // An image is byte-stable when it is the only block in the document: the
    // stray empty paragraph the schema leaves beside the hoisted block <img>
    // sits at a document edge and is removed by the converter's final .trim().
    await fc.assert(
      fc.asyncProperty(imageArb, async (image) => {
        const doc = { type: 'doc', content: [image] };
        const { md1, md2 } = await roundTrip(doc);
        expect(md2).toBe(md1);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  // -------------------------------------------------------------------------
  // KNOWN, DOCUMENTED non-roundtrip bug #2 (kept honest as it.fails).
  //
  // BUG: a block-level `image` placed BETWEEN other blocks is not byte-stable.
  // The Docmost image node is BLOCK-level but its markdown form `![](url)` is
  // INLINE. marked wraps the inline image in a <p>; the schema then hoists the
  // block <img> out of that <p>, leaving an EMPTY paragraph as a sibling. On the
  // second export that empty paragraph renders as "" and the "\n\n" doc join
  // injects an extra blank gap:
  //   "p\n\n![x](u)\n\nq"  ->  "p\n\n\n\n![x](u)\n\nq"   (=> md2 !== md1).
  // Minimal repro doc:
  //   { type:'doc', content:[
  //       { type:'paragraph', content:[{type:'text',text:'p'}] },
  //       { type:'image', attrs:{ src:'http://a.aa', alt:'x' } },
  //       { type:'paragraph', content:[{type:'text',text:'q'}] } ] }
  // Not "fixed" — the source must not change; documented and exercised here.
  // -------------------------------------------------------------------------
  it('a block image between other blocks is byte-stable', async () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'p' }] },
        { type: 'image', attrs: { src: 'http://a.aa', alt: 'x' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'q' }] },
      ],
    };
    const { md1, md2 } = await roundTrip(doc);
    expect(md2).toBe(md1);
  });

  // -------------------------------------------------------------------------
  // #515: the `code` mark COMBINED with another mark. Formerly documented bug #1
  // (the schema's `code` mark declared `excludes: "_"`, so import dropped every
  // co-occurring mark and the run came back code-only). Now a REAL round-trip
  // property: the combination must be byte-stable AND both marks must survive the
  // import (a byte-stable-but-lossy export would silently pass the byte check, so
  // the mark set is asserted explicitly).
  // -------------------------------------------------------------------------
  it('the code mark combined with another mark round-trips (bytes + marks)', async () => {
    const codeComboArb = fc
      .tuple(
        safeTextArb,
        fc.constantFrom('bold', 'italic', 'strike', 'underline', 'highlight'),
      )
      .map(([t, other]) => ({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: t, marks: [{ type: 'code' }, { type: other }] },
            ],
          },
        ],
      }));
    await fc.assert(
      fc.asyncProperty(codeComboArb, async (doc) => {
        const { md1, md2, doc2 } = await roundTrip(doc);
        expect(md2).toBe(md1);
        // The re-imported run still carries BOTH marks (co-mark not dropped).
        const runs = doc2.content[0].content as any[];
        const marks = new Set(
          runs.flatMap((r) => (r.marks || []).map((m: any) => m.type)),
        );
        expect(marks.has('code')).toBe(true);
        const other = doc.content[0].content[0].marks[1].type;
        expect(marks.has(other)).toBe(true);
      }),
      { numRuns: 20, seed: SEED },
    );
  });

  // A code span inside a LINK keeps both marks: `[`x`](href)`.
  it('a code+link run round-trips (bytes + marks)', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'http://a.aa' } }],
            },
          ],
        },
      ],
    };
    const { md1, md2, doc2 } = await roundTrip(doc);
    expect(md1).toBe('[`x`](http://a.aa)');
    expect(md2).toBe(md1);
    const marks = (doc2.content[0].content[0].marks || []).map((m: any) => m.type);
    expect(new Set(marks)).toEqual(new Set(['code', 'link']));
  });

  // #515 case 2 from the bug report: a HOMOGENEOUS code-emphasis run (code spans
  // and their separator all carry the same bold) is factored to ONE pair of `**`
  // delimiters — never the dangling `` `aaa`** + **`bbb` `` form.
  it('a homogeneous code-emphasis run factors the shared mark out once', async () => {
    const bold = { type: 'bold' };
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'aaa', marks: [{ type: 'code' }, bold] },
            { type: 'text', text: ' + ', marks: [bold] },
            { type: 'text', text: 'bbb', marks: [{ type: 'code' }, bold] },
          ],
        },
      ],
    };
    const { md1, md2 } = await roundTrip(doc);
    expect(md1).toBe('**`aaa` + `bbb`**');
    expect(md2).toBe(md1);
  });

  // #515 ANTI-COLLISION: a `[code,bold]` run IMMEDIATELY followed (no separator)
  // by an `[italic]` run is a HETEROGENEOUS code-emphasis run. Emitting each node
  // as markdown would produce ``**`a`***b*`` — whose `***` re-parses as a single
  // (mis-nested) emphasis delimiter run, losing the bold. The converter must take
  // the lossless schema-HTML fallback instead, and the cycle must be stable with
  // every mark intact.
  it('an adjacent [code,bold] · [italic] pair takes the lossless HTML fallback', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'code' }, { type: 'bold' }] },
            { type: 'text', text: 'b', marks: [{ type: 'italic' }] },
          ],
        },
      ],
    };
    const { md1, md2, doc2 } = await roundTrip(doc);
    expect(md1).not.toContain('***');
    expect(md1).toBe('<strong><code>a</code></strong><em>b</em>');
    expect(md2).toBe(md1);
    const runs = doc2.content[0].content as any[];
    expect(runs.map((r) => (r.marks || []).map((m: any) => m.type).sort())).toEqual([
      ['bold', 'code'],
      ['italic'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// #515 review F1 — a code node with NO emphasis is NOT a run seed.
//
// The coalescing pass above exists because a code node that ITSELF carries a
// bare-delimiter emphasis mark can glue an emphasis delimiter to a backtick.
// A code node WITHOUT an emphasis mark can never do that, and the shapes below
// (an emphasized run ADJACENT to a plain code span) were ALWAYS representable —
// `excludes: "_"` only ever forbade code+mark on the SAME node. They live in the
// git-sync repos as plain markdown today, and re-import losslessly.
//
// If they were pulled into a code-emphasis run they would take the HTML fallback,
// and EVERY existing markdown file carrying such a construct would rewrite itself
// to HTML on the next sync — a mass phantom diff and a violation of the design's
// "non-code output stays byte-identical" promise. So each shape is pinned to the
// EXACT legacy markdown it has always produced.
// ---------------------------------------------------------------------------
describe('#515 F1: a plain code span next to an emphasized run stays MARKDOWN', () => {
  const t = (text: string, ...marks: string[]) => ({
    type: 'text',
    text,
    ...(marks.length ? { marks: marks.map((m) => ({ type: m })) } : {}),
  });
  const para = (content: any[]) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content }],
  });

  const cases: [string, any[], string][] = [
    ['bold then code', [t('bold', 'bold'), t('c', 'code')], '**bold**`c`'],
    ['code then bold', [t('c', 'code'), t('bold', 'bold')], '`c`**bold**'],
    ['italic then code', [t('i', 'italic'), t('c', 'code')], '*i*`c`'],
    [
      'bold code bold',
      [t('a', 'bold'), t('c', 'code'), t('b', 'bold')],
      '**a**`c`**b**',
    ],
    [
      'code italic code',
      [t('c1', 'code'), t('i', 'italic'), t('c2', 'code')],
      '`c1`*i*`c2`',
    ],
    ['strike then code', [t('s', 'strike'), t('c', 'code')], '~~s~~`c`'],
    ['color-less highlight then code', [t('h', 'highlight'), t('c', 'code')], '==h==`c`'],
  ];

  for (const [name, content, expected] of cases) {
    it(`${name} keeps its legacy markdown (no HTML degradation)`, async () => {
      const doc = para(content);
      const { md1, md2, doc2 } = await roundTrip(doc);
      // The exact bytes this document has always produced.
      expect(md1).toBe(expected);
      expect(md1).not.toContain('<code>');
      expect(md2).toBe(md1);
      // ...and it still re-imports to the same marked runs (lossless).
      const runs = doc2.content[0].content as any[];
      expect(
        runs.map((r) => [r.text, (r.marks || []).map((m: any) => m.type).sort()]),
      ).toEqual(
        content.map((r: any) => [
          r.text,
          (r.marks || []).map((m: any) => m.type).sort(),
        ]),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// #515 review F2 — the flanking guard must work on CODE POINTS.
//
// The guard decides whether an emphasis delimiter glued to a backtick can still
// flank, by inspecting the neighbouring character. Reading it with `slice(-1)` /
// `slice(0, 1)` returns a lone SURROGATE half of an astral character; the lone
// half matches neither `\s` nor `\p{P}`/`\p{S}`, so the guard used to call it a
// word boundary, emit markdown — and `marked` then refused to open the emphasis,
// SILENTLY DROPPING the mark on re-import.
//
// The export is BYTE-STABLE in that state (`md2 === md1`), so the byte-stability
// property CANNOT see the loss: the document just quietly mutates. These tests
// therefore assert the MARK SET survives the md -> pm import, not just the bytes.
//
// The same hole applies to any character marked does not count as whitespace or
// punctuation — a combining mark, a ZWJ, a soft hyphen — which the old
// `!/[\p{L}\p{N}]/u` formulation also mislabelled as a boundary.
// ---------------------------------------------------------------------------
describe('#515 F2: astral / non-punctuation neighbours never silently drop a mark', () => {
  const NEIGHBOURS: [string, string][] = [
    ['astral emoji', '\u{1F642}'],
    ['astral math letter', '\u{1D400}'],
    ['astral CJK extension B', '\u{20000}'],
    ['combining acute', '́'],
    ['zero-width joiner', '‍'],
    ['soft hyphen', '­'],
  ];

  for (const [name, ch] of NEIGHBOURS) {
    for (const mark of ['bold', 'italic', 'strike'] as const) {
      it(`${mark} + code preceded by ${name}: both marks survive re-import`, async () => {
        const doc = {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: `a${ch}` },
                {
                  type: 'text',
                  text: 'x',
                  marks: [{ type: mark }, { type: 'code' }],
                },
              ],
            },
          ],
        };
        const { md1, md2, doc2 } = await roundTrip(doc);
        expect(md2).toBe(md1);
        const runs = doc2.content[0].content as any[];
        const marked = runs.find((r) => r.text === 'x');
        expect(marked, `run "x" survived as its own run in ${md1}`).toBeTruthy();
        expect(new Set((marked.marks || []).map((m: any) => m.type))).toEqual(
          new Set([mark, 'code']),
        );
      });

      it(`${mark} + code followed by ${name}: both marks survive re-import`, async () => {
        const doc = {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'x',
                  marks: [{ type: mark }, { type: 'code' }],
                },
                { type: 'text', text: `${ch}a` },
              ],
            },
          ],
        };
        const { md1, md2, doc2 } = await roundTrip(doc);
        expect(md2).toBe(md1);
        const runs = doc2.content[0].content as any[];
        const marked = runs.find((r) => r.text === 'x');
        expect(marked, `run "x" survived as its own run in ${md1}`).toBeTruthy();
        expect(new Set((marked.marks || []).map((m: any) => m.type))).toEqual(
          new Set([mark, 'code']),
        );
      });
    }
  }

  // The BOUNDARY side of the rule: a genuine whitespace/punctuation/symbol
  // neighbour must still take the clean MARKDOWN form (the guard must not
  // over-trigger into HTML for ordinary prose — that is the F1 failure mode in
  // its other guise).
  const SAFE: [string, string][] = [
    ['space', ' '],
    ['period', '.'],
    ['euro sign', '€'],
    ['arrow', '→'],
    ['degree sign', '°'],
    ['non-breaking space', ' '],
  ];
  for (const [name, ch] of SAFE) {
    it(`a ${name} neighbour keeps the markdown form and both marks`, async () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: `a${ch}` },
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'bold' }, { type: 'code' }],
              },
            ],
          },
        ],
      };
      const { md1, md2, doc2 } = await roundTrip(doc);
      expect(md1).toBe(`a${ch}**\`x\`**`);
      expect(md1).not.toContain('<code>');
      expect(md2).toBe(md1);
      const marked = (doc2.content[0].content as any[]).find((r) => r.text === 'x');
      expect(new Set((marked.marks || []).map((m: any) => m.type))).toEqual(
        new Set(['bold', 'code']),
      );
    });
  }
});
