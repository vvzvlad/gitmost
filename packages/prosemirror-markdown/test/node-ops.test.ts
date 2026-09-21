import { describe, expect, it } from 'vitest';
import {
  blockPlainText,
  buildOutline,
  getNodeByRef,
  replaceNodeById,
  deleteNodeById,
  sanitizeForYjs,
  findUnstorableAttr,
  insertNodeRelative,
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
} from '../src/lib/node-ops.js';

// ---------------------------------------------------------------------------
// Tiny ProseMirror/TipTap JSON fixture builders. These produce the exact plain
// JSON shape Docmost uses: { type, attrs?, content?, text?, marks? }.
// ---------------------------------------------------------------------------

/** A text leaf node, optionally carrying marks. */
function text(value: string, marks?: any[]): any {
  const node: any = { type: 'text', text: value };
  if (marks) node.marks = marks;
  return node;
}

/** A paragraph block with an id and a single text child (or empty). */
function para(id: string, value = ''): any {
  return {
    type: 'paragraph',
    attrs: { id, indent: 0 },
    content: value ? [text(value)] : [],
  };
}

/** A heading block. */
function heading(id: string, level: number, value: string): any {
  return {
    type: 'heading',
    attrs: { id, level },
    content: [text(value)],
  };
}

/** A table cell (or header) wrapping a single paragraph; extra attrs merged in. */
function cell(
  type: 'tableCell' | 'tableHeader',
  paraId: string | null,
  value = '',
  extraAttrs: Record<string, any> = {},
): any {
  const attrs = { colspan: 1, rowspan: 1, ...extraAttrs };
  return {
    type,
    attrs,
    content: paraId == null ? [] : [para(paraId, value)],
  };
}

/** A table row. */
function row(cells: any[]): any {
  return { type: 'tableRow', content: cells };
}

/** A doc root with the given top-level blocks. */
function doc(...content: any[]): any {
  return { type: 'doc', content };
}

// ===========================================================================
// blockPlainText
// ===========================================================================
describe('blockPlainText', () => {
  it('returns the text of a plain text node', () => {
    expect(blockPlainText(text('hello'))).toBe('hello');
  });

  it('concatenates text from nested containers', () => {
    const node = {
      type: 'paragraph',
      content: [text('foo'), text('bar'), { type: 'span', content: [text('baz')] }],
    };
    expect(blockPlainText(node)).toBe('foobarbaz');
  });

  it('returns "" for nullish or non-object inputs', () => {
    expect(blockPlainText(null)).toBe('');
    expect(blockPlainText(undefined)).toBe('');
    expect(blockPlainText('a string')).toBe('');
    expect(blockPlainText(42)).toBe('');
    expect(blockPlainText([text('x')])).toBe(''); // arrays are not objects here
  });

  it('uses BOTH text and nested content of a node, text first', () => {
    const node = { type: 'weird', text: 'A', content: [text('B'), text('C')] };
    expect(blockPlainText(node)).toBe('ABC');
  });
});

