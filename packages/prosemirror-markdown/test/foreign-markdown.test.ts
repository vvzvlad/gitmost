import { describe, it, expect } from 'vitest';
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';
import {
  normalizeForeignMarkdown,
  normalizeAgentMarkdown,
} from '../src/lib/foreign-markdown.js';

/**
 * STEP 2 goldens for issue #345 (moved into the package with the normalizer in
 * #493): the foreign-markdown normalizer that runs at the import boundary BEFORE
 * the strict canonical parser (`markdownToProseMirror`).
 *
 * Two layers:
 *  1. PURE string→string cases pinning the normalizer's own behavior (GFM
 *     reference footnotes → inline `^[…]`).
 *  2. END-TO-END acceptance: for a foreign corpus, `normalizeForeignMarkdown`
 *     then `markdownToProseMirror` then `convertProseMirrorToMarkdown` must leave
 *     NO literal `[^id]` / `:::` garbage in the document and must re-export in the
 *     canonical forms.
 */

describe('normalizeForeignMarkdown — GFM reference footnotes', () => {
  it('inlines a single-line reference footnote and drops its definition', () => {
    const out = normalizeForeignMarkdown(
      'A note[^1] here.\n\n[^1]: The definition.',
    );
    expect(out).toBe('A note^[The definition.] here.\n');
  });

  it('inlines every reference to a reused id (downstream dedups)', () => {
    const out = normalizeForeignMarkdown(
      'X[^a] and Y[^a].\n\n[^a]: shared.',
    );
    expect(out).toBe('X^[shared.] and Y^[shared.].\n');
  });

  it('joins indented continuation lines of a definition with a space', () => {
    const out = normalizeForeignMarkdown(
      'See[^n].\n\n[^n]: line one\n    line two',
    );
    expect(out).toBe('See^[line one line two].\n');
  });

  it('never rewrites a reference inside a fenced code block', () => {
    const out = normalizeForeignMarkdown(
      '```\ncode[^1] here\n```\n\n[^1]: def.',
    );
    expect(out).toContain('code[^1] here');
    // The (now orphaned) definition line is still removed.
    expect(out).not.toContain('[^1]: def.');
  });

  it('never rewrites a reference inside an INLINE-code span (backticks)', () => {
    // The `[^1]` inside backticks is literal code and must survive verbatim;
    // the one outside is rewritten. (Bug #1: only fenced blocks were protected.)
    const out = normalizeForeignMarkdown(
      'Use `arr[^1]` in code but note[^1] in prose.\n\n[^1]: def.',
    );
    expect(out).toBe('Use `arr[^1]` in code but note^[def.] in prose.\n');
  });

  it('escapes brackets in a body so an unbalanced ] cannot truncate the footnote', () => {
    // A foreign definition body with a stray `]` would, unescaped, close the
    // canonical `^[...]` early and leak the tail as text (bug #2). The body's
    // brackets are backslash-escaped so the footnote stays whole.
    const out = normalizeForeignMarkdown(
      'Ref[^1] here.\n\n[^1]: see item ] and [more] later',
    );
    expect(out).toBe('Ref^[see item \\] and \\[more\\] later] here.\n');
    // The tokenizer must see exactly one unescaped closing bracket (our own).
    expect(out.match(/(?<!\\)\]/g)).toHaveLength(1);
  });

  it('leaves a reference with no matching definition literal (no body to inline)', () => {
    const out = normalizeForeignMarkdown('Dangling[^x] ref.');
    expect(out).toBe('Dangling[^x] ref.');
  });

  it('returns the input unchanged when there are no reference footnotes', () => {
    const md = '# Title\n\nJust text with `inline code` and a [link](/x).';
    expect(normalizeForeignMarkdown(md)).toBe(md);
  });

  it('does NOT touch callout surfaces — the canonical parser handles them', () => {
    const callouts = ':::info\nHi\n:::\n\n> [!warning]\n> Careful';
    expect(normalizeForeignMarkdown(callouts)).toBe(callouts);
  });

  it('strips a leading YAML front-matter block (Obsidian/Hugo/git-sync files)', () => {
    const out = normalizeForeignMarkdown(
      '---\ntitle: My Page\ntags: [a, b]\n---\n\n# Heading\n\nBody.',
    );
    expect(out).toBe('# Heading\n\nBody.');
    // The front-matter must not leak into the body as a setext heading.
    expect(out).not.toContain('title: My Page');
    expect(out).not.toContain('---');
  });

  it('does not strip a horizontal rule that is not leading front-matter', () => {
    const md = 'Intro paragraph.\n\n---\n\nAfter the rule.';
    expect(normalizeForeignMarkdown(md)).toBe(md);
  });

  it('is linear on a document with thousands of definitions (no quadratic blowup)', () => {
    // F2(a): the pass-2 rewrite must be O(text), not O(text × defs). Build a
    // pathological doc (many defs + many plain text lines) and assert it
    // completes well under a second — a quadratic implementation took ~14s.
    const N = 4000;
    const refs = Array.from({ length: N }, (_, i) => `line ${i} plain text`).join('\n');
    const defs = Array.from({ length: N }, (_, i) => `[^n${i}]: def ${i}`).join('\n');
    const doc = `start[^n0] and[^n${N - 1}] end\n\n${refs}\n\n${defs}`;
    const t0 = Date.now();
    const out = normalizeForeignMarkdown(doc);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    // Sanity: the two real references were still inlined.
    expect(out).toContain('^[def 0]');
    expect(out).toContain(`^[def ${N - 1}]`);
  });

  it('is bounded on a long unclosed backtick run (no inline-split ReDoS)', () => {
    // F2(b): a huge unterminated backtick run must not cause quadratic
    // backtracking in the inline-code split. Oversized lines skip the split
    // entirely (left untouched), so this returns promptly.
    const line = 'x' + '`'.repeat(200000);
    const doc = `${line}\n\n[^1]: def`;
    const t0 = Date.now();
    normalizeForeignMarkdown(doc);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('does not crash or slow down on thousands of prefix-chain definition ids', () => {
    // F7: the rewrite must use a FIXED generic scanner, not an alternation built
    // from the ids. A `(a|aa|aaa|…)` alternation over prefix-chain ids blows the
    // V8 regex compiler (FATAL RegExpCompiler Allocation failed — uncatchable,
    // kills the process). A fixed scanner has no id-dependent compilation cost.
    const N = 4000;
    const ids = Array.from({ length: N }, (_, i) => 'a'.repeat(i + 1));
    const defs = ids.map((id) => `[^${id}]: body ${id.length}`).join('\n');
    const doc = `ref[^${ids[0]}] and[^${ids[N - 1]}] end\n\n${defs}`;
    const t0 = Date.now();
    const out = normalizeForeignMarkdown(doc);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Prefix disambiguation is correct: [^a] and [^aaaa...] inline their OWN body.
    expect(out).toContain('^[body 1]');
    expect(out).toContain(`^[body ${N}]`);
  });

  it('strips a CRLF (Windows) front-matter block, not just LF', () => {
    // F9: the line-anchored regex needs LF after the opening `---`, so a Windows
    // file (`---\r\n…`) would slip past the strip and leak the front-matter into
    // the body. normalizeForeignMarkdown normalizes CRLF -> LF first.
    const out = normalizeForeignMarkdown(
      '---\r\ntitle: Foo\r\ntags: [a]\r\n---\r\n\r\n# Heading\r\n\r\nBody.',
    );
    expect(out).toBe('# Heading\n\nBody.');
    expect(out).not.toContain('title: Foo');
    expect(out).not.toContain('---');
  });

  it('strips front-matter whose value contains a triple-dash (line-anchored)', () => {
    // F8: the block must close only on a `\n---` LINE, not the first inline
    // `---`. A value like `title: Q1 --- Q2` must not truncate the front-matter
    // and leak the rest (author/closing ---) into the body.
    const out = normalizeForeignMarkdown(
      '---\ntitle: Q1 --- Q2 results\nauthor: bob\n---\n\nReal body.',
    );
    expect(out).toBe('Real body.');
    expect(out).not.toContain('author: bob');
    expect(out).not.toContain('Q2 results');
  });
});

describe('foreign markdown import acceptance (normalizer + canonical parser)', () => {
  const FOREIGN = [
    '# Doc',
    '',
    'Body refs [^c] and [^a] and [^b] and again [^a].',
    '',
    ':::info',
    'A legacy callout.',
    ':::',
    '',
    '| h1 | h2 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '[^a]: note A',
    '[^b]: note B',
    '[^c]: note C',
    '[^z]: orphan note',
  ].join('\n');

  it('leaves no literal [^id] or ::: in the imported doc and re-exports canonically', async () => {
    const normalized = normalizeForeignMarkdown(FOREIGN);
    const doc = await markdownToProseMirror(normalized);
    const reexport = convertProseMirrorToMarkdown(doc);

    // No foreign garbage leaks into the document.
    expect(reexport).not.toMatch(/\[\^/); // no reference footnote refs/defs
    expect(reexport).not.toContain(':::'); // no legacy callout fences

    // Canonical forms are present.
    expect(reexport).toContain('^[note C]');
    expect(reexport).toContain('> [!info]');
    expect(reexport).toContain('| h1 | h2 |');

    // Footnotes: ordered by first reference (C, A, B), reused [^a] deduped to one,
    // orphan [^z] dropped (it had no reference after normalization).
    const list = doc.content.find((n: any) => n.type === 'footnotesList');
    const bodies = list.content.map(
      (d: any) => d.content[0].content[0].text,
    );
    expect(bodies).toEqual(['note C', 'note A', 'note B']);
    expect(bodies).not.toContain('orphan note');
    expect(
      doc.content.filter((n: any) => n.type === 'footnotesList'),
    ).toHaveLength(1);
  });
});

describe('normalizeAgentMarkdown vs normalizeForeignMarkdown — front-matter strip is IMPORT-only (#493 review)', () => {
  // A page that OPENS with a horizontalRule and contains a later `---` serializes
  // to a `---…---`-shaped body. On a full-body AGENT rewrite this must NOT be
  // mistaken for YAML front-matter and stripped — that silently dropped the
  // page's leading content.
  const rulePage = '---\n\nIntro\n\nMore\n\n---\n\nRest';

  it('normalizeAgentMarkdown does NOT strip a leading ---…--- (no content loss)', () => {
    expect(normalizeAgentMarkdown(rulePage)).toBe(rulePage);
  });

  it('normalizeForeignMarkdown (file import) STILL strips a real leading YAML front-matter block', () => {
    const withYaml = '---\ntitle: My Page\ntags: [a, b]\n---\n\nBody here.';
    const out = normalizeForeignMarkdown(withYaml);
    expect(out).toBe('Body here.');
    // And the horizontalRule-shaped body IS stripped on the import path (its
    // documented file-import behavior) — the two variants differ ONLY here.
    expect(normalizeForeignMarkdown(rulePage)).not.toContain('Intro');
  });

  it('agent-write round-trip keeps a horizontalRule-led doc with a second rule intact', async () => {
    // Simulate the serializer output for [horizontalRule, para, para, horizontalRule, para].
    const doc = {
      type: 'doc',
      content: [
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'More' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Rest' }] },
      ],
    };
    const body = convertProseMirrorToMarkdown(doc);
    // The agent-write normalization must NOT eat the head; re-import keeps every
    // paragraph's text.
    const back = await markdownToProseMirror(normalizeAgentMarkdown(body));
    const texts = JSON.stringify(back);
    for (const t of ['Intro', 'More', 'Rest']) expect(texts).toContain(t);
    // Both horizontal rules survive.
    expect(back.content.filter((n: any) => n.type === 'horizontalRule')).toHaveLength(2);
  });

  it('agent-write STILL rewrites GFM reference footnotes (the shared drift-fix)', () => {
    const gfm = 'See[^1].\n\n[^1]: the note.';
    const out = normalizeAgentMarkdown(gfm);
    expect(out).toContain('^[the note.]');
    expect(out).not.toMatch(/\[\^1\]:/);
  });
});
