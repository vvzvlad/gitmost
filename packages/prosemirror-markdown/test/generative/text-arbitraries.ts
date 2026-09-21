/**
 * Hostile inline-text corpus for the generative flat-document round-trip suite
 * (#351, PR 1).
 *
 * These arbitraries are a DIRECT PORT of the "supported space" guardrails that
 * `test/markdown-roundtrip.property.test.ts` proved empirically against the live
 * converter. That file's long header documents WHY each guardrail exists; rather
 * than re-derive them, we reuse the exact same shapes here so the attribute-level
 * generative suite inherits the same byte-stable text space. Each guardrail is
 * cited back to that file below.
 *
 * The corpus deliberately spans the CommonMark / canon hostile alphabet
 * (`* _ [ ] ( ) { } | < > & # ! ~ = + -`), unicode / emoji / RTL, and the legal
 * mark combinations on runs — INCLUDING the `code` mark combined with other
 * marks, which #515 made legal (the schema's `code` mark now declares
 * `excludes: ""`, and the serializer nests the backtick span inside the other
 * marks, falling back to lossless schema-HTML for a heterogeneous neighbour run).
 */
import fc from 'fast-check';
import { getSchema } from '@tiptap/core';

import { docmostExtensions } from '../../src/lib/docmost-schema.js';

// ---------------------------------------------------------------------------
// Canonical mark order (#515).
//
// ProseMirror stores a text node's marks sorted by their SCHEMA RANK, and the
// importer therefore always hands back e.g. [bold, code] (never [code, bold]).
// Read the rank straight from the mirror schema so the generators cannot drift
// from it, and sort every multi-mark run through `canonicalMarks`.
// ---------------------------------------------------------------------------
const MARK_RANK: Record<string, number> = Object.fromEntries(
  Object.keys(getSchema(docmostExtensions).marks).map((name, i) => [name, i]),
);

const canonicalMarks = (marks: any[]): any[] =>
  [...marks].sort((a, b) => (MARK_RANK[a.type] ?? 0) - (MARK_RANK[b.type] ?? 0));

// ---------------------------------------------------------------------------
// Words and the hostile special-character alphabet.
// (Ported from markdown-roundtrip.property.test.ts, "Inline text arbitraries".)
// ---------------------------------------------------------------------------

/** Alphanumeric "word" (no markdown-significant characters). Length 1..6. */
export const wordArb = fc
  .stringMatching(/^[A-Za-z0-9]{1,6}$/)
  .filter((w) => w.length > 0);

/**
 * A SINGLE markdown-significant character, emitted only as an isolated,
 * space-flanked token. Every char the task calls out plus a few more; each was
 * verified byte-stable in this position by the sibling property test.
 *
 * NOTE: the backtick (`) is DELIBERATELY excluded from free-floating plain text
 * (it is a code-span delimiter that re-pairs globally). It is exercised only via
 * the `code` mark and code blocks — see markdown-roundtrip.property.test.ts.
 */
export const specialCharArb = fc.constantFrom(
  '*', '_', '[', ']', '(', ')', '{', '}', '|', '<', '>', '&', '#', '!', '~', '=', '+', '-',
);

// A pinch of unicode / emoji / RTL, always word-like (no markdown specials) so
// it stays inside the space-flanked corpus. Kept letter/emoji-bearing so it is
// never coerced to a number (see letterPhraseArb rationale).
export const unicodeWordArb = fc.constantFrom(
  'café', 'naïve', 'Zürich', 'Москва', 'こんにちは', '你好', '😀', '🚀x', 'مرحبا', 'שלום',
);

/**
 * ASTRAL (non-BMP) code points — an emoji, a mathematical bold letter (a Unicode
 * LETTER), and a CJK extension-B ideograph — each glued to an ASCII letter so the
 * token is still a single markdown-inert "word".
 *
 * These exist to reach a shape the corpus was STRUCTURALLY unable to generate
 * (#515 review F2): an astral code point sitting IMMEDIATELY BEFORE or AFTER a
 * text run, with no space between. safeTextArb below always used to open and
 * close a run with an ASCII word, so an astral character could never land on a
 * run BOUNDARY — and a boundary is exactly where it matters: the serializer's
 * emphasis-flanking guard inspects the neighbouring character, and reading it as
 * a UTF-16 unit yields a lone SURROGATE, which used to be misclassified as a word
 * boundary and made the exporter emit markdown whose emphasis `marked` then
 * refuses to open (a byte-STABLE mark loss the round-trip property cannot see).
 *
 * `astralHeadArb` puts the astral char FIRST (it becomes the character right
 * after the preceding run), `astralTailArb` puts it LAST (right before the
 * following run). Markdown-inert by construction, so they cannot destabilize any
 * other property.
 */