// ===========================================================================
// buildOutline
// ===========================================================================
describe('buildOutline', () => {
  it('captures heading level, id and firstText', () => {
    const outline = buildOutline(doc(heading('h1', 2, 'Title')));
    expect(outline).toEqual([
      { index: 0, type: 'heading', id: 'h1', firstText: 'Title', level: 2 },
    ]);
  });

  it('reports table rows/cols and header texts (cols from row 0)', () => {
    const table = {
      type: 'table',
      content: [
        row([cell('tableHeader', 'a', 'H1'), cell('tableHeader', 'b', 'H2')]),
        row([cell('tableCell', 'c', 'x'), cell('tableCell', 'd', 'y')]),
      ],
    };
    const [entry] = buildOutline(doc(table));
    expect(entry.type).toBe('table');
    expect(entry.rows).toBe(2);
    expect(entry.cols).toBe(2);
    expect(entry.header).toEqual(['H1', 'H2']);
  });

  it('derives cols from row 0 for a ragged table', () => {
    const table = {
      type: 'table',
      content: [
        row([cell('tableHeader', 'a', 'H1')]), // row 0 has 1 col
        row([cell('tableCell', 'b', 'x'), cell('tableCell', 'c', 'y')]), // 2 cols
      ],
    };
    const [entry] = buildOutline(doc(table));
    expect(entry.rows).toBe(2);
    expect(entry.cols).toBe(1); // cols reflect ONLY row 0
    expect(entry.header).toEqual(['H1']);
  });

  it('reports item count for any *List block', () => {
    const list = {
      type: 'bulletList',
      attrs: { id: 'l1' },
      content: [{ type: 'listItem' }, { type: 'listItem' }, { type: 'listItem' }],
    };
    const [entry] = buildOutline(doc(list));
    expect(entry.type).toBe('bulletList');
    expect(entry.items).toBe(3);
  });

  it('returns [] for an empty or non-object doc', () => {
    expect(buildOutline(null)).toEqual([]);
    expect(buildOutline({ type: 'doc' })).toEqual([]); // no content array
    expect(buildOutline({ type: 'doc', content: [] })).toEqual([]);
    expect(buildOutline('nope')).toEqual([]);
  });

  it('falls back to null id when a block has no attrs.id', () => {
    const [entry] = buildOutline(doc({ type: 'paragraph', content: [text('hi')] }));
    expect(entry.id).toBeNull();
    expect(entry.firstText).toBe('hi');
  });

  it('truncates firstText to 100 chars with an ellipsis', () => {
    const long = 'x'.repeat(150);
    const [entry] = buildOutline(doc(para('p', long)));
    expect(entry.firstText).toBe('x'.repeat(100) + '…');
    expect(entry.firstText.length).toBe(101); // 100 chars + ellipsis
  });

  it('truncates table header cell text to 40 chars', () => {
    const long = 'y'.repeat(60);
    const table = {
      type: 'table',
      content: [row([cell('tableHeader', 'a', long)])],
    };
    const [entry] = buildOutline(doc(table));
    expect(entry.header).toEqual(['y'.repeat(40) + '…']);
  });
});

// ===========================================================================
// getNodeByRef
// ===========================================================================
describe('getNodeByRef', () => {
  it('resolves a top-level block by #n', () => {
    const d = doc(para('p0', 'zero'), para('p1', 'one'));
    const hit = getNodeByRef(d, '#1');
    expect(hit).not.toBeNull();
    expect(hit!.path).toEqual([1]);
    expect(hit!.type).toBe('paragraph');
    expect(hit!.node.attrs.id).toBe('p1');
  });

  it('returns null for #n out of range', () => {
    const d = doc(para('p0'));
    expect(getNodeByRef(d, '#5')).toBeNull();
    expect(getNodeByRef(d, '#1')).toBeNull();
  });

  it('finds a nested node by id with the correct path', () => {
    const table = {
      type: 'table',
      content: [row([cell('tableCell', 'deep', 'found me')])],
    };
    const d = doc(para('p0'), table);
    const hit = getNodeByRef(d, 'deep');
    expect(hit).not.toBeNull();
    // doc.content[1] -> table.content[0] -> row.content[0] -> cell.content[0]
    expect(hit!.path).toEqual([1, 0, 0, 0]);
    expect(hit!.type).toBe('paragraph');
  });

  it('returns null when the id is not found', () => {
    const d = doc(para('p0'));
    expect(getNodeByRef(d, 'missing')).toBeNull();
  });

  it('returns the FIRST node for a duplicate id', () => {
    const d = doc(para('dup', 'first'), para('dup', 'second'));
    const hit = getNodeByRef(d, 'dup');
    expect(hit!.path).toEqual([0]);
    expect(blockPlainText(hit!.node)).toBe('first');
  });

  it('returns null for a non-object doc', () => {
    expect(getNodeByRef(null, '#0')).toBeNull();
    expect(getNodeByRef('x', 'id')).toBeNull();
  });

  it('returns a CLONE — mutating it does not touch the input doc', () => {
    const d = doc(para('p0', 'orig'));
    const snapshot = structuredClone(d);
    const hit = getNodeByRef(d, 'p0');
    hit!.node.attrs.id = 'mutated';
    hit!.node.content.push(text('extra'));
    expect(d).toEqual(snapshot);
  });
});

