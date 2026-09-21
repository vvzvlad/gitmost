import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  getNodeByRef,
  replaceNodeById,
  insertNodeRelative,
  insertTableRow,
  updateTableCell,
  sanitizeForYjs,
  findUnstorableAttr,
  buildOutline,
} from '../src/lib/node-ops.js';

// Gaps NOT covered by node-ops.test.ts (test-strategy report §2). The base file
// is comprehensive; these add only the missing edges: newNode-arg immutability,
// anchor-is-container routing, malformed opts, ragged/empty/no-colwidth/non-int
// insertTableRow, getNodeByRef non-object/#-1, updateTableCell empty-id refresh,
// outline 100/40 boundary, malformed marks, and the makeFreshId property.

const text = (value: string, marks?: any[]): any => {
  const node: any = { type: 'text', text: value };
  if (marks) node.marks = marks;
  return node;
};
const para = (id: string, value = ''): any => ({
  type: 'paragraph',
  attrs: { id, indent: 0 },
  content: value ? [text(value)] : [],
});
const cell = (
  type: 'tableCell' | 'tableHeader',
  paraId: string | null,
  value = '',
  extraAttrs: Record<string, any> = {},
): any => ({
  type,
  attrs: { colspan: 1, rowspan: 1, ...extraAttrs },
  content: paraId == null ? [] : [para(paraId, value)],
});
const row = (cells: any[]): any => ({ type: 'tableRow', content: cells });
const doc = (...content: any[]): any => ({ type: 'doc', content });

// ===========================================================================
describe('replaceNodeById — newNode ARGUMENT immutability', () => {
  it('does not mutate the caller-supplied newNode after replacement', () => {
    // The doc-argument immutability is covered in the base file; this pins the
    // OTHER input — the replacement node must be deep-cloned, so mutating the
    // result never reaches the caller's newNode (and vice versa).
    const d = doc(para('p0', 'old'), para('p1', 'old2'));
    const newNode = { type: 'paragraph', attrs: { id: 'new' }, content: [text('NEW')] };
    const snapshot = structuredClone(newNode);
    const res = replaceNodeById(d, 'p0', newNode);
    // Mutating the inserted copy must not touch the argument...
    res.doc.content[0].content.push(text('mutated'));
    expect(newNode).toEqual(snapshot);
    // ...and mutating the argument afterwards must not touch the inserted copy.
    newNode.content.push(text('later'));
    expect(res.doc.content[0].content).toEqual([text('NEW'), text('mutated')]);
  });
});

// ===========================================================================
describe('insertNodeRelative — container routing and malformed opts', () => {
  it('routes a structural row when anchorText resolves to the TABLE block itself', () => {
    // anchorText only scans top-level blocks, so it resolves to the whole table;
    // the matched container IS the anchor (containerIdx === chain.length-1), so
    // a row "after" must be appended inside the table, not spliced beside a row.
    const table = { type: 'table', content: [row([cell('tableCell', 'r0', 'hello cell')])] };
    const newRow = row([cell('tableCell', 'rNew', 'NEW')]);
    const res = insertNodeRelative(doc(table), newRow, {
      position: 'after',
      anchorText: 'hello cell',
    });
    expect(res.inserted).toBe(true);
    const firstCellId = (r: any) => r.content[0].content[0].attrs.id;
    expect(res.doc.content[0].content.map(firstCellId)).toEqual(['r0', 'rNew']);
  });

  it('prepends a structural row when anchorText resolves to the table and position is "before"', () => {
    const table = { type: 'table', content: [row([cell('tableCell', 'r0', 'hello cell')])] };
    const newRow = row([cell('tableCell', 'rNew', 'NEW')]);
    const res = insertNodeRelative(doc(table), newRow, {
      position: 'before',
      anchorText: 'hello cell',
    });
    const firstCellId = (r: any) => r.content[0].content[0].attrs.id;
    expect(res.doc.content[0].content.map(firstCellId)).toEqual(['rNew', 'r0']);
  });

  it('is a no-op (inserted:false) for a malformed opts object', () => {
    const d = doc(para('p0'));
    const res = insertNodeRelative(d, para('n'), null as any);
    expect(res.inserted).toBe(false);
    expect(res.doc).toEqual(d);
  });
});

// ===========================================================================
describe('insertTableRow — column count and index edge cases', () => {
  const ragged = () => ({
    type: 'table',
    content: [
      row([cell('tableHeader', 'h0', 'H0')]), // 1 col
      row([cell('tableCell', 'c0', 'A'), cell('tableCell', 'c1', 'B')]), // 2 cols
    ],
  });

  it('derives the column count from the WIDEST row (ragged table)', () => {
    // The guard counts against the widest row (2), so 3 cells throws...
    expect(() => insertTableRow(doc(ragged()), '#0', ['X', 'Y', 'Z'])).toThrow(
      /got 3 cell\(s\) but the table has 2 column\(s\)/,
    );
    // ...and a 2-cell row is padded to the widest width (2), not the header's 1.
    const res = insertTableRow(doc(ragged()), '#0', ['X', 'Y']);
    expect(res.doc.content[0].content[2].content).toHaveLength(2);
  });

  it('an EMPTY table falls back to the supplied cell count', () => {
    const res = insertTableRow(doc({ type: 'table', content: [] }), '#0', ['A', 'B']);
    expect(res.inserted).toBe(true);
    expect(res.doc.content[0].content[0].content).toHaveLength(2);
  });

  it('omits colwidth entirely when the header cell has none (no undefined leak)', () => {
    const noColwidth = {
      type: 'table',
      content: [
        row([cell('tableHeader', 'h0', 'H')]),
        row([cell('tableCell', 'c0', 'A')]),
      ],
    };
    const res = insertTableRow(doc(noColwidth), '#0', ['X']);
    const newCellAttrs = res.doc.content[0].content[2].content[0].attrs;
    expect('colwidth' in newCellAttrs).toBe(false); // not colwidth:undefined
  });

  it('APPENDS for a non-integer or negative index (does not throw)', () => {
    const t = {
      type: 'table',
      content: [
        row([cell('tableHeader', 'h0', 'H')]),
        row([cell('tableCell', 'c0', 'A')]),
      ],
    };
    const frac = insertTableRow(doc(t), '#0', ['X'], 1.5);
    expect(frac.inserted).toBe(true);
    expect(frac.doc.content[0].content).toHaveLength(3); // appended at the end
    const neg = insertTableRow(doc(t), '#0', ['X'], -1);
    expect(neg.doc.content[0].content).toHaveLength(3);
  });
});

