import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (like math.test.ts) so we exercise the real
// converter and its module-load jsdom setup.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// ---------------------------------------------------------------------------
// #502: the canonical importer is parameterized with `{ parseMath, fuzzyLinkify }`
// (both DEFAULT true). The MCP markdown-WRITE path passes both false so an agent's
// plain prose/config is imported LITERALLY:
//   - parseMath:false  -> a `$…$` span stays literal text (no phantom mathInline)
//   - fuzzyLinkify:false -> a SCHEMELESS `www.host`/email stays literal text; an
//     EXPLICIT `https://…` STILL links (only the fuzzy autolink is suppressed).
// The DEFAULTS (editor/file-import/git-sync) keep math + fuzzy autolink ON, so
// this file also pins that the defaults are UNCHANGED.
// ---------------------------------------------------------------------------

const OFF = { parseMath: false, fuzzyLinkify: false } as const;

// Collect the first paragraph's inline children (the common assertion target).
function firstParaInline(doc: any): any[] {
  const p = doc.content?.find((n: any) => n.type === 'paragraph');
  return p?.content ?? [];
}

function findAll(node: any, type: string, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) {
    for (const c of node.content) findAll(c, type, acc);
  }
  return acc;
}

// Flatten every text node's text (ignoring marks/structure) into one string.
function allText(node: any, acc: string[] = []): string {
  if (!node || typeof node !== 'object') return acc.join('');
  if (node.type === 'text' && typeof node.text === 'string') acc.push(node.text);
  if (Array.isArray(node.content)) {
    for (const c of node.content) allText(c, acc);
  }
  return acc.join('');
}

describe('#502 importer options — extensions OFF (MCP write path)', () => {
  it('a `$…$` config span stays literal text (no mathInline node)', async () => {
    const md = 'export A=$FOO and B=$BAR done';
    const doc = await markdownToProseMirror(md, OFF);
    expect(findAll(doc, 'mathInline')).toHaveLength(0);
    expect(allText(doc)).toBe('export A=$FOO and B=$BAR done');
  });

  it('a real-looking `$x=1$` span stays literal text', async () => {
    const doc = await markdownToProseMirror('$x=1$', OFF);
    expect(findAll(doc, 'mathInline')).toHaveLength(0);
    expect(allText(doc)).toBe('$x=1$');
  });

  it('the reported `($ticket_lifetime=2592000)` config stays literal', async () => {
    const doc = await markdownToProseMirror('($ticket_lifetime=2592000)', OFF);
    expect(findAll(doc, 'mathInline')).toHaveLength(0);
    expect(allText(doc)).toBe('($ticket_lifetime=2592000)');
  });

  it('a `$$…$$` block stays literal (no mathBlock node)', async () => {
    const doc = await markdownToProseMirror('$$\nx^2\n$$', OFF);
    expect(findAll(doc, 'mathBlock')).toHaveLength(0);
    expect(allText(doc)).toContain('x^2');
  });

  it('a SCHEMELESS `www.example.com` is NOT autolinked', async () => {
    const doc = await markdownToProseMirror('see www.example.com here', OFF);
    const inline = firstParaInline(doc);
    expect(inline.some((n: any) => n.marks?.some((m: any) => m.type === 'link'))).toBe(false);
    expect(allText(doc)).toBe('see www.example.com here');
  });

  it('a bare dotted domain `gitea.vvzvlad.xyz` stays literal text', async () => {
    const doc = await markdownToProseMirror('see gitea.vvzvlad.xyz here', OFF);
    expect(findAll(doc, 'text').every((t: any) => !t.marks?.some((m: any) => m.type === 'link'))).toBe(true);
  });

  it('an EXPLICIT `https://…` STILL becomes a link', async () => {
    const doc = await markdownToProseMirror('see https://example.com here', OFF);
    const linked = firstParaInline(doc).find((n: any) =>
      n.marks?.some((m: any) => m.type === 'link'),
    );
    expect(linked?.text).toBe('https://example.com');
    const link = linked.marks.find((m: any) => m.type === 'link');
    expect(link.attrs.href).toBe('https://example.com');
  });

  it('`foo_bar_baz` is not italicized (CommonMark, unaffected by options)', async () => {
    const doc = await markdownToProseMirror('foo_bar_baz', OFF);
    expect(findAll(doc, 'text').some((t: any) => t.marks?.some((m: any) => m.type === 'italic' || m.type === 'em'))).toBe(false);
    expect(allText(doc)).toBe('foo_bar_baz');
  });

  it('block STRUCTURE (headings, lists, code fence) is preserved with extensions off', async () => {
    const md = '## Heading\n\n- one\n- two\n\n```\ncode $x$ here\n```';
    const doc = await markdownToProseMirror(md, OFF);
    expect(findAll(doc, 'heading')).toHaveLength(1);
    expect(findAll(doc, 'bulletList')).toHaveLength(1);
    expect(findAll(doc, 'codeBlock')).toHaveLength(1);
    // The `$x$` inside the code fence never becomes math regardless.
    expect(findAll(doc, 'mathInline')).toHaveLength(0);
  });
});

