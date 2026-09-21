import { jsonToText } from './collaboration.util';

// #502 READ contract: `jsonToText(json, { deterministic: true })` — the flat,
// machine-diffable text rendering behind getPage `format:"text"`. Block-per-line
// (`\n` separator), inline marks/anchors dropped, hardBreak -> `\n`, and non-text
// nodes replaced by STABLE placeholders (`[image]`, `[table RxC]`). Output
// stability across package versions IS the contract, so it is pinned by a
// snapshot below. The DEFAULT (no options) path is the search-index serializer
// and MUST be unchanged — asserted separately.

const doc = (...content: any[]) => ({ type: 'doc', content });
const para = (...content: any[]) => ({ type: 'paragraph', content });
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };

describe('jsonToText — default (search index) behavior is unchanged', () => {
  it('uses the `\\n\\n` block separator and drops non-text nodes to empty', () => {
    const d = doc(para(text('alpha')), para(text('beta')));
    expect(jsonToText(d)).toBe('alpha\n\nbeta');
  });

  it('an image contributes no text in the default (tsvector) mode', () => {
    const d = doc(para(text('cap')), { type: 'image', attrs: { src: 's' } });
    // No `[image]` placeholder leaks into the search index.
    expect(jsonToText(d)).not.toContain('[image]');
  });
});

describe('jsonToText — deterministic:true (getPage format:"text")', () => {
  it('renders one line per block with `\\n` separators, marks dropped', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
      para(
        text('hello ', [{ type: 'bold' }]),
        text('world', [{ type: 'italic' }]),
      ),
    );
    expect(jsonToText(d, { deterministic: true })).toBe('Title\nhello world');
  });

  it('a hardBreak renders as a newline', () => {
    const d = doc(para(text('a'), { type: 'hardBreak' }, text('b')));
    expect(jsonToText(d, { deterministic: true })).toBe('a\nb');
  });

  it('an image node -> the stable `[image]` placeholder', () => {
    const d = doc(para(text('before')), { type: 'image', attrs: { src: 's' } });
    expect(jsonToText(d, { deterministic: true })).toBe('before\n[image]');
  });

  it('a table -> `[table RxC]` (rows x columns) and its cell text is NOT flattened in', () => {
    const cell = (t: string) => ({
      type: 'tableCell',
      content: [para(text(t))],
    });
    const row = (...cells: any[]) => ({ type: 'tableRow', content: cells });
    const table = {
      type: 'table',
      content: [
        row(cell('CELLONE'), cell('CELLTWO'), cell('CELLTHREE')),
        row(cell('CELLFOUR'), cell('CELLFIVE'), cell('CELLSIX')),
      ],
    };
    const d = doc(para(text('grid:')), table);
    const out = jsonToText(d, { deterministic: true });
    expect(out).toBe('grid:\n[table 2x3]');
    expect(out).not.toContain('CELL'); // cell text is not flattened into the read
  });

  it('SNAPSHOT: a mixed document renders to a stable, deterministic string', () => {
    const cell = (t: string) => ({
      type: 'tableCell',
      content: [para(text(t))],
    });
    const d = doc(
      { type: 'heading', attrs: { level: 1 }, content: [text('Config')] },
      para(text('key = ', [{ type: 'bold' }]), text('value')),
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para(text('one'))] },
          { type: 'listItem', content: [para(text('two'))] },
        ],
      },
      { type: 'image', attrs: { src: 's' } },
      {
        type: 'table',
        content: [{ type: 'tableRow', content: [cell('x'), cell('y')] }],
      },
    );
    expect(jsonToText(d, { deterministic: true })).toMatchInlineSnapshot(`
     "Config
     key = value


     one

     two
     [image]
     [table 1x2]"
    `);
  });

  it('SCENARIO: a config written as a code block reads back byte-identical (diff empty)', () => {
    const config =
      'export TICKET_LIFETIME=$2592000\nservers:\n  - www.internal.host';
    const d = doc({
      type: 'codeBlock',
      attrs: { language: 'yaml' },
      content: [text(config)],
    });
    // The code block is one block; its text (dollars, bare domain, newlines) is
    // preserved verbatim, so a read-as-text of a stored config diffs empty.
    expect(jsonToText(d, { deterministic: true })).toBe(config);
  });
});