// ===========================================================================
describe('getNodeByRef — malformed refs', () => {
  it('returns null for a non-object block at a valid #n index', () => {
    const d = { type: 'doc', content: [null] };
    expect(getNodeByRef(d, '#0')).toBeNull();
  });

  it('returns null for "#-1" (the index regex does not match a negative)', () => {
    const d = doc(para('p0'));
    // "#-1" matches neither the "#<digits>" form nor any block id -> null.
    expect(getNodeByRef(d, '#-1')).toBeNull();
  });
});

// ===========================================================================
describe('updateTableCell — fresh id when the first paragraph has an empty id', () => {
  it('mints a fresh id when the existing first paragraph id is the empty string', () => {
    const table = {
      type: 'table',
      content: [
        row([cell('tableHeader', 'h0', 'H')]),
        row([
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1 },
            content: [{ type: 'paragraph', attrs: { id: '' }, content: [text('old')] }],
          },
        ]),
      ],
    };
    const res = updateTableCell(doc(table), '#0', 1, 0, 'new');
    const newId = res.doc.content[0].content[1].content[0].content[0].attrs.id;
    // An empty id is treated as missing -> a fresh Docmost-style id is minted.
    expect(newId).toMatch(/^[a-z0-9]{12}$/);
    expect(newId).not.toBe('');
  });
});

// ===========================================================================
describe('buildOutline — exact 100 / 40 char truncation boundaries', () => {
  it('does NOT truncate firstText at exactly 100 chars but DOES at 101', () => {
    const at100 = buildOutline(doc(para('p', 'x'.repeat(100))));
    expect(at100[0].firstText).toBe('x'.repeat(100)); // boundary: not cut
    expect(at100[0].firstText.endsWith('…')).toBe(false);
    const at101 = buildOutline(doc(para('p', 'x'.repeat(101))));
    expect(at101[0].firstText).toBe('x'.repeat(100) + '…'); // first char over the cap
  });

  it('does NOT truncate a header cell at exactly 40 chars but DOES at 41', () => {
    const tableAt40 = {
      type: 'table',
      content: [row([cell('tableHeader', 'h', 'y'.repeat(40))])],
    };
    expect(buildOutline(doc(tableAt40))[0].header).toEqual(['y'.repeat(40)]);
    const tableAt41 = {
      type: 'table',
      content: [row([cell('tableHeader', 'h', 'y'.repeat(41))])],
    };
    expect(buildOutline(doc(tableAt41))[0].header).toEqual(['y'.repeat(40) + '…']);
  });
});

// ===========================================================================
describe('sanitizeForYjs / findUnstorableAttr — malformed marks array', () => {
  const malformed = () =>
    doc({
      type: 'paragraph',
      attrs: { id: 'p' },
      content: [
        text('x', [null, { type: 'link', attrs: { href: 'u', gone: undefined } }]),
      ],
    });

  it('sanitizeForYjs skips a null mark and strips undefined on the real one', () => {
    const res = sanitizeForYjs(malformed());
    const marks = res.content[0].content[0].marks;
    expect(marks[0]).toBeNull(); // the null mark is left untouched, not crashed on
    expect(marks[1].attrs).toEqual({ href: 'u' }); // undefined dropped
  });

  it('findUnstorableAttr skips a null mark and reports the real undefined attr path', () => {
    expect(findUnstorableAttr(malformed())).toBe(
      'content[0].content[0].marks[1].attrs.gone (undefined)',
    );
  });
});

// ===========================================================================
describe('makeFreshId — format and uniqueness (property, via insertTableRow)', () => {
  it('every minted cell-paragraph id matches ^[a-z0-9]{12}$ and is globally unique', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (cols) => {
        // Build an empty-id table of `cols` columns; the inserted row mints a
        // fresh id per cell. The doc carries one pre-existing id to also assert
        // the new ids never collide with it.
        const headerCells = Array.from({ length: cols }, (_, i) =>
          cell('tableHeader', `pre-${i}`, `H${i}`),
        );
        const d = doc({ type: 'table', content: [row(headerCells)] });
        const res = insertTableRow(d, '#0', Array.from({ length: cols }, () => 'v'), 1);
        const ids = res.doc.content[0].content[1].content.map(
          (c: any) => c.content[0].attrs.id,
        );
        for (const id of ids) {
          expect(id).toMatch(/^[a-z0-9]{12}$/);
        }
        // Unique within the new row AND distinct from the pre-existing ids.
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
          expect(id.startsWith('pre-')).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
