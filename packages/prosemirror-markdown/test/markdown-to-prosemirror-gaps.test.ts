import { describe, expect, it } from 'vitest';
// markdownToProseMirror lives next to the markdown->HTML preprocessors
// (preprocessCallouts, bridgeTaskLists). Those helpers are NOT exported, so we
// exercise them through the public entry point, which runs the full
// markdown -> preprocessCallouts -> marked -> bridgeTaskLists -> generateJSON
// pipeline. Importing this module mutates the global DOM via jsdom (required for
// @tiptap/html under Node) — expected, same as the property test.
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';
// The export side (ProseMirror -> markdown) is pulled in for the round-trip
// specs below (underline/sub/sup marks, heading levels, link title). Imported
// directly from src/lib (not the barrel) like the other converter unit tests.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';

// Find every node of a given type anywhere in a ProseMirror doc tree.
const findAll = (node: any, type: string, acc: any[] = []): any[] => {
  if (node && node.type === type) acc.push(node);
  for (const child of node?.content || []) findAll(child, type, acc);
  return acc;
};
// Concatenate all text within a subtree (order-preserving).
const allText = (node: any): string => {
  if (node?.type === 'text') return node.text || '';
  return (node?.content || []).map(allText).join('');
};

// ---------------------------------------------------------------------------
// Obsidian-native callouts: the export emits `> [!type]` (a blockquote callout,
// which renders as a callout in Obsidian) and the importer parses it back —
// alongside the legacy `:::type` fence so existing vaults keep working.
// ---------------------------------------------------------------------------
describe('preprocessCallouts: Obsidian `> [!type]` callouts', () => {
  it('imports `> [!type]` as a callout node (not a plain blockquote)', async () => {
    const md = ['> [!warning]', '> be careful', '> second line'].join('\n');
    const docNode = await markdownToProseMirror(md);
    const callouts = findAll(docNode, 'callout');
    expect(callouts).toHaveLength(1);
    expect(callouts[0].attrs?.type).toBe('warning');
    expect(findAll(docNode, 'blockquote')).toHaveLength(0);
    expect(allText(callouts[0])).toContain('be careful');
  });

  it('imports a nested `> > [!type]` callout inside another', async () => {
    const md = ['> [!info]', '> outer', '> > [!danger]', '> > inner'].join('\n');
    const docNode = await markdownToProseMirror(md);
    const outer = docNode.content?.[0];
    expect(outer?.type).toBe('callout');
    expect(outer?.attrs?.type).toBe('info');
    const inner = (outer?.content || []).filter(
      (n: any) => n.type === 'callout',
    );
    expect(inner).toHaveLength(1);
    expect(inner[0].attrs?.type).toBe('danger');
    expect(allText(inner[0])).toContain('inner');
  });

  it('round-trips a callout: export -> `> [!type]` -> import keeps type + body', async () => {
    const original = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { type: 'success' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
        },
      ],
    };
    const md = convertProseMirrorToMarkdown(original);
    expect(md).toBe('> [!success]\n> done');
    const back = await markdownToProseMirror(md);
    const callouts = findAll(back, 'callout');
    expect(callouts).toHaveLength(1);
    expect(callouts[0].attrs?.type).toBe('success');
    expect(allText(callouts[0])).toContain('done');
  });

  it('a plain blockquote (no `[!type]`) stays a blockquote', async () => {
    const back = await markdownToProseMirror('> just a quote\n> more');
    expect(findAll(back, 'callout')).toHaveLength(0);
    expect(findAll(back, 'blockquote')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. preprocessCallouts — two uncovered branches.
//
// (a) NESTED callouts: an inner `:::type ... :::` inside an outer callout body
//     must be matched at its own nesting level (the depth counter) and emerge as
//     a callout NESTED inside the outer callout — not flattened or mis-closed.
// (b) A `:::` line INSIDE a fenced code block must NOT be treated as a callout
//     delimiter: the scanner tracks code fences and copies their lines verbatim,
//     so the outer callout's matching `:::` is the one AFTER the fence closes.
// ---------------------------------------------------------------------------
describe('preprocessCallouts: nested callouts + code-fenced ":::"', () => {
  it('(a) parses a callout nested inside another callout', async () => {
    const md = [
      ':::info',
      'outer text',
      ':::warning',
      'inner text',
      ':::',
      ':::',
    ].join('\n');

    const docNode = await markdownToProseMirror(md);

    // Exactly two callouts, and one is nested inside the other.
    const callouts = findAll(docNode, 'callout');
    expect(callouts).toHaveLength(2);

    const outer = docNode.content?.[0];
    expect(outer?.type).toBe('callout');
    expect(outer?.attrs?.type).toBe('info');

    // The inner callout is a CHILD of the outer one (not a sibling at doc level).
    const innerCallouts = (outer?.content || []).filter(
      (n: any) => n.type === 'callout',
    );
    expect(innerCallouts).toHaveLength(1);
    expect(innerCallouts[0].attrs?.type).toBe('warning');

    // Both bodies kept their text.
    expect(allText(outer)).toContain('outer text');
    expect(allText(innerCallouts[0])).toContain('inner text');
  });

  it('(b) a ":::" line inside a fenced code block is NOT a callout delimiter', async () => {
    // The inner ``` ... ``` fence contains a `:::` line. If preprocessCallouts
    // treated it as the closing fence, the callout would terminate early and the
    // code text would leak out. The correct behavior: the fence content survives
    // verbatim in a codeBlock, and the callout closes at the LAST ":::".
    const md = [
      ':::info',
      'before code',
      '```',
      ':::',
      'still inside the code fence',
      '```',
      'after code',
      ':::',
    ].join('\n');

    const docNode = await markdownToProseMirror(md);

    // One callout wrapping everything (it did not close early on the fenced ":::")
    const callouts = findAll(docNode, 'callout');
    expect(callouts).toHaveLength(1);
    const callout = callouts[0];

    // The code block is a CHILD of the callout and still contains the ":::" line.
    const codeBlocks = findAll(callout, 'codeBlock');
    expect(codeBlocks).toHaveLength(1);
    expect(allText(codeBlocks[0])).toContain(':::');
    expect(allText(codeBlocks[0])).toContain('still inside the code fence');

    // The text before and after the fence is part of the callout, not a stray
    // top-level paragraph created by an early close.
    expect(allText(callout)).toContain('before code');
    expect(allText(callout)).toContain('after code');
  });

  it('(c) an UNCLOSED ":::" opener is treated as a literal line, not a callout', async () => {
    // Realistic input: a hand-edited vault file with a `:::info` opener and no
    // matching closing `:::`. The fallback emits the opener as a LITERAL line
    // rather than swallowing the rest of the document into a phantom callout —
    // previously uncovered (markdown-to-prosemirror.ts).
    const md = [':::info', 'orphan body line', 'another line'].join('\n');

    const docNode = await markdownToProseMirror(md);

    // No callout node was created (the opener never closed).
    expect(findAll(docNode, 'callout')).toHaveLength(0);
    // The opener survives as literal text and the body lines are preserved (the
    // rest of the document was NOT eaten by an unterminated callout).
    const text = allText(docNode);
    expect(text).toContain(':::info');
    expect(text).toContain('orphan body line');
    expect(text).toContain('another line');
  });
});

// ---------------------------------------------------------------------------
// 4. bridgeTaskLists — numbered checklist + mixed-list negative.
//
// (a) A NUMBERED checklist (`1. [x] ...`) is rendered by marked as an <ol> of
//     checkbox <li>s. The bridge must convert it to a taskList AND rename the
//     <ol> to a <ul> so generateJSON does NOT also match the orderedList rule
//     and emit a phantom empty orderedList beside the real taskList.
// (b) NEGATIVE: a MIXED list (some items have checkboxes, some don't) must NOT
//     be converted — it stays an ordinary bullet/numbered list.
// ---------------------------------------------------------------------------
describe('bridgeTaskLists: numbered checklist + mixed-list negative', () => {
  it('(a) a numbered <ol> checklist becomes a taskList with NO phantom orderedList', async () => {
    const md = ['1. [x] done', '2. [ ] todo'].join('\n');

    const docNode = await markdownToProseMirror(md);

    // It became a taskList...
    const taskLists = findAll(docNode, 'taskList');
    expect(taskLists).toHaveLength(1);

    const items = (taskLists[0].content || []).filter(
      (n: any) => n.type === 'taskItem',
    );
    expect(items).toHaveLength(2);
    expect(items[0].attrs?.checked).toBe(true);
    expect(items[1].attrs?.checked).toBe(false);
    expect(allText(items[0])).toContain('done');
    expect(allText(items[1])).toContain('todo');

    // ...and NO phantom (empty) orderedList survived the <ol> -> <ul> rename.
    const orderedLists = findAll(docNode, 'orderedList');
    expect(orderedLists).toHaveLength(0);
  });

  it('(b) a MIXED list (some items checkboxed, some not) is NOT converted to a taskList', async () => {
    const md = ['- [x] checked item', '- plain item'].join('\n');

    const docNode = await markdownToProseMirror(md);

    // The bridge requires EVERY direct <li> to carry its own checkbox; one plain
    // item disqualifies the whole list, so it stays a bulletList.
    expect(findAll(docNode, 'taskList')).toHaveLength(0);
    expect(findAll(docNode, 'taskItem')).toHaveLength(0);

    const bulletLists = findAll(docNode, 'bulletList');
    expect(bulletLists).toHaveLength(1);
    const listItems = findAll(bulletLists[0], 'listItem');
    expect(listItems).toHaveLength(2);
    // Both items survive as ordinary list items (text preserved).
    expect(allText(bulletLists[0])).toContain('checked item');
    expect(allText(bulletLists[0])).toContain('plain item');
  });
});

// Find the first mark of a given type on a text node anywhere in the tree.
const firstMark = (node: any, markType: string): any => {
  if (node?.type === 'text') {
    for (const m of node.marks || []) if (m.type === markType) return m;
  }
  for (const child of node?.content || []) {
    const found = firstMark(child, markType);
    if (found) return found;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Spec 1. IMPORT-side color sanitization for the highlight + textStyle marks.
//
// The Highlight.extend / TextStyle parseHTML run attacker-controlled colors
// through sanitizeCssColor when generateJSON re-parses stored HTML. This is the
// real defense that strips a crafted color on IMPORT (the export-side emission
// is tested elsewhere; the parse path was not).
// ---------------------------------------------------------------------------
describe('import: highlight/textStyle color sanitization (parseHTML)', () => {
  it('strips the unsafe "--x:1" declaration but keeps the safe "red" background-color', async () => {
    const doc = await markdownToProseMirror(
      '<mark style="background-color: red; --x:1">x</mark>',
    );
    const mark = firstMark(doc, 'highlight');
    // The highlight mark IS present on the text run.
    expect(mark).not.toBeNull();
    expect(allText(doc)).toContain('x');
    // NOTE(review): Spec 1 expected attrs.color === null for this input. The
    // ACTUAL behavior is attrs.color === 'red': the schema's Highlight.extend
    // reads the color via getStyleProperty(el, 'background-color'), which
    // isolates the `background-color: red` declaration and DROPS the separate
    // unsafe `--x:1` declaration. sanitizeCssColor('red') then accepts the bare
    // named color. So the injection ('--x:1') is stripped (the defense holds)
    // but the legitimate 'red' survives — color is 'red', not null. The
    // color-dropped-to-null path is exercised by the data-color variant below,
    // where the whole "red; --x:1" string reaches sanitizeCssColor and fails.
    expect(mark.attrs.color).toBe('red');
  });

  it('drops a crafted color carried whole in data-color (sanitizeCssColor -> null)', async () => {
    // Here the entire unsafe string is the candidate color (no per-declaration
    // splitting), so sanitizeCssColor rejects it and the highlight color is null
    // while the highlight mark itself is still applied.
    const doc = await markdownToProseMirror(
      '<mark data-color="red; --x:1">x</mark>',
    );
    const mark = firstMark(doc, 'highlight');
    expect(mark).not.toBeNull();
    expect(mark.attrs.color).toBeNull();
  });

  it("imports '#ff0000' as the highlight mark color verbatim", async () => {
    const doc = await markdownToProseMirror(
      '<mark style="background-color: #ff0000">x</mark>',
    );
    const mark = firstMark(doc, 'highlight');
    expect(mark).not.toBeNull();
    expect(mark.attrs.color).toBe('#ff0000');
  });

  it("imports a colored span as a textStyle mark with the sanitized color", async () => {
    const doc = await markdownToProseMirror(
      '<span style="color: rebeccapurple">y</span>',
    );
    const mark = firstMark(doc, 'textStyle');
    expect(mark).not.toBeNull();
    expect(mark.attrs.color).toBe('rebeccapurple');
    // It is carried on a real text node containing the span's text.
    expect(allText(doc)).toContain('y');
  });
});

// ---------------------------------------------------------------------------
// Spec 2. Importing a non-schema callout fence resolves the type via the editor's
// alias map (known GitHub/Obsidian aliases) or clamps to 'info' (unknown).
//
// preprocessCallouts emits div[data-type=callout][data-callout-type=<type>]; the
// schema's Callout.type parseHTML pipes it through clampCalloutType. A known alias
// (`tip`) maps to the editor's banner (`success`); a genuinely unknown type
// (`banana`) clamps to the 'info' default. End-to-end import-side resolution.
// ---------------------------------------------------------------------------
describe('import: non-schema callout fence resolves via alias map / clamps to info', () => {
  it("imports ':::tip' as a callout whose attrs.type === 'success' (alias)", async () => {
    const doc = await markdownToProseMirror(':::tip\nhello\n:::');
    const callouts = findAll(doc, 'callout');
    expect(callouts).toHaveLength(1);
    expect(callouts[0].attrs.type).toBe('success');
    // The body paragraph survived inside the callout.
    expect(allText(callouts[0])).toContain('hello');
    const paras = findAll(callouts[0], 'paragraph');
    expect(paras.length).toBeGreaterThanOrEqual(1);
  });

  it("imports ':::banana' (unknown) as a callout whose attrs.type === 'info'", async () => {
    const doc = await markdownToProseMirror(':::banana\nhello\n:::');
    const callouts = findAll(doc, 'callout');
    expect(callouts).toHaveLength(1);
    expect(callouts[0].attrs.type).toBe('info');
    expect(allText(callouts[0])).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// Spec 3. Importing a columns layout with a string data-width yields a numeric
// column width, and the columns wrapper carries its default layout/widthMode.
// ---------------------------------------------------------------------------
describe('import: columns layout with string data-width -> numeric width', () => {
  it('parses data-width="33.5" to the number 33.5 and populates columns defaults', async () => {
    const doc = await markdownToProseMirror(
      '<div data-type="columns"><div data-type="column" data-width="33.5"><p>a</p></div></div>',
    );
    const columns = findAll(doc, 'columns');
    expect(columns).toHaveLength(1);
    // Columns default attrs are populated (not undefined).
    expect(columns[0].attrs.widthMode).toBe('normal');
    expect(columns[0].attrs.layout).not.toBeNull();
    expect(columns[0].attrs.layout).toBe('two_equal');

    const cols = findAll(columns[0], 'column');
    expect(cols).toHaveLength(1);
    // parseFloat('33.5') -> 33.5 as a NUMBER, not the string '33.5'.
    expect(cols[0].attrs.width).toBe(33.5);
    expect(typeof cols[0].attrs.width).toBe('number');
    expect(allText(cols[0])).toContain('a');
  });
});

// ---------------------------------------------------------------------------
// Spec 4. Comment mark resolved-attribute boolean coercion on import.
//
// The comment mark's resolved attr parseHTML compares
// el.getAttribute('data-resolved') === 'true', so a missing attribute yields
// false (default) and the literal 'true' yields boolean true.
// ---------------------------------------------------------------------------
describe('import: comment mark commentId + resolved boolean coercion', () => {
  it("data-resolved='true' -> resolved:true with the parsed commentId", async () => {
    const doc = await markdownToProseMirror(
      '<span data-comment-id="c1" data-resolved="true">x</span>',
    );
    const mark = firstMark(doc, 'comment');
    expect(mark).not.toBeNull();
    expect(mark.attrs.commentId).toBe('c1');
    expect(mark.attrs.resolved).toBe(true);
  });

  it('a missing data-resolved -> resolved:false (default)', async () => {
    const doc = await markdownToProseMirror(
      '<span data-comment-id="c2">y</span>',
    );
    const mark = firstMark(doc, 'comment');
    expect(mark).not.toBeNull();
    expect(mark.attrs.commentId).toBe('c2');
    expect(mark.attrs.resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spec 5. A NON-numeric truthy data-width reaches parseFloat and yields NaN.
//
// Column.width parseHTML is `value ? parseFloat(value) : null`; 'abc' is truthy
// so parseFloat('abc') -> NaN leaks through as the raw attribute value rather
// than falling back to the null default. (JSON.stringify would serialize NaN to
// null — see the assertion below — so the leak is invisible in serialized JSON.)
// ---------------------------------------------------------------------------
describe('import: malformed non-numeric data-width leaks NaN', () => {
  it("data-width='abc' -> column width is NaN (typeof number), not null", async () => {
    const doc = await markdownToProseMirror(
      '<div data-type="columns"><div data-type="column" data-width="abc"><p>x</p></div></div>',
    );
    const width = doc.content[0].content[0].attrs.width;
    expect(typeof width).toBe('number');
    expect(Number.isNaN(width)).toBe(true);
    // Document that the leak is masked by JSON serialization: NaN -> null.
    expect(JSON.parse(JSON.stringify(doc)).content[0].content[0].attrs.width).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spec 6. A column with NO data-width attribute lands on the null default.
//
// The else branch of `value ? parseFloat(value) : null` (getAttribute -> null)
// must yield exactly null (not NaN/undefined), and the columns wrapper carries
// its layout/widthMode defaults.
// ---------------------------------------------------------------------------
describe('import: width-less column lands on null default', () => {
  it('no data-width -> column width === null, columns defaults populated', async () => {
    const doc = await markdownToProseMirror(
      '<div data-type="columns"><div data-type="column"><p>y</p></div></div>',
    );
    expect(doc.content[0].content[0].attrs.width).toBe(null);
    expect(doc.content[0].attrs.layout).toBe('two_equal');
    expect(doc.content[0].attrs.widthMode).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// Spec 7. A structural callout div with missing/empty data-callout-type clamps
// to 'info' via clampCalloutType (the parseHTML getAttrs fallback), with no icon.
// ---------------------------------------------------------------------------
describe('import: callout div with missing/empty data-callout-type clamps to info', () => {
  it('a callout div with NO data-callout-type -> type:info, icon:null', async () => {
    const doc = await markdownToProseMirror(
      '<div data-type="callout"><p>z</p></div>',
    );
    expect(doc.content[0].type).toBe('callout');
    expect(doc.content[0].attrs.type).toBe('info');
    expect(doc.content[0].attrs.icon).toBeNull();
  });

  it('a callout div with EMPTY data-callout-type -> type:info, icon:null', async () => {
    const doc = await markdownToProseMirror(
      '<div data-type="callout" data-callout-type=""><p>w</p></div>',
    );
    expect(doc.content[0].type).toBe('callout');
    expect(doc.content[0].attrs.type).toBe('info');
    expect(doc.content[0].attrs.icon).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spec 8. A plain <td> with no align/colspan/rowspan/colwidth lands on the
// schema defaults (align null via the `||` fallback arm; spans default to 1).
// ---------------------------------------------------------------------------
describe('import: span/align-less table cell lands on defaults', () => {
  it('a bare td -> align:null, colspan:1, rowspan:1, colwidth:null', async () => {
    const doc = await markdownToProseMirror(
      '<table><tbody><tr><td><p>c</p></td></tr></tbody></table>',
    );
    const cells = findAll(doc, 'tableCell');
    expect(cells).toHaveLength(1);
    const attrs = cells[0].attrs;
    expect(attrs.align).toBeNull();
    expect(attrs.colspan).toBe(1);
    expect(attrs.rowspan).toBe(1);
    expect(attrs.colwidth).toBeNull();
    expect(allText(cells[0])).toContain('c');
  });
});

// ---------------------------------------------------------------------------
// Spec 9. underline/subscript/superscript marks survive import and re-export.
// (inlineToHtml src 611-619 renders them back to <u>/<sub>/<sup>.)
// ---------------------------------------------------------------------------
describe('import+export: underline/subscript/superscript marks round-trip', () => {
  it('<u>/<sub>/<sup> import to the right marks and re-export unchanged', async () => {
    const doc = await markdownToProseMirror('<p><u>a</u><sub>b</sub><sup>c</sup></p>');
    const para = findAll(doc, 'paragraph')[0];
    const texts = (para.content || []).filter((n: any) => n.type === 'text');
    expect(texts).toHaveLength(3);
    expect(texts[0].text).toBe('a');
    expect((texts[0].marks || []).map((m: any) => m.type)).toEqual(['underline']);
    expect(texts[1].text).toBe('b');
    expect((texts[1].marks || []).map((m: any) => m.type)).toEqual(['subscript']);
    expect(texts[2].text).toBe('c');
    expect((texts[2].marks || []).map((m: any) => m.type)).toEqual(['superscript']);

    const md = convertProseMirrorToMarkdown(doc);
    expect(md).toContain('<u>a</u>');
    expect(md).toContain('<sub>b</sub>');
    expect(md).toContain('<sup>c</sup>');
  });
});

// ---------------------------------------------------------------------------
// Spec 10. Heading level attribute fidelity (h1/h2/h6) on import and re-export.
// ---------------------------------------------------------------------------
describe('import+export: heading levels 1/2/6 round-trip', () => {
  it('parses # / ## / ###### to level 1/2/6 and re-emits them', async () => {
    const doc = await markdownToProseMirror('# H1\n\n## H2\n\n###### H6');
    const headings = findAll(doc, 'heading');
    expect(headings).toHaveLength(3);
    expect(headings[0].attrs.level).toBe(1);
    expect(headings[1].attrs.level).toBe(2);
    expect(headings[2].attrs.level).toBe(6);

    const md = convertProseMirrorToMarkdown(doc);
    const blocks = md.split('\n\n');
    expect(blocks).toContain('# H1');
    expect(blocks).toContain('## H2');
    expect(blocks).toContain('###### H6');
  });
});

// ---------------------------------------------------------------------------
// Spec 11. Link mark recovers BOTH href and title on import and round-trips.
// ---------------------------------------------------------------------------
describe('import+export: link mark href + title round-trip', () => {
  it('parses [lbl](http://a "the title") with href+title and re-emits it', async () => {
    const doc = await markdownToProseMirror('[lbl](http://a "the title")');
    const mark = firstMark(doc, 'link');
    expect(mark).not.toBeNull();
    expect(mark.attrs.href).toBe('http://a');
    expect(mark.attrs.title).toBe('the title');
    expect(allText(doc)).toContain('lbl');

    const md = convertProseMirrorToMarkdown(doc);
    expect(md).toContain('[lbl](http://a "the title")');
  });
});