const ASTRAL_CHARS = ['\u{1F642}', '\u{1F680}', '\u{1D400}', '\u{20000}'];

export const astralHeadArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...ASTRAL_CHARS), wordArb)
  .map(([c, w]) => c + w);

export const astralTailArb: fc.Arbitrary<string> = fc
  .tuple(wordArb, fc.constantFrom(...ASTRAL_CHARS))
  .map(([w, c]) => w + c);

/**
 * A "safe special" text string: a space-joined sequence of tokens that always
 * BEGINS and ENDS with an alphanumeric word (or, since #515, a word carrying an
 * ASTRAL code point on that very edge — see astralHeadArb/astralTailArb), with
 * any isolated special chars (or unicode words) confined to the MIDDLE, each
 * space-flanked by words.
 *
 * Both boundary guarantees matter (verbatim from the sibling test):
 *   * Leading word: the line never opens with a block/inline trigger
 *     (">", "*", "-", "#", "1." ...).
 *   * Trailing word: adjacent text runs CONCATENATE with no separator, so a run
 *     ending in a bare "<" beside a run starting with a letter would form a fake
 *     HTML tag. Ending every run with a word keeps every special internal and
 *     space-flanked even after concatenation.
 * An astral-bearing edge token preserves BOTH (an astral letter/emoji is not a
 * markdown trigger and cannot combine with a neighbouring run's characters into
 * one), while exposing the flanking boundary the corpus previously hid.
 */
export const safeTextArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.oneof(
      { weight: 5, arbitrary: wordArb },
      { weight: 1, arbitrary: astralHeadArb },
    ),
    fc.array(fc.oneof(wordArb, specialCharArb, unicodeWordArb), {
      minLength: 0,
      maxLength: 3,
    }),
    fc.oneof(
      { weight: 5, arbitrary: wordArb },
      { weight: 1, arbitrary: astralTailArb },
    ),
  )
  .map(([first, middle, last]) => [first, ...middle, last].join(' '));

/**
 * A plain alphanumeric phrase (1..3 words) for places where even isolated
 * specials are not wanted (e.g. code-block language, mention labels, status
 * text, table cells rendered on the plain-markdown path).
 */
export const phraseArb: fc.Arbitrary<string> = fc
  .array(wordArb, { minLength: 1, maxLength: 3 })
  .map((ws) => ws.join(' '));

/**
 * A phrase guaranteed to contain at least one letter. Used for image/media alt
 * text and link titles: a PURELY numeric alt/title (e.g. "0") is parsed back as
 * a NUMBER and then dropped by the converter's `value || ""` coercion — not
 * byte-stable. A letter anywhere keeps it a string. (Ported verbatim.)
 */
export const letterPhraseArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z]{1,4}$/),
    fc.array(wordArb, { minLength: 0, maxLength: 2 }),
  )
  .map(([head, rest]) => [head, ...rest].join(' '));

/** A paren/space-free URL — safe inside markdown link/image `(...)` syntax. */
export const urlArb: fc.Arbitrary<string> = fc
  .webUrl()
  .filter((u) => !/[()\s]/.test(u));

// ---------------------------------------------------------------------------
// Marked inline runs.
// (Ported from markdown-roundtrip.property.test.ts "markedTextRunArb".)
// ---------------------------------------------------------------------------

/**
 * A text run with an OPTIONAL single non-code formatting mark (bold/italic/
 * strike/underline/superscript/subscript/spoiler), a `code` mark ALONE or
 * COMBINED with another mark (#515 — `code` declares `excludes: ""` now, so the
 * combination is legal and byte-stable: the serializer nests the backtick span
 * inside the other marks, and a heterogeneous run of neighbours takes the
 * lossless schema-HTML fallback), or a link, or an inline comment anchor. Marks
 * wrap `safeTextArb`, which stays stable even when it contains isolated specials.
 *
 * The mark set here is broadened past the sibling test's {bold,italic,strike}
 * to also cover underline / superscript / subscript / spoiler / textStyle /
 * highlight, so the marks-on-text generator exercises every mark the schema
 * declares — now INCLUDING the `code`+other combinations (#515).
 *
 * Multi-mark runs are emitted in the schema's CANONICAL mark order (see
 * `canonicalMarks`): ProseMirror stores a node's marks sorted by schema rank, so
 * a generated doc that listed them in any other order would not be a doc the
 * editor can produce — and the P1 semantic property (which compares the
 * re-imported doc against the generated one field by field) would red on the
 * ORDER rather than on any real converter defect.
 */
