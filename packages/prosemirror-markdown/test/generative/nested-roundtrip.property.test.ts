import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
// Real converters. Importing markdownToProseMirror (transitively, via index)
// mutates the global DOM via jsdom at module load — expected, required for
// @tiptap/html's generateJSON under Node (same as the flat sibling suite).
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  docsCanonicallyEqual,
  canonicalizeContent,
} from '../../src/lib/index.js';
import { firstDivergence } from '../roundtrip-helpers.js';
import { schema, docArb } from './doc-generator.js';
import { envInt } from './env-int.js';

// Each run does a real convert + jsdom parse; give ample headroom so the suite
// is deterministic under parallel worker load (matching the flat sibling suite).
vi.setConfig({ testTimeout: 60000 });

// ---------------------------------------------------------------------------
// #351 PR 2 — GENERATIVE round-trip over NESTED (whole-document) docs produced
// by the ContentMatch random walk (doc-generator.ts). The invariants mirror the
// flat suite, plus a parser-fuzz totality property (P4):
//
//   P1 — semantic round-trip: docsCanonicallyEqual(mdToPm(pmToMd(d)), d)
//   P2 — byte fixpoint (2nd pass): pmToMd(mdToPm(pmToMd(d))) === pmToMd(d)
//        (the FIRST pass may normalize once; the SECOND pass must be a fixpoint)
//   P3 — totality: neither converter throws; bounded.
//   P4 — parser fuzz totality: for ANY string, markdownToProseMirror does NOT
//        throw and returns a SCHEMA-VALID document.
//
// GUARDRAIL: a P1/P2/P3/P4 failure means the generator FOUND A REAL CONVERTER
// BUG. These invariants are kept STRICT — no it.fails / skip / weakening. A
// failure prints the shrunk minimal counterexample for triage.
// ---------------------------------------------------------------------------

// Both are overridable via the PROPERTY_SEED / PROPERTY_NUM_RUNS env vars (an
// invalid/empty value → NaN → falls back to the default below); the nightly
// cron (.github/workflows/nightly-property.yml) cranks NUM_RUNS up with a
// random seed to hunt for deeper counterexamples.
// An unset/empty/non-numeric value falls back to the default; an explicit 0 is
// honored (a valid fast-check seed) — `Number(x) || default` would swallow it.
// The parser is shared with the flat suite (env-int.ts) and unit-tested there.
const SEED = envInt(process.env.PROPERTY_SEED, 20250705);
// The nested walk builds far heavier docs than the flat suite (each P1/P2 run
// parses the emitted markdown through jsdom), so keep the run count moderate to
// hold runtime and worker memory in budget while still exercising deep
// structures. P4 (cheap string parsing) runs at a higher count below.
const NUM_RUNS = envInt(process.env.PROPERTY_NUM_RUNS, 100);

const pmToMd = (doc: unknown): string => convertProseMirrorToMarkdown(doc);
const mdToPm = (md: string): Promise<any> => markdownToProseMirror(md);

async function roundTrip(doc: unknown): Promise<{ md1: string; md2: string; doc2: any }> {
  const md1 = pmToMd(doc);
  const doc2 = await mdToPm(md1);
  const md2 = pmToMd(doc2);
  return { md1, md2, doc2 };
}

describe('#351 nested generative round-trip — generator validity', () => {
  it('every generated nested doc passes schema.nodeFromJSON(...).check()', () => {
    // A nested generator that emits an invalid ProseMirror document is a
    // GENERATOR bug — the ContentMatch walk must only produce schema-valid docs.
    fc.assert(
      fc.property(docArb, (doc) => {
        schema.nodeFromJSON(doc).check(); // throws on an invalid doc
        return true;
      }),
      { numRuns: NUM_RUNS * 2, seed: SEED },
    );
  });
});

