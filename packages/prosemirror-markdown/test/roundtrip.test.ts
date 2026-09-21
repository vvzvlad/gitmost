import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
} from 'docmost-client';
// Import canonical-equality DIRECTLY from src so we exercise the real
// implementation alongside the converter pair above (the barrel re-exports the
// same symbol; importing from src keeps these round-trip assertions pinned to
// the package source rather than the published surface).
import { docsCanonicallyEqual } from '../src/lib/canonicalize.js';

// Resolve the fixture relative to this test file so the test is CWD-independent.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample-doc.json');

describe('round-trip idempotency (SPEC §11)', () => {
  it('markdown is byte-stable across export -> import -> export', async () => {
    const doc = JSON.parse(await readFile(FIXTURE, 'utf8'));

    // export -> import -> export
    const md1 = convertProseMirrorToMarkdown(doc);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);

    // The property git actually needs: a second export reproduces the first
    // byte-for-byte. We intentionally do NOT deep-equal doc vs doc2 — the
    // converter reconstructs schema default attrs (e.g. indent:null), a known
    // SPEC §11 divergence that does not affect markdown stability.
    expect(md2).toBe(md1);
  });
});

// ---------------------------------------------------------------------------
// Full export -> import -> export round-trips for the schema's HTML-carried
// atoms/blocks (math, mention, details). The existing markdown-converter unit
// tests only assert the one-way emit string; here we additionally pin that the
// re-import (generateJSON via the docmost schema) rebuilds the correct node and
// that a second export reproduces the first byte-for-byte. Helpers mirror the
// converter unit tests (a single-node doc renders exactly that node, trimmed).
// ---------------------------------------------------------------------------
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string) => ({ type: 'text', text: t });
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

// Run the canonical export -> import -> export cycle for a single block node.
async function roundTrip(
  node: any,
): Promise<{ md1: string; doc2: any; md2: string }> {
  const md1 = convertProseMirrorToMarkdown(doc(node));
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, doc2, md2 };
}

describe('math round-trip (mathBlock + mathInline)', () => {
  it('mathBlock survives export -> import -> export with LaTeX recovered', async () => {
    const source = { type: 'mathBlock', attrs: { text: 'a^2+b^2' } };
    const { md1, doc2, md2 } = await roundTrip(source);

    // #293 canon #6: block math emits a `$$` fence on its own lines.
    expect(md1).toBe('$$\na^2+b^2\n$$');
    // Byte-stable: the second export reproduces the first exactly.
    expect(md2).toBe(md1);

    // The re-imported doc's only block is a mathBlock whose LaTeX was recovered
    // from the text= attribute by the schema's default parser.
    const block = doc2.content[0];
    expect(block.type).toBe('mathBlock');
    expect(block.attrs.text).toBe('a^2+b^2');

    // Canonical equality: source and re-imported doc are the same node.
    expect(docsCanonicallyEqual(doc(source), doc2)).toBe(true);
  });

  it('mathInline (inside a paragraph) survives export -> import -> export', async () => {
    const source = para({ type: 'mathInline', attrs: { text: 'x_i' } });
    const { md1, doc2, md2 } = await roundTrip(source);

    // #293 canon #6: inline math emits the Obsidian-native `$LaTeX$` form.
    expect(md1).toBe('$x_i$');
    expect(md2).toBe(md1);

    // The re-imported paragraph's child is a mathInline with the LaTeX recovered.
    const paragraph = doc2.content[0];
    expect(paragraph.type).toBe('paragraph');
    const inline = paragraph.content[0];
    expect(inline.type).toBe('mathInline');
    expect(inline.attrs.text).toBe('x_i');

    expect(docsCanonicallyEqual(doc(source), doc2)).toBe(true);
  });
});

describe('mention round-trip', () => {
  it('mention survives export -> import -> export with data-* re-parsed', async () => {
    const source = para({
      type: 'mention',
      attrs: { id: 'u1', label: 'Alice', entityType: 'user' },
    });
    const { md1, doc2, md2 } = await roundTrip(source);

    // One-way emit: schema span with data-* attrs and the visible '@Alice' text.
    expect(md1).toBe(
      '<span data-type="mention" data-id="u1" data-label="Alice" data-entity-type="user">@Alice</span>',
    );
    // Byte-stable.
    expect(md2).toBe(md1);

    // The visible '@Alice' is cosmetic; generateJSON rebuilds a mention node from
    // the data-* attributes. The unset attrs fall back to their schema defaults.
    const paragraph = doc2.content[0];
    expect(paragraph.type).toBe('paragraph');
    const mention = paragraph.content[0];
    expect(mention.type).toBe('mention');
    expect(mention.attrs.id).toBe('u1');
    expect(mention.attrs.label).toBe('Alice');
    expect(mention.attrs.entityType).toBe('user');
    expect(mention.attrs.entityId).toBeNull();
    expect(mention.attrs.slugId).toBeNull();
    expect(mention.attrs.creatorId).toBeNull();
    expect(mention.attrs.anchorId).toBeNull();

    expect(docsCanonicallyEqual(doc(source), doc2)).toBe(true);
  });
});