export const markedTextRunArb: fc.Arbitrary<any> = fc.oneof(
  // Plain text.
  safeTextArb.map((t) => ({ type: 'text', text: t })),
  // Single formatting mark (attribute-free marks).
  fc
    .tuple(
      safeTextArb,
      fc.constantFrom('bold', 'italic', 'strike', 'underline', 'superscript', 'subscript', 'spoiler'),
    )
    .map(([t, m]) => ({ type: 'text', text: t, marks: [{ type: m }] })),
  // highlight with a color attr.
  fc
    .tuple(safeTextArb, fc.constantFrom('#ffcc00', '#a0e0ff', 'yellow'))
    .map(([t, color]) => ({ type: 'text', text: t, marks: [{ type: 'highlight', attrs: { color } }] })),
  // textStyle with a color attr.
  fc
    .tuple(safeTextArb, fc.constantFrom('#123456', '#ff0000', '#00aa88'))
    .map(([t, color]) => ({ type: 'text', text: t, marks: [{ type: 'textStyle', attrs: { color } }] })),
  // Sole code mark (backtick span). safeTextArb is backtick-free, so the span
  // content cannot contain an inner backtick.
  safeTextArb.map((t) => ({ type: 'text', text: t, marks: [{ type: 'code' }] })),
  // #515: `code` COMBINED with another attribute-free mark (bold/italic/strike/
  // underline/superscript/subscript/spoiler) or a color-less highlight — the
  // combination the schema used to forbid via `excludes: "_"`.
  fc
    .tuple(
      safeTextArb,
      fc.constantFrom(
        'bold',
        'italic',
        'strike',
        'underline',
        'superscript',
        'subscript',
        'spoiler',
        'highlight',
      ),
    )
    .map(([t, m]) => ({
      type: 'text',
      text: t,
      marks: canonicalMarks([{ type: 'code' }, { type: m }]),
    })),
  // #515: `code` + link (the code span becomes the link text: [`x`](href)).
  fc
    .tuple(phraseArb, urlArb)
    .map(([t, href]) => ({
      type: 'text',
      text: t,
      marks: canonicalMarks([{ type: 'code' }, { type: 'link', attrs: { href } }]),
    })),
  // #515: `code` + a COLORED highlight (an HTML-form mark, so the code span is
  // wrapped in <mark style=…> rather than `==…==`).
  fc
    .tuple(safeTextArb, fc.constantFrom('#ffcc00', 'yellow'))
    .map(([t, color]) => ({
      type: 'text',
      text: t,
      marks: canonicalMarks([
        { type: 'code' },
        { type: 'highlight', attrs: { color } },
      ]),
    })),
  // Link with safe text, a paren/space-free href, optionally a letter-bearing
  // title (a purely numeric title is coerced to a number and dropped).
  fc
    .tuple(phraseArb, urlArb, fc.option(letterPhraseArb, { nil: undefined }))
    .map(([t, href, title]) => ({
      type: 'text',
      text: t,
      marks: [{ type: 'link', attrs: title ? { href, title } : { href } }],
    })),
  // Inline comment anchor: a span[data-comment-id] that must survive byte-for-
  // byte. commentId is an alphanumeric token; `resolved` rides only when true.
  fc
    .tuple(safeTextArb, fc.stringMatching(/^[A-Za-z0-9]{4,10}$/), fc.boolean())
    .map(([t, commentId, resolved]) => ({
      type: 'text',
      text: t,
      marks: [
        { type: 'comment', attrs: resolved ? { commentId, resolved: true } : { commentId } },
      ],
    })),
);

// ---------------------------------------------------------------------------
// Inline atoms and inline-content assembly.
// (Ported from markdown-roundtrip.property.test.ts.)
// ---------------------------------------------------------------------------