// ── STATUS: P1/P2/P3/P4 all GREEN. The nested generator originally surfaced a
// batch of real converter bugs; all were fixed in the serializer/parser (see the
// #351 hand-off). For the record, the classes it found and that are now fixed:
//   • Loose (multi-block) list items / task items / callouts / details bodies were
//     joined with a single "\n", so every block after the first merged into the
//     first paragraph on re-parse (silent content loss) — now blank-line separated.
//   • Paragraph `textAlign` was dropped inside a TIGHT list item (no <p> host).
//   • A nested codeBlock lost its trailing newline on the raw-HTML path.
//   • Media (embed/video/youtube/drawio/excalidraw) inside `columns` churned a
//     default `data-align` and coerced embed's numeric width/height to strings.
//   • pageBreak / pageEmbed / subpages / transclusion were dropped when nested in
//     blockquote / callout / details / list item (standalone-comment position).
//   • Callouts nested in a list item or a blockquote (`  > [!type]` / `> > [!type]`)
//     were re-parsed as plain blockquotes (prefix-unaware callout preprocessor).
//   • Two adjacent sibling lists sharing a marker family (bulletList/taskList →
//     `<ul>`; orderedList → `<ol>`) merged into one list on re-parse — and for the
//     cross-type case (taskList beside bulletList) the merged `<ul>` LOST every
//     taskItem checkbox. The serializer now emits a `<!-- -->` separator between
//     such adjacent lists (markdown-converter.ts renderBlockChildren), so they stay
//     distinct and round-trip; the generator therefore emits them freely again.
describe('#351 nested generative round-trip — properties', () => {
  it('P1 — semantic round-trip: docsCanonicallyEqual(mdToPm(pmToMd(d)), d)', async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (doc) => {
        const { doc2 } = await roundTrip(doc);
        if (!docsCanonicallyEqual(doc2, doc)) {
          const div = firstDivergence(
            JSON.parse(JSON.stringify(canonicalizeContent(doc2))),
            JSON.parse(JSON.stringify(canonicalizeContent(doc))),
          );
          throw new Error(
            `P1 divergence @ ${div?.path}: got=${JSON.stringify(div?.a)} want=${JSON.stringify(div?.b)}`,
          );
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('P2 — byte fixpoint: pmToMd(mdToPm(pmToMd(d))) === pmToMd(d)', async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (doc) => {
        const { md1, md2 } = await roundTrip(doc);
        expect(md2).toBe(md1);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('P3 — totality: neither converter throws', async () => {
    await fc.assert(
      fc.asyncProperty(docArb, async (doc) => {
        await roundTrip(doc);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// P4 — parser fuzz. Independent of the doc generator: for ANY input string the
// PARSER (markdownToProseMirror) must be TOTAL — never throw — and must always
// return a schema-valid document. The corpus mixes raw unicode strings with
// strings assembled from markdown-significant fragments (headings, list bullets,
// fences, pipes, thematic breaks, HTML-ish snippets) to probe the block/inline
// parsers on hostile but plausible input.
// ---------------------------------------------------------------------------

const mdFragmentArb: fc.Arbitrary<string> = fc.constantFrom(
  '# ', '## ', '### ###', '- ', '* ', '+ ', '1. ', '> ', '>> ',
  '```', '```js', '~~~', '---', '***', '___', '| a | b |', '|---|---|',
  '[link](http://x)', '![img](http://x)', '**', '__', '~~', '`code`',
  '<div>', '</div>', '<b>', '<!-- c -->', '<table>', '<br>', '&amp;',
  '\t', '\n', '  ', '\\', '^[fn]', '[^1]:', '- [ ] ', '- [x] ',
  '$$', '$x$', ':::', '{.class}', '\u0000', '\uFEFF', '😀', 'مرحبا',
);

// Full-unicode strings (fast-check v4 replaced fullUnicodeString with the
// `unit: 'binary'` string option, which draws over the whole code-point range).
const fullUnicodeStringArb = (max?: number) =>
  fc.string({ unit: 'binary', ...(max !== undefined ? { maxLength: max } : {}) });

const assembledMarkdownArb: fc.Arbitrary<string> = fc
  .array(fc.oneof(mdFragmentArb, fc.string(), fullUnicodeStringArb(8)), {
    minLength: 1,
    maxLength: 12,
  })
  .map((parts) => parts.join(''));

const parserInputArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.string() },
  { weight: 2, arbitrary: fullUnicodeStringArb() },
  { weight: 3, arbitrary: assembledMarkdownArb },
  { weight: 1, arbitrary: fc.array(mdFragmentArb, { minLength: 1, maxLength: 8 }).map((p) => p.join('\n')) },
);

describe('#351 parser fuzz — totality on arbitrary input (P4)', () => {
  it('P4 — markdownToProseMirror never throws and always returns a schema-valid doc', async () => {
    await fc.assert(
      fc.asyncProperty(parserInputArb, async (s) => {
        let result: any;
        try {
          result = await mdToPm(s);
        } catch (e: any) {
          throw new Error(`P4 parser THREW on input ${JSON.stringify(s)}: ${e?.message ?? e}`);
        }
        try {
          schema.nodeFromJSON(result).check();
        } catch (e: any) {
          throw new Error(
            `P4 parser produced an INVALID doc for input ${JSON.stringify(s)}: ${e?.message ?? e}\n` +
              `doc=${JSON.stringify(result).slice(0, 600)}`,
          );
        }
      }),
      { numRuns: NUM_RUNS * 2, seed: SEED },
    );
  });
});