// ===========================================================================
// replaceNodeById
// ===========================================================================
describe('replaceNodeById', () => {
  const newNode = () => ({ type: 'paragraph', attrs: { id: 'new' }, content: [text('NEW')] });

  it('reports replaced:0 when nothing matches', () => {
    const d = doc(para('p0'));
    const res = replaceNodeById(d, 'missing', newNode());
    expect(res.replaced).toBe(0);
    expect(res.doc).toEqual(d);
  });

  it('replaces a single match', () => {
    const d = doc(para('p0', 'old'), para('p1'));
    const res = replaceNodeById(d, 'p0', newNode());
    expect(res.replaced).toBe(1);
    expect(res.doc.content[0]).toEqual(newNode());
    expect(res.doc.content[1].attrs.id).toBe('p1');
  });

  it('replaces N matches', () => {
    const d = doc(para('dup', 'a'), para('keep'), para('dup', 'b'));
    const res = replaceNodeById(d, 'dup', newNode());
    expect(res.replaced).toBe(2);
    expect(res.doc.content[0]).toEqual(newNode());
    expect(res.doc.content[1].attrs.id).toBe('keep');
    expect(res.doc.content[2]).toEqual(newNode());
  });

  it('replaces a nested match inside a table cell', () => {
    const table = {
      type: 'table',
      content: [row([cell('tableCell', 'inner', 'x')])],
    };
    const d = doc(table);
    const res = replaceNodeById(d, 'inner', newNode());
    expect(res.replaced).toBe(1);
    expect(res.doc.content[0].content[0].content[0].content[0]).toEqual(newNode());
  });

  it('does NOT recurse into the substituted node', () => {
    // The replacement itself carries the same id; it must not be re-replaced.
    const d = doc(para('target'));
    const replacement = { type: 'paragraph', attrs: { id: 'target' }, content: [text('R')] };
    const res = replaceNodeById(d, 'target', replacement);
    expect(res.replaced).toBe(1); // not 2 — no recursion into the new node
  });

  it('gives each match a SEPARATE clone', () => {
    const d = doc(para('dup'), para('dup'));
    const res = replaceNodeById(d, 'dup', newNode());
    res.doc.content[0].content.push(text('mutated'));
    // The second replacement must be untouched.
    expect(res.doc.content[1]).toEqual(newNode());
  });

  it('does not mutate the input doc', () => {
    const d = doc(para('p0', 'old'));
    const snapshot = structuredClone(d);
    replaceNodeById(d, 'p0', newNode());
    expect(d).toEqual(snapshot);
  });
});

// ===========================================================================
// deleteNodeById
// ===========================================================================
describe('deleteNodeById', () => {
  it('reports deleted:0 when nothing matches', () => {
    const d = doc(para('p0'));
    const res = deleteNodeById(d, 'missing');
    expect(res.deleted).toBe(0);
    expect(res.doc).toEqual(d);
  });

  it('deletes a single match', () => {
    const d = doc(para('p0'), para('p1'), para('p2'));
    const res = deleteNodeById(d, 'p1');
    expect(res.deleted).toBe(1);
    expect(res.doc.content.map((c: any) => c.attrs.id)).toEqual(['p0', 'p2']);
  });

  it('deletes N matches', () => {
    const d = doc(para('dup'), para('keep'), para('dup'));
    const res = deleteNodeById(d, 'dup');
    expect(res.deleted).toBe(2);
    expect(res.doc.content.map((c: any) => c.attrs.id)).toEqual(['keep']);
  });

  it('deletes a nested node and preserves sibling order', () => {
    // A callout-style container holding three paragraph children; deleting the
    // middle one must leave the outer siblings in order.
    const callout = {
      type: 'callout',
      attrs: { id: 'cal' },
      content: [para('a', 'A'), para('b', 'B'), para('c', 'C')],
    };
    const d = doc(para('outer0'), callout, para('outer1'));
    const res = deleteNodeById(d, 'b');
    expect(res.deleted).toBe(1);
    // Inner siblings keep their order.
    const innerIds = res.doc.content[1].content.map((cl: any) => cl.attrs.id);
    expect(innerIds).toEqual(['a', 'c']);
    // Outer siblings are untouched and in order.
    const outerIds = res.doc.content.map((cl: any) => cl.attrs.id);
    expect(outerIds).toEqual(['outer0', 'cal', 'outer1']);
  });

  it('does not mutate the input doc (deep-equal before/after)', () => {
    const d = doc(para('p0'), para('p1'));
    const snapshot = structuredClone(d);
    deleteNodeById(d, 'p0');
    expect(d).toEqual(snapshot);
  });
});