/** Inline math node carrying LaTeX that includes the `a < b` the task asks for. */
export const mathInlineArb: fc.Arbitrary<any> = fc
  .constantFrom('a < b', 'x^2 + y^2', 'a < b < c', '\\frac{1}{2}', 'E = mc^2')
  .map((text) => ({ type: 'mathInline', attrs: { text } }));

/** Mention node; label/id/entity are plain phrases / uuids. */
export const mentionArb: fc.Arbitrary<any> = fc
  .tuple(phraseArb, fc.uuid(), fc.uuid())
  .map(([label, id, entityId]) => ({
    type: 'mention',
    attrs: { id, label, entityType: 'user', entityId },
  }));

export const hardBreakArb: fc.Arbitrary<any> = fc.constant({ type: 'hardBreak' });

/**
 * #515 review F2: a code+EMPHASIS run (the only shape that can glue a bare `**` /
 * `*` / `~~` / `==` delimiter to a backtick) sandwiched with NO separator between
 * a run ENDING in an astral code point and a run STARTING with one.
 *
 * This adjacency is what the serializer's flanking guard has to judge, and it is
 * the shape that used to lose the emphasis mark BYTE-STABLY (so P2, the byte
 * fixpoint, is blind to it; only P1's semantic comparison sees the missing mark).
 * Letting safeTextArb merely *permit* astral edges is not enough — the three
 * pieces have to LAND next to each other, which random assembly of a paragraph's
 * runs does only once in some hundreds of documents. Emitting them as one segment
 * makes the property reach the case on essentially every run of the suite.
 */
export const astralAdjacentCodeEmphasisArb: fc.Arbitrary<any[]> = fc
  .tuple(
    astralTailArb,
    phraseArb,
    fc.constantFrom('bold', 'italic', 'strike', 'highlight'),
    astralHeadArb,
  )
  .map(([before, codeText, emphasis, after]) => [
    { type: 'text', text: before },
    {
      type: 'text',
      text: codeText,
      marks: canonicalMarks([{ type: 'code' }, { type: emphasis }]),
    },
    { type: 'text', text: after },
  ]);

const sameMarks = (a: any[] | undefined, b: any[] | undefined): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/**
 * Canonicalize a generated inline-content array the way ProseMirror stores it,
 * then trim the markdown-fragile edges. (Ported verbatim from
 * markdown-roundtrip.property.test.ts "normalizeInline":)
 *   1) MERGE adjacent text runs with IDENTICAL marks (the editor coalesces
 *      them; split same-mark runs export to ambiguous "**a****b**").
 *   2) Collapse CONSECUTIVE hard breaks (two render a blank line marked eats).
 *   3) Drop a TRAILING hard break (removed by the converter's .trim()).
 */
export function normalizeInline(nodes: any[]): any[] {
  const out: any[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'hardBreak' && prev && prev.type === 'hardBreak') continue;
    if (
      node.type === 'text' &&
      prev &&
      prev.type === 'text' &&
      sameMarks(prev.marks, node.marks)
    ) {
      prev.text += node.text;
      continue;
    }
    out.push(node.type === 'text' ? { ...node } : node);
  }
  while (out.length > 1 && out[out.length - 1].type === 'hardBreak') out.pop();
  return out;
}

/**
 * #493 commit 1: a plain-text run whose text DELIBERATELY OPENS with a markdown
 * BLOCK trigger — ATX heading `#`, bullet `-`/`*`/`+`, blockquote `>`, ordered
 * `N.`/`N)`, or a table `|` — followed by safe text. Pre-#493 the corpus
 * self-censored these away (safeTextArb's leading-word guarantee); the paragraph
 * serializer now BLOCK-ESCAPES a leading trigger, so the generative round-trip
 * itself proves the data-loss class is closed rather than avoiding it.
 *
 * DELIBERATELY excludes the code-fence (backtick) trigger — the backtick is a
 * code-span delimiter that re-pairs globally (see specialCharArb's note), an
 * instability UNRELATED to block-escape — and the whole-line thematic break
 * (`---`), which only triggers when the line is ONLY dashes; both are covered by
 * the deterministic pin (gitmost-transcript-neutralization.test.ts). Each still
 * ENDS in a word (safeTextArb) so adjacent-run concatenation stays safe.
 */
