import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
// Real converter, imported the same way the sibling property test does.
import { convertProseMirrorToMarkdown } from '../../src/lib/markdown-converter.js';
// Importing markdownToProseMirror mutates the global DOM via jsdom at module
// load (expected, required for @tiptap/html's generateJSON under Node).
import { markdownToProseMirror } from '../../src/lib/markdown-to-prosemirror.js';
import { docsCanonicallyEqual, canonicalizeContent } from '../../src/lib/index.js';
import { firstDivergence } from '../roundtrip-helpers.js';
import {
  schema,
  allSchemaAttrKeys,
  allSchemaMarkAttrKeys,
  attrIsValueFuzzed,
} from './attr-arbitraries.js';
import {
  buildGenerators,
  coveredTypes,
  KNOWN_UNCOVERED,
} from './node-generators.js';
import { envInt } from './env-int.js';

// ── Attribute-value coverage allowlist ──────────────────────────────────────
// The node/mark completeness contract guarantees every TYPE is generated, but
// NOT that every attribute is exercised at a NON-DEFAULT value. An attribute
// with no `arb` in attr-arbitraries.ts is only ever tested at absent/default —
// an INVISIBLE coverage hole (the reviewer's concern). This allowlist makes that
// hole EXPLICIT: it is the exact set of attrs deliberately not value-fuzzed, so
// a NEW attribute (or a newly-frozen one) that lands in this bucket flips the
// snapshot test red and forces a reviewer to classify it. Each belongs to one of:
//   - internal/opaque ids & placeholders (attachmentId, slugId, placeholder,
//     creatorId, anchorId, mime) — no meaningful non-default to assert. These stay
//     frozen: their value is an opaque token carried verbatim, not a round-trip
//     shape worth fuzzing;
//   - ACCEPTED limitations with no md representation (indent, callout.icon,
//     orderedList.type, table spans/bg/colwidth).
// The media dimension/family attrs (image/video/youtube/drawio/excalidraw/pdf/
// embed width/height/align/size/aspectRatio/caption/title/alt) that were
// previously "deferred to a later PR" are IMPLEMENTED (value-fuzzed) in THIS PR
// via the OVERRIDES table in attr-arbitraries.ts — they ride in the discriminator
// comment JSON and round-trip byte-stably, so they are no longer allowlisted.
const ATTR_VALUE_FUZZ_ALLOWLIST = new Set<string>([
  'attachment.attachmentId', 'attachment.mime', 'attachment.placeholder', 'attachment.size',
  'audio.attachmentId', 'audio.placeholder', 'audio.size',
  'callout.icon',
  'drawio.attachmentId',
  'excalidraw.attachmentId',
  'heading.indent',
  'image.attachmentId', 'image.placeholder',
  'mention.anchorId', 'mention.creatorId', 'mention.slugId',
  'orderedList.type', 'paragraph.indent',
  'pdf.attachmentId', 'pdf.placeholder',
  'tableCell.backgroundColor', 'tableCell.backgroundColorName', 'tableCell.colspan',
  'tableCell.colwidth', 'tableCell.rowspan',
  'tableHeader.backgroundColor', 'tableHeader.backgroundColorName', 'tableHeader.colspan',
  'tableHeader.colwidth', 'tableHeader.rowspan',
  'video.attachmentId', 'video.placeholder',
]);

// ── MARK attribute-value coverage ───────────────────────────────────────────
// Marks are fuzzed by the text generator (text-arbitraries.ts markedTextRunArb),
// not the node OVERRIDES table, so their value-fuzz coverage is tracked with this
// separate registry — otherwise the "no invisible coverage hole" guarantee would
// hold for node attrs only, and a new mark attr (or a new attributed mark) would
// silently escape the fuzz set. Every schema mark attr must be in exactly one of:
//   MARK_ATTR_FUZZED    — actually driven at a non-default value by the generator;
//   MARK_ATTR_ALLOWLIST — deliberately not value-fuzzed, with a reason.
const MARK_ATTR_FUZZED = new Set<string>([
  'mark:link.href', // markedTextRunArb sets a random webUrl href
  'mark:link.title', // ...and an optional letter-bearing title
  'mark:highlight.color', // highlight mark carries a generated color
  'mark:textStyle.color', // textStyle mark carries a generated color
  'mark:comment.commentId', // comment anchor id (alphanumeric token)
  'mark:comment.resolved', // comment resolved flag (rides only when true)
]);
const MARK_ATTR_ALLOWLIST = new Set<string>([
  // link presentational/routing attrs: not part of the markdown link surface the
  // converter emits (it round-trips href + title only), so there is no
  // non-default value to assert here — a deferred concern for a link-specific
  // fixture, not the flat generative pass.
  'mark:link.internal',
  'mark:link.target',
  'mark:link.rel',
  'mark:link.class',
]);