// ===========================================================================
// sanitizeForYjs
// ===========================================================================
describe('sanitizeForYjs', () => {
  it('strips undefined keys from node.attrs', () => {
    const d = doc({ type: 'paragraph', attrs: { id: 'p', gone: undefined, kept: 1 } });
    const res = sanitizeForYjs(d);
    expect('gone' in res.content[0].attrs).toBe(false);
    expect(res.content[0].attrs).toEqual({ id: 'p', kept: 1 });
  });

  it('strips undefined keys from mark.attrs', () => {
    const d = doc({
      type: 'paragraph',
      attrs: { id: 'p' },
      content: [text('hi', [{ type: 'link', attrs: { href: 'u', gone: undefined } }])],
    });
    const res = sanitizeForYjs(d);
    expect('gone' in res.content[0].content[0].marks[0].attrs).toBe(false);
    expect(res.content[0].content[0].marks[0].attrs).toEqual({ href: 'u' });
  });

  it('PRESERVES null, false, 0 and "" (only undefined is dropped)', () => {
    const d = doc({
      type: 'paragraph',
      attrs: { a: null, b: false, c: 0, d: '', e: undefined },
    });
    const res = sanitizeForYjs(d);
    expect(res.content[0].attrs).toEqual({ a: null, b: false, c: 0, d: '' });
  });

  it('recurses into nested content', () => {
    const d = doc({
      type: 'table',
      content: [row([cell('tableCell', null, '', { gone: undefined, colwidth: null })])],
    });
    const res = sanitizeForYjs(d);
    const cellAttrs = res.content[0].content[0].content[0].attrs;
    expect('gone' in cellAttrs).toBe(false);
    expect(cellAttrs.colwidth).toBeNull();
  });

  it('does not mutate the input doc', () => {
    const d = doc({ type: 'paragraph', attrs: { id: 'p', gone: undefined } });
    // structuredClone preserves an explicit `undefined` value key, so snapshot it.
    const snapshot = structuredClone(d);
    sanitizeForYjs(d);
    expect(d).toEqual(snapshot);
    expect('gone' in d.content[0].attrs).toBe(true); // still present on the input
  });
});

// ===========================================================================
// findUnstorableAttr
// ===========================================================================
describe('findUnstorableAttr', () => {
  it('returns null for a fully storable doc', () => {
    const d = doc(para('p0', 'clean'));
    expect(findUnstorableAttr(d)).toBeNull();
  });

  it('detects an undefined node attr with its path and kind', () => {
    const d = doc(para('a'), para('b'), { type: 'paragraph', attrs: { id: 'c', x: undefined } });
    expect(findUnstorableAttr(d)).toBe('content[2].attrs.x (undefined)');
  });

  it('detects a function attr', () => {
    const d = doc({ type: 'paragraph', attrs: { fn: () => 1 } });
    expect(findUnstorableAttr(d)).toBe('content[0].attrs.fn (function)');
  });

  it('detects a symbol attr', () => {
    const d = doc({ type: 'paragraph', attrs: { s: Symbol('x') } });
    expect(findUnstorableAttr(d)).toBe('content[0].attrs.s (symbol)');
  });

  it('detects a bigint attr', () => {
    const d = doc({ type: 'paragraph', attrs: { big: 10n } });
    expect(findUnstorableAttr(d)).toBe('content[0].attrs.big (bigint)');
  });

  it('detects an unstorable mark attr with the marks[i] path', () => {
    const d = doc({
      type: 'paragraph',
      attrs: { id: 'p' },
      content: [text('hi'), text('yo', [{ type: 'link', attrs: { x: undefined } }])],
    });
    expect(findUnstorableAttr(d)).toBe('content[0].content[1].marks[0].attrs.x (undefined)');
  });

  it('returns the FIRST hit only', () => {
    const d = doc(
      { type: 'paragraph', attrs: { first: undefined } },
      { type: 'paragraph', attrs: { second: undefined } },
    );
    expect(findUnstorableAttr(d)).toBe('content[0].attrs.first (undefined)');
  });

  it('returns null for a non-object doc', () => {
    expect(findUnstorableAttr(null)).toBeNull();
    expect(findUnstorableAttr('x')).toBeNull();
  });
});