export const blockTriggerLeadRunArb: fc.Arbitrary<any> = fc
  .tuple(
    fc.constantFrom('# ', '## ', '- ', '* ', '+ ', '> ', '1. ', '1) ', '| '),
    safeTextArb,
  )
  .map(([trigger, rest]) => ({ type: 'text', text: trigger + rest }));

/**
 * A hardBreak IMMEDIATELY followed by a block-trigger-leading run — a two-node
 * segment. Because a hardBreak serializes as `  \n`, the trigger then sits at
 * the START of a CONTINUATION line, exercising the serializer's PER-LINE block
 * escape (not just the first line). #493 review: without this the fuzzer never
 * placed a trigger after a hardBreak, so a single-line-only escape passed P1–P3.
 */
export const hardBreakThenTriggerArb: fc.Arbitrary<any[]> = fc
  .tuple(hardBreakArb, blockTriggerLeadRunArb)
  .map(([hb, trigger]) => [hb, trigger]);

/**
 * #493 (setext data-loss): a WHOLE-LINE setext underline landing on a
 * continuation line. A setext underline is a line of ONLY `-` (any count) or
 * ONLY `=` (any count) that FOLLOWS a paragraph line; on re-parse it turns the
 * preceding line into a heading and DROPS its own text. The block-escape must
 * neutralize it. Unlike blockTriggerLeadRunArb, the underline must occupy the
 * whole line, so we sandwich it between two hardBreaks (underline on its own
 * line, preceded by earlier paragraph content, followed by a trailing word so
 * the closing hardBreak is not dropped by normalizeInline). Covers underlines
 * of every length: `--` (the two-dash case the bullet/thematic arms miss), a
 * lone `=`, `==`/`====` (neutralized by the inline `==` escape), and `---`/
 * `----` (regression for the existing thematic case).
 */
export const hardBreakThenSetextArb: fc.Arbitrary<any[]> = fc
  .tuple(
    fc.constantFrom('--', '=', '==', '====', '---', '----'),
    safeTextArb,
  )
  .map(([underline, rest]) => [
    { type: 'hardBreak' },
    { type: 'text', text: underline },
    { type: 'hardBreak' },
    { type: 'text', text: rest },
  ]);

/**
 * Inline content for a paragraph: at least one marked text run, optionally with
 * inline atoms (math/mention) and hard breaks interspersed. The FIRST run is
 * usually an ordinary marked run, but sometimes a block-trigger-leading run
 * (blockTriggerLeadRunArb) so the paragraph OPENS with a markdown block trigger;
 * and a `hardBreak + trigger` segment can appear anywhere in the rest, so a
 * trigger also lands at the start of a CONTINUATION line — both exercising the
 * serializer's per-line block-escape end-to-end. (Ported, with the #493
 * leading-trigger + post-hardBreak dimensions added.)
 */
export const inlineContentArb: fc.Arbitrary<any[]> = fc
  .tuple(
    fc.oneof(
      { weight: 5, arbitrary: markedTextRunArb },
      { weight: 1, arbitrary: blockTriggerLeadRunArb },
    ),
    fc.array(
      fc.oneof(
        { weight: 5, arbitrary: markedTextRunArb.map((n) => [n]) },
        { weight: 1, arbitrary: mathInlineArb.map((n) => [n]) },
        { weight: 1, arbitrary: mentionArb.map((n) => [n]) },
        { weight: 1, arbitrary: hardBreakArb.map((n) => [n]) },
        { weight: 2, arbitrary: hardBreakThenTriggerArb },
        { weight: 2, arbitrary: hardBreakThenSetextArb },
        { weight: 2, arbitrary: astralAdjacentCodeEmphasisArb },
      ),
      { minLength: 0, maxLength: 4 },
    ),
  )
  .map(([first, rest]) => normalizeInline([first, ...rest.flat()]));

/**
 * Inline content for a HEADING — identical to a paragraph's, but WITHOUT hard
 * breaks. A hard break inside an ATX heading is not byte-stable (marked splits
 * the heading). (Ported.)
 */
export const headingInlineContentArb: fc.Arbitrary<any[]> = fc
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

/** Simple plain-text inline content (single run) for containers rendered on the
 * raw-HTML path (table cells / column bodies) where fancy inline is undesirable. */
export const plainInlineContentArb: fc.Arbitrary<any[]> = phraseArb.map((t) => [
  { type: 'text', text: t },
]);