describe('#502 importer options — DEFAULTS unchanged (editor/file/git-sync)', () => {
  it('DEFAULT: `$x^2$` DOES create a mathInline node (file-import unaffected)', async () => {
    const doc = await markdownToProseMirror('$x^2$');
    expect(findAll(doc, 'mathInline')).toHaveLength(1);
    expect(findAll(doc, 'mathInline')[0].attrs.text).toBe('x^2');
  });

  it('DEFAULT: a schemeless `www.example.com` IS autolinked', async () => {
    const doc = await markdownToProseMirror('see www.example.com here');
    const linked = firstParaInline(doc).find((n: any) =>
      n.marks?.some((m: any) => m.type === 'link'),
    );
    expect(linked?.text).toBe('www.example.com');
  });

  it('DEFAULT: explicitly passing {parseMath:true, fuzzyLinkify:true} equals no-options', async () => {
    const a = await markdownToProseMirror('$x^2$ and www.foo.com');
    const b = await markdownToProseMirror('$x^2$ and www.foo.com', {
      parseMath: true,
      fuzzyLinkify: true,
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('round-trip export->import at the PACKAGE-DEFAULT layer keeps math (file-import / #328)', async () => {
    // The package DEFAULT importer is what the server file-import path uses. A
    // page holding real math is exported, then re-imported with DEFAULTS (math
    // ON): the mathInline survives. (The tool-level import_page_markdown round-
    // trip, which goes through mcp's markdownToProseMirrorCanonical, is pinned
    // authoritatively in @docmost/mcp's mcp-write-extensions-off test.)
    const source = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'mathInline', attrs: { text: 'x^2' } }] },
      ],
    };
    const md1 = convertProseMirrorToMarkdown(source);
    const doc2 = await markdownToProseMirror(md1); // DEFAULTS -> math on
    expect(findAll(doc2, 'mathInline')).toHaveLength(1);
    const md2 = convertProseMirrorToMarkdown(doc2);
    expect(md2).toBe(md1); // byte-stable
  });
});

describe('#502 mutation guard', () => {
  // If a future change silently flipped the MCP write path back to parseMath:true,
  // the OFF assertion below would go RED — this pins the discriminating behavior.
  it('with parseMath:true the same span DOES become math (proves the flag drives it)', async () => {
    const on = await markdownToProseMirror('$x=1$', { parseMath: true, fuzzyLinkify: false });
    expect(findAll(on, 'mathInline')).toHaveLength(1);
    const off = await markdownToProseMirror('$x=1$', OFF);
    expect(findAll(off, 'mathInline')).toHaveLength(0);
  });

  it('with fuzzyLinkify:true the same www domain DOES link (proves the flag drives it)', async () => {
    const on = await markdownToProseMirror('www.example.com', { parseMath: false, fuzzyLinkify: true });
    expect(findAll(on, 'text').some((t: any) => t.marks?.some((m: any) => m.type === 'link'))).toBe(true);
    const off = await markdownToProseMirror('www.example.com', OFF);
    expect(findAll(off, 'text').some((t: any) => t.marks?.some((m: any) => m.type === 'link'))).toBe(false);
  });
});