// ===========================================================================
// insertNodeRelative
// ===========================================================================
describe('insertNodeRelative', () => {
  const block = (id: string, value = '') => para(id, value);

  it('appends a node to top-level content', () => {
    const d = doc(para('p0'));
    const res = insertNodeRelative(d, block('new', 'N'), { position: 'append' });
    expect(res.inserted).toBe(true);
    expect(res.doc.content.map((c: any) => c.attrs.id)).toEqual(['p0', 'new']);
  });

  it('creates a content array when appending to a doc without one', () => {
    const res = insertNodeRelative({ type: 'doc' }, block('new'), { position: 'append' });
    expect(res.inserted).toBe(true);
    expect(res.doc.content.map((c: any) => c.attrs.id)).toEqual(['new']);
  });

  it('inserts before a node by id (top level)', () => {
    const d = doc(para('p0'), para('p1'));
    const res = insertNodeRelative(d, block('new'), { position: 'before', anchorNodeId: 'p1' });
    expect(res.inserted).toBe(true);
    expect(res.doc.content.map((c: any) => c.attrs.id)).toEqual(['p0', 'new', 'p1']);
  });

  it('inserts after a node by id (top level)', () => {
    const d = doc(para('p0'), para('p1'));
    const res = insertNodeRelative(d, block('new'), { position: 'after', anchorNodeId: 'p0' });
    expect(res.inserted).toBe(true);
    expect(res.doc.content.map((c: any) => c.attrs.id)).toEqual(['p0', 'new', 'p1']);
  });

  it('inserts before a NESTED anchor by id, into its own parent content', () => {
    const table = {
      type: 'table',
      content: [row([cell('tableCell', 'inner', 'x')])],
    };
    const d = doc(table);
    const res = insertNodeRelative(d, block('new'), { position: 'before', anchorNodeId: 'inner' });
    expect(res.inserted).toBe(true);
    // The new (non-structural) node is spliced into the cell's content before the paragraph.
    const cellContent = res.doc.content[0].content[0].content[0].content;
    expect(cellContent.map((c: any) => c.attrs.id)).toEqual(['new', 'inner']);
  });

  it('inserts by anchorText against top-level blocks (substring match)', () => {
    const d = doc(para('p0', 'hello world'), para('p1', 'other'));
    const res = insertNodeRelative(d, block('new'), { position: 'after', anchorText: 'world' });
    expect(res.inserted).toBe(true);
    expect(res.doc.content.map((c: any) => c.attrs.id)).toEqual(['p0', 'new', 'p1']);
  });

  it('returns inserted:false when the anchor cannot be resolved', () => {
    const d = doc(para('p0'));
    const byId = insertNodeRelative(d, block('new'), { position: 'after', anchorNodeId: 'nope' });
    expect(byId.inserted).toBe(false);
    expect(byId.doc).toEqual(d);

    const byText = insertNodeRelative(d, block('new'), { position: 'before', anchorText: 'zzz' });
    expect(byText.inserted).toBe(false);
    expect(byText.doc).toEqual(d);
  });

  it('routes a structural tableRow to the nearest table container', () => {
    const table = {
      type: 'table',
      content: [
        row([cell('tableCell', 'r0c0', 'A')]),
        row([cell('tableCell', 'r1c0', 'B')]),
      ],
    };
    const d = doc(table);
    const newRow = row([cell('tableCell', 'rNew', 'NEW')]);
    // Anchor on a cell paragraph inside row 0; "after" should put the row after row 0.
    const res = insertNodeRelative(d, newRow, { position: 'after', anchorNodeId: 'r0c0' });
    expect(res.inserted).toBe(true);
    const rowFirstCellId = (r: any) => r.content[0].content[0].attrs.id;
    expect(res.doc.content[0].content.map(rowFirstCellId)).toEqual(['r0c0', 'rNew', 'r1c0']);
  });

  it('throws when appending a structural node at the top level', () => {
    const d = doc(para('p0'));
    const newRow = row([cell('tableCell', 'x', 'X')]);
    expect(() => insertNodeRelative(d, newRow, { position: 'append' })).toThrow(
      /cannot append a tableRow at the top level/,
    );
  });

  it('throws when a structural anchor is not inside the required container', () => {
    // Anchor resolves to a top-level paragraph that is not inside any table.
    const d = doc(para('p0', 'loose'));
    const newRow = row([cell('tableCell', 'x', 'X')]);
    expect(() =>
      insertNodeRelative(d, newRow, { position: 'after', anchorNodeId: 'p0' }),
    ).toThrow(/the anchor is not inside a table/);
  });

  it('honours offset: before vs after place the node on the correct side', () => {
    const d = doc(para('a'), para('b'), para('c'));
    const before = insertNodeRelative(d, block('N'), { position: 'before', anchorNodeId: 'b' });
    expect(before.doc.content.map((c: any) => c.attrs.id)).toEqual(['a', 'N', 'b', 'c']);
    const after = insertNodeRelative(d, block('N'), { position: 'after', anchorNodeId: 'b' });
    expect(after.doc.content.map((c: any) => c.attrs.id)).toEqual(['a', 'b', 'N', 'c']);
  });

  it('does not mutate the input doc or the node argument', () => {
    const d = doc(para('p0'));
    const dSnapshot = structuredClone(d);
    const node = block('new', 'N');
    const nodeSnapshot = structuredClone(node);
    insertNodeRelative(d, node, { position: 'append' });
    expect(d).toEqual(dSnapshot);
    expect(node).toEqual(nodeSnapshot);
  });
});