// Each run does a real convert + marked + jsdom parse (~ms). Give ample headroom
// so the suite is deterministic regardless of parallel worker load (like the
// sibling property file).
vi.setConfig({ testTimeout: 30000 });

// ---------------------------------------------------------------------------
// #351 PR 1 — GENERATIVE (property-based) round-trip over FLAT (single-node)
// documents at the ATTRIBUTE level.
//
// We assert three invariants for ANY generated valid flat document `d`
// (pmToMd = convertProseMirrorToMarkdown, mdToPm = markdownToProseMirror):
//
//   P1 — semantic round-trip (nothing lost):
//        docsCanonicallyEqual(await mdToPm(pmToMd(d)), d) === true
//   P2 — byte fixpoint (anti "GS-EDIT-REVERT" churn):
//        pmToMd(await mdToPm(pmToMd(d))) === pmToMd(d)
//   P3 — totality: neither converter throws; bounded.
//
// The generators are schema-DERIVED (attribute lists come from
// schema.nodes[type].spec.attrs) and stay inside the round-trip-supported space
// proven empirically by probing the live converter (see attr-arbitraries.ts and
// text-arbitraries.ts). P1 runs over the safe attribute space; P2/P3 run over
// the wider 'fuzz' space that also injects degenerate attribute states, which
// P2 tolerates via a one-time first-pass normalization and P3 via totality only.
// ---------------------------------------------------------------------------

// Fixed seed so every failure is reproducible; fast-check also prints the
// shrunk counterexample. numRuns starts modest to keep CI under budget — the
// issue's CI target is ~300-500 per property. Both are overridable via the
// PROPERTY_SEED / PROPERTY_NUM_RUNS env vars (an invalid/empty value → NaN →
// falls back to the default below): the nightly cron
// (.github/workflows/nightly-property.yml) cranks NUM_RUNS to ~5000 with a
// random seed to hunt for deeper counterexamples. Each property runs over the
// UNION (fc.oneof) of all flat node generators, so the runs are shared across
// node types (one test per property keeps the jsdom import cost and memory
// bounded — a per-generator × per-property matrix is ~200 heavy tests that
// OOMs the worker).
// An unset/empty/non-numeric value falls back to the default; an explicit 0 is
// honored (a valid fast-check seed) — `Number(x) || default` would swallow it.
// The parser is shared with the nested suite (env-int.ts) and unit-tested there.
const SEED = envInt(process.env.PROPERTY_SEED, 20250705);
const NUM_RUNS = envInt(process.env.PROPERTY_NUM_RUNS, 300);

const P1_GENERATORS = buildGenerators('p1');
const FUZZ_GENERATORS = buildGenerators('fuzz');

// Union arbitraries: a single draw picks one node generator, then a document
// from it. On failure fast-check prints the shrunk counterexample doc, which
// names the offending node type directly.
const p1Union = fc.oneof(...P1_GENERATORS.map((g) => g.arb));
const fuzzUnion = fc.oneof(...FUZZ_GENERATORS.map((g) => g.arb));

async function roundTrip(doc: unknown): Promise<{ md1: string; md2: string; doc2: any }> {
  const md1 = convertProseMirrorToMarkdown(doc);
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, md2, doc2 };
}