describe('#554 literal <br> in text is not converted to a hardBreak', () => {
  // Count hardBreak nodes anywhere in a doc tree.
  const countHardBreaks = (n: any): number => {
    if (!n) return 0;
    let c = n.type === 'hardBreak' ? 1 : 0;
    for (const ch of n.content || []) c += countHardBreaks(ch);
    return c;
  };
  // Concatenate every text run's content in a doc tree.
  const collectText = (n: any): string => {
    if (!n) return '';
    if (n.type === 'text') return n.text || '';
    let s = '';
    for (const ch of n.content || []) s += collectText(ch);
    return s;
  };

  // Each literal break-tag variant a user could TYPE into prose. On import
  // marked would otherwise parse these as an inline-HTML line break, silently
  // turning the typed text into a hardBreak node and dropping the text.
  for (const literal of ['a<br>b', 'a<br/>b', 'a<br />b']) {
    it(`"${literal}" round-trips as literal text with ZERO hardBreaks`, async () => {
      const source = para(text(literal));
      const { md1, doc2, md2 } = await roundTrip(source);

      // The break tag's angle brackets are HTML-entity-encoded in the markdown
      // so marked passes them through as literal text instead of a break.
      expect(md1).toContain('&lt;br');
      expect(md1).not.toMatch(/<\s*br/i);
      // Byte-stable second export.
      expect(md2).toBe(md1);

      // The re-imported doc has NO hardBreak and its text still contains the
      // literal `<br>` the user typed.
      expect(countHardBreaks(doc2)).toBe(0);
      expect(collectText(doc2)).toContain('<br');
    });
  }

  it('a real hardBreak node still serializes and re-imports as a hardBreak', async () => {
    const source = para(text('a'), { type: 'hardBreak' }, text('b'));
    const { md1, doc2, md2 } = await roundTrip(source);

    // The hardBreak case emits the two-space markdown form, NOT a `<br>`, so
    // the literal-text escaping above never touches the serializer's own break.
    expect(md1).toBe('a  \nb');
    expect(md2).toBe(md1);
    expect(countHardBreaks(doc2)).toBe(1);
  });

  it('ordinary stray angle brackets in prose are left untouched (no over-escape)', async () => {
    const source = para(text('a < b > c'));
    const { md1, doc2, md2 } = await roundTrip(source);

    // Only the `<br…>` pattern is escaped; a lone `<`/`>` is not.
    expect(md1).toBe('a < b > c');
    expect(md2).toBe(md1);
    expect(collectText(doc2)).toContain('a < b > c');
  });
});

describe('details open-attribute round-trip', () => {
  it('the markdown details fence never carries an open flag and stays byte-stable', async () => {
    // Source details is OPEN (attrs.open: ''), but the top-level markdown path
    // emits a plain '<details>' fence (no 'open' attribute) — see converter
    // case "detailsSummary" which hardcodes '<details>\n<summary>...'.
    const source = {
      type: 'details',
      attrs: { open: '' },
      content: [
        { type: 'detailsSummary', content: [text('S')] },
        { type: 'detailsContent', content: [para(text('body'))] },
      ],
    };
    const { md1, doc2, md2 } = await roundTrip(source);

    // The emitted fence drops the open flag entirely.
    expect(md1).toBe('<details>\n<summary>S</summary>\n\nbody\n</details>');
    expect(md1).not.toContain('open');

    // Byte-stable: re-export reproduces the same fence.
    expect(md2).toBe(md1);

    // NOTE(review): the spec text says doc2's details attrs.open should be
    // `null` (the raw return of el.getAttribute('open') on a plain <details>,
    // schema src ~L438). In practice generateJSON applies the schema attribute
    // default when the parseHTML result is null, so the materialised node carries
    // attrs.open === false (the declared default at src ~L437), NOT null. We
    // assert the ACTUAL value. The load-bearing point of the spec still holds:
    // a plain <details> import does NOT recover the open flag (no truthy value),
    // so renderHTML's `attrs.open ? {open:''} : {}` keeps the round-trip clean.
    const details = doc2.content[0];
    expect(details.type).toBe('details');
    expect(details.attrs.open).toBe(false);
    expect(details.attrs.open).toBeFalsy();
  });
});