// ===========================================================================
// readTable
// ===========================================================================
describe('readTable', () => {
  const makeTable = () => ({
    type: 'table',
    content: [
      row([cell('tableHeader', 'h0', 'H0'), cell('tableHeader', 'h1', 'H1')]),
      row([cell('tableCell', 'c0', 'A'), cell('tableCell', 'c1', 'B')]),
    ],
  });

  it('reads a table by #n', () => {
    const d = doc(para('p0'), makeTable());
    const res = readTable(d, '#1');
    expect(res).not.toBeNull();
    expect(res!.rows).toBe(2);
    expect(res!.cols).toBe(2);
    expect(res!.cells).toEqual([['H0', 'H1'], ['A', 'B']]);
    expect(res!.cellIds).toEqual([['h0', 'h1'], ['c0', 'c1']]);
    expect(res!.path).toEqual([1]);
  });

  it('climbs from an inner paragraph id up to the table', () => {
    const d = doc(makeTable());
    const res = readTable(d, 'c1'); // id of a paragraph inside a data cell
    expect(res).not.toBeNull();
    expect(res!.path).toEqual([0]);
    expect(res!.cells).toEqual([['H0', 'H1'], ['A', 'B']]);
  });

  it('reports per-row widths via cells for a ragged table', () => {
    const table = {
      type: 'table',
      content: [
        row([cell('tableHeader', 'h0', 'H0')]),
        row([cell('tableCell', 'c0', 'A'), cell('tableCell', 'c1', 'B')]),
      ],
    };
    const res = readTable(doc(table), '#0');
    expect(res!.cols).toBe(1); // cols comes from row 0
    expect(res!.cells).toEqual([['H0'], ['A', 'B']]); // actual per-row widths preserved
    expect(res!.cellIds).toEqual([['h0'], ['c0', 'c1']]);
  });

  it('reports null cellId for an empty cell with no paragraph', () => {
    const table = {
      type: 'table',
      content: [row([cell('tableCell', null), cell('tableCell', 'c1', 'B')])],
    };
    const res = readTable(doc(table), '#0');
    expect(res!.cells).toEqual([['', 'B']]);
    expect(res!.cellIds).toEqual([[null, 'c1']]);
  });

  it('returns null when the ref matches no table', () => {
    const d = doc(para('p0'));
    expect(readTable(d, '#0')).toBeNull(); // #0 is a paragraph, not a table
    expect(readTable(d, 'missing')).toBeNull();
    expect(readTable(d, 'p0')).toBeNull(); // id found but no enclosing table
  });
});