describe('#351 flat generative round-trip — completeness contract', () => {
  it('every schema node and mark is covered by a generator or explicitly allowlisted', () => {
    const covered = coveredTypes();
    const uncovered: string[] = [];

    for (const nodeType of Object.keys(schema.nodes)) {
      if (covered.has(nodeType)) continue;
      if (nodeType in KNOWN_UNCOVERED) continue;
      uncovered.push(`node:${nodeType}`);
    }
    for (const markType of Object.keys(schema.marks)) {
      if (covered.has(`mark:${markType}`)) continue;
      if (markType in KNOWN_UNCOVERED) continue;
      uncovered.push(`mark:${markType}`);
    }

    // A new node/mark added to the schema with no generator AND no allowlist
    // entry MUST turn this test red — that is the whole point (no silent blind
    // spots).
    expect(
      uncovered,
      `these schema types have no generator and no KNOWN_UNCOVERED reason:\n  ${uncovered.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });

  it('every KNOWN_UNCOVERED entry is a real schema type (no stale allowlist rows)', () => {
    const all = new Set([...Object.keys(schema.nodes), ...Object.keys(schema.marks)]);
    for (const t of Object.keys(KNOWN_UNCOVERED)) {
      expect(all.has(t), `stale KNOWN_UNCOVERED entry: ${t}`).toBe(true);
    }
  });

  it('every attribute is value-fuzzed OR explicitly allowlisted (no invisible hole)', () => {
    // Makes the "generic-frozen" coverage hole VISIBLE: any schema attr not
    // exercised at a non-default value must be a KNOWN entry in the allowlist.
    // A new attr (or one that loses its `arb`) that falls into the not-fuzzed
    // bucket without an allowlist row turns this red — no silent blind spots.
    const unaccounted: string[] = [];
    for (const key of allSchemaAttrKeys()) {
      const i = key.indexOf('.');
      const fuzzed = attrIsValueFuzzed(key.slice(0, i), key.slice(i + 1));
      if (!fuzzed && !ATTR_VALUE_FUZZ_ALLOWLIST.has(key)) unaccounted.push(key);
    }
    expect(
      unaccounted,
      `these attrs are not value-fuzzed and not in ATTR_VALUE_FUZZ_ALLOWLIST:\n  ${unaccounted.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });

  it('the attribute allowlist has no stale rows (every entry is really not-fuzzed)', () => {
    const notFuzzed = new Set(
      allSchemaAttrKeys().filter((key) => {
        const i = key.indexOf('.');
        return !attrIsValueFuzzed(key.slice(0, i), key.slice(i + 1));
      }),
    );
    for (const key of ATTR_VALUE_FUZZ_ALLOWLIST) {
      expect(
        notFuzzed.has(key),
        `stale allowlist row (attr is now value-fuzzed, remove it): ${key}`,
      ).toBe(true);
    }
  });

  it('every MARK attribute is value-fuzzed OR allowlisted (no invisible hole)', () => {
    // The node guard above covers node attrs; marks are fuzzed by the text
    // generator, so their coverage is tracked separately. A new mark attr (or a
    // newly-attributed mark) that lands in neither set turns this red.
    const unaccounted: string[] = [];
    for (const key of allSchemaMarkAttrKeys()) {
      if (!MARK_ATTR_FUZZED.has(key) && !MARK_ATTR_ALLOWLIST.has(key)) {
        unaccounted.push(key);
      }
    }
    expect(
      unaccounted,
      `these mark attrs are neither in MARK_ATTR_FUZZED nor MARK_ATTR_ALLOWLIST:\n  ${unaccounted.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });

  it('the MARK fuzz/allowlist sets have no stale rows (every entry is a real schema mark attr)', () => {
    const all = new Set(allSchemaMarkAttrKeys());
    for (const key of [...MARK_ATTR_FUZZED, ...MARK_ATTR_ALLOWLIST]) {
      expect(all.has(key), `stale mark-attr registry row: ${key}`).toBe(true);
    }
  });
});

describe('#351 flat generative round-trip — properties', () => {
  it('generator validity: every generated doc passes schema.check()', () => {
    // A generator that emits an invalid ProseMirror document is a GENERATOR bug.
    fc.assert(
      fc.property(fuzzUnion, (doc) => {
        schema.nodeFromJSON(doc).check(); // throws on an invalid doc
        return true;
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('P1 — semantic round-trip: docsCanonicallyEqual(mdToPm(pmToMd(d)), d)', async () => {
    await fc.assert(
      fc.asyncProperty(p1Union, async (doc) => {
        const { doc2 } = await roundTrip(doc);
        if (!docsCanonicallyEqual(doc2, doc)) {
          // Surface the precise divergence in the failure message.
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
      fc.asyncProperty(fuzzUnion, async (doc) => {
        const { md1, md2 } = await roundTrip(doc);
        expect(md2).toBe(md1);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('P3 — totality: neither converter throws', async () => {
    await fc.assert(
      fc.asyncProperty(fuzzUnion, async (doc) => {
        // Throwing here fails the property; fast-check shrinks to a minimal doc.
        await roundTrip(doc);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });
});