// ===========================================================================
// insertTableRow
// ===========================================================================
describe('insertTableRow', () => {
  const makeTable = () => ({
    type: 'table',
    content: [
      row([
        cell('tableHeader', 'h0', 'H0', { colwidth: [120] }),
        cell('tableHeader', 'h1', 'H1', { colwidth: [240] }),
      ]),
      row([cell('tableCell', 'c0', 'A'), cell('tableCell', 'c1', 'B')]),
    ],
  });

  /** First-paragraph ids of every cell in a row, for ordering assertions. */
  const rowCellParaIds = (r: any): (string | undefined)[] =>
    r.content.map((c: any) => c.content[0]?.attrs?.id);
  /** Cell text of a row. */
  const rowTexts = (r: any): string[] =>
    r.content.map((c: any) => blockPlainText(c));

  it('appends a row when index is omitted', () => {
    const d = doc(makeTable());
    const res = insertTableRow(d, '#0', ['X', 'Y']);
    expect(res.inserted).toBe(true);
    const rows = res.doc.content[0].content;
    expect(rows.length).toBe(3);
    expect(rowTexts(rows[2])).toEqual(['X', 'Y']);
  });

  it('splices at a middle index', () => {
    const d = doc(makeTable());
    const res = insertTableRow(d, '#0', ['X', 'Y'], 1);
    const rows = res.doc.content[0].content;
    expect(rows.length).toBe(3);
    expect(rowTexts(rows[1])).toEqual(['X', 'Y']); // new row at index 1
    expect(rowTexts(rows[2])).toEqual(['A', 'B']); // old data row pushed down
  });

  it('splices at the end index', () => {
    const d = doc(makeTable());
    const res = insertTableRow(d, '#0', ['X', 'Y'], 2); // rows == 2, valid end index
    const rows = res.doc.content[0].content;
    expect(rows.length).toBe(3);
    expect(rowTexts(rows[2])).toEqual(['X', 'Y']);
  });

  it('APPENDS (does not throw) for an out-of-range index', () => {
    const d = doc(makeTable());
    const res = insertTableRow(d, '#0', ['X', 'Y'], 99);
    const rows = res.doc.content[0].content;
    expect(res.inserted).toBe(true);
    expect(rows.length).toBe(3);
    expect(rowTexts(rows[2])).toEqual(['X', 'Y']); // appended at the end
  });

  it('throws when given more cells than columns', () => {
    const d = doc(makeTable());
    expect(() => insertTableRow(d, '#0', ['X', 'Y', 'Z'])).toThrow(
      /got 3 cell\(s\) but the table has 2 column\(s\)/,
    );
  });

  it('pads a short row to the column count', () => {
    const d = doc(makeTable());
    const res = insertTableRow(d, '#0', ['only']);
    const rows = res.doc.content[0].content;
    expect(rowTexts(rows[2])).toEqual(['only', '']); // padded with empty cell
  });

  it('copies colwidth from the header row for each column', () => {
    const d = doc(makeTable());
    const res = insertTableRow(d, '#0', ['X', 'Y']);
    const newRow = res.doc.content[0].content[2];
    expect(newRow.content[0].attrs.colwidth).toEqual([120]);
    expect(newRow.content[1].attrs.colwidth).toEqual([240]);
    expect(newRow.content[0].attrs).toMatchObject({ colspan: 1, rowspan: 1 });
  });

  it('index 0 inherits the header cell TYPE', () => {
    const d = doc(makeTable());
    const res = insertTableRow(d, '#0', ['X', 'Y'], 0);
    const newRow = res.doc.content[0].content[0];
    expect(newRow.content.every((c: any) => c.type === 'tableHeader')).toBe(true);
    // A non-zero index produces plain data cells instead.
    const res2 = insertTableRow(d, '#0', ['X', 'Y'], 1);
    const dataRow = res2.doc.content[0].content[1];
    expect(dataRow.content.every((c: any) => c.type === 'tableCell')).toBe(true);
  });

  it('mints unique, well-formed paragraph ids for new cells', () => {
    const d = doc(makeTable());
    const existing = new Set(['h0', 'h1', 'c0', 'c1']);
    const res = insertTableRow(d, '#0', ['X', 'Y']);
    const newRow = res.doc.content[0].content[2];
    const ids = rowCellParaIds(newRow) as string[];
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[a-z0-9]{12}$/); // Docmost-style 12-char id
      expect(existing.has(id)).toBe(false); // unique vs pre-existing ids
    }
    expect(new Set(ids).size).toBe(ids.length); // unique within the row
  });

  it('returns inserted:false when the table cannot be located', () => {
    const d = doc(para('p0'));
    const res = insertTableRow(d, 'missing', ['X']);
    expect(res.inserted).toBe(false);
    expect(res.doc).toEqual(d);
  });

  it('does not mutate the input doc', () => {
    const d = doc(makeTable());
    const snapshot = structuredClone(d);
    insertTableRow(d, '#0', ['X', 'Y'], 1);
    expect(d).toEqual(snapshot);
  });
});

// ===========================================================================
// deleteTableRow
// ===========================================================================
describe('deleteTableRow', () => {
  const makeTable = () => ({
    type: 'table',
    content: [
      row([cell('tableHeader', 'h0', 'H')]),
      row([cell('tableCell', 'c0', 'A')]),
      row([cell('tableCell', 'c1', 'B')]),
    ],
  });
  const firstId = (r: any) => r.content[0].content[0].attrs.id;

  it('deletes a middle row and preserves siblings', () => {
    const d = doc(makeTable());
    const res = deleteTableRow(d, '#0', 1);
    expect(res.deleted).toBe(true);
    expect(res.doc.content[0].content.map(firstId)).toEqual(['h0', 'c1']);
  });

  it('deletes the first row', () => {
    const d = doc(makeTable());
    const res = deleteTableRow(d, '#0', 0);
    expect(res.doc.content[0].content.map(firstId)).toEqual(['c0', 'c1']);
  });

  it('deletes the last row', () => {
    const d = doc(makeTable());
    const res = deleteTableRow(d, '#0', 2);
    expect(res.doc.content[0].content.map(firstId)).toEqual(['h0', 'c0']);
  });

  it('throws on an out-of-range index', () => {
    const d = doc(makeTable());
    expect(() => deleteTableRow(d, '#0', 99)).toThrow(/out of range/);
    expect(() => deleteTableRow(d, '#0', -1)).toThrow(/out of range/);
  });

  it('throws when asked to delete the only row', () => {
    const single = {
      type: 'table',
      content: [row([cell('tableCell', 'c0', 'A')])],
    };
    expect(() => deleteTableRow(doc(single), '#0', 0)).toThrow(
      /refusing to delete the only row/,
    );
  });

  it('returns deleted:false when the table cannot be located', () => {
    const d = doc(para('p0'));
    const res = deleteTableRow(d, 'missing', 0);
    expect(res.deleted).toBe(false);
    expect(res.doc).toEqual(d);
  });

  it('does not mutate the input doc', () => {
    const d = doc(makeTable());
    const snapshot = structuredClone(d);
    deleteTableRow(d, '#0', 1);
    expect(d).toEqual(snapshot);
  });
});

// ===========================================================================
// updateTableCell
// ===========================================================================
describe('updateTableCell', () => {
  const makeTable = () => ({
    type: 'table',
    content: [
      row([cell('tableHeader', 'h0', 'H0'), cell('tableHeader', 'h1', 'H1')]),
      row([
        cell('tableCell', 'c0', 'A', { colspan: 2, rowspan: 3, colwidth: [200] }),
        cell('tableCell', 'c1', 'B'),
      ]),
    ],
  });

  it('sets the cell text', () => {
    const d = doc(makeTable());
    const res = updateTableCell(d, '#0', 1, 1, 'NEW');
    expect(res.updated).toBe(true);
    expect(blockPlainText(res.doc.content[0].content[1].content[1])).toBe('NEW');
  });

  it('REUSES the existing first-paragraph id', () => {
    const d = doc(makeTable());
    const res = updateTableCell(d, '#0', 1, 0, 'changed');
    const para0 = res.doc.content[0].content[1].content[0].content[0];
    expect(para0.attrs.id).toBe('c0'); // critical: id reused, not regenerated
    expect(para0.content[0].text).toBe('changed');
  });

  it('mints a fresh id when the cell had no paragraph', () => {
    const table = {
      type: 'table',
      content: [row([cell('tableCell', null), cell('tableCell', 'c1', 'B')])],
    };
    const d = doc(table);
    const res = updateTableCell(d, '#0', 0, 0, 'now has text');
    const newPara = res.doc.content[0].content[0].content[0].content[0];
    expect(typeof newPara.attrs.id).toBe('string');
    expect(newPara.attrs.id).toMatch(/^[a-z0-9]{12}$/);
    expect(newPara.attrs.id).not.toBe('c1'); // unique vs existing ids
    expect(newPara.content[0].text).toBe('now has text');
  });

  it('PRESERVES the cell colspan/rowspan/colwidth (only content replaced)', () => {
    const d = doc(makeTable());
    const res = updateTableCell(d, '#0', 1, 0, 'x');
    const cellNode = res.doc.content[0].content[1].content[0];
    expect(cellNode.attrs).toEqual({ colspan: 2, rowspan: 3, colwidth: [200] });
  });

  it('throws when row or col is out of range', () => {
    const d = doc(makeTable());
    expect(() => updateTableCell(d, '#0', 5, 0, 'x')).toThrow(/out of range/);
    expect(() => updateTableCell(d, '#0', 0, 5, 'x')).toThrow(/out of range/);
    expect(() => updateTableCell(d, '#0', -1, 0, 'x')).toThrow(/out of range/);
  });

  it('an empty string yields an empty paragraph content array', () => {
    const d = doc(makeTable());
    const res = updateTableCell(d, '#0', 1, 1, '');
    const cellPara = res.doc.content[0].content[1].content[1].content[0];
    expect(cellPara.type).toBe('paragraph');
    expect(cellPara.content).toEqual([]); // empty string -> empty content
    expect(cellPara.attrs.id).toBe('c1'); // id still reused
  });

  it('returns updated:false when the table cannot be located', () => {
    const d = doc(para('p0'));
    const res = updateTableCell(d, 'missing', 0, 0, 'x');
    expect(res.updated).toBe(false);
    expect(res.doc).toEqual(d);
  });

  it('does not mutate the input doc', () => {
    const d = doc(makeTable());
    const snapshot = structuredClone(d);
    updateTableCell(d, '#0', 1, 1, 'NEW');
    expect(d).toEqual(snapshot);
  });
});
