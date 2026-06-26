import { load, CheerioAPI, Cheerio } from 'cheerio';
import { normalizeTableColumnWidths } from './table-utils';

/**
 * Unit tests for normalizeTableColumnWidths: it writes a `colwidth` attribute
 * onto the first-row cells of every <table>, deriving widths from a <colgroup>
 * or the first row, accounting for colspan, and falling back to a default
 * per-column width (150px) when no pixel widths are present. Re-running the
 * transform on its own output must be a no-op (idempotent).
 */

const DEFAULT = 150;

function run(html: string): { $: CheerioAPI; $root: Cheerio<any> } {
  const $ = load(html);
  const $root = $.root();
  normalizeTableColumnWidths($, $root);
  return { $, $root };
}

function firstRowColwidths($root: Cheerio<any>): (string | undefined)[] {
  return $root
    .find('table')
    .first()
    .find('> tbody > tr, > thead > tr, > tr')
    .first()
    .children('td, th')
    .map((_, el) => (el as any).attribs?.colwidth)
    .get();
}

describe('normalizeTableColumnWidths', () => {
  it('applies colgroup <col width> to the first-row cells', () => {
    const html =
      '<table>' +
      '<colgroup><col width="120"><col width="80"></colgroup>' +
      '<tbody><tr><td>a</td><td>b</td></tr></tbody>' +
      '</table>';
    const { $root } = run(html);

    expect(firstRowColwidths($root)).toEqual(['120', '80']);
  });

  it('falls back to first-row cell widths when there is no colgroup', () => {
    const html =
      '<table><tbody>' +
      '<tr><td style="width: 200px">a</td><td width="90">b</td></tr>' +
      '</tbody></table>';
    const { $root } = run(html);

    expect(firstRowColwidths($root)).toEqual(['200', '90']);
  });

  it('splits a colspan width across the spanned columns', () => {
    // colspan=2 with width 100 => each derived column ~50, the spanning cell
    // then gets the joined slice "50,50".
    const html =
      '<table><tbody>' +
      '<tr><td colspan="2" width="100">merged</td></tr>' +
      '</tbody></table>';
    const { $root } = run(html);

    expect(firstRowColwidths($root)).toEqual(['50,50']);
  });

  it('ignores em/% widths (treated as no width) and applies the default', () => {
    const html =
      '<table><tbody>' +
      '<tr><td style="width: 10em">a</td><td style="width: 50%">b</td></tr>' +
      '</tbody></table>';
    const { $root } = run(html);

    expect(firstRowColwidths($root)).toEqual([String(DEFAULT), String(DEFAULT)]);
  });

  it('applies the default per-column width to a markdown-style table with no widths', () => {
    const html =
      '<table><tbody>' +
      '<tr><td>a</td><td>b</td><td>c</td></tr>' +
      '<tr><td>1</td><td>2</td><td>3</td></tr>' +
      '</tbody></table>';
    const { $root } = run(html);

    expect(firstRowColwidths($root)).toEqual([
      String(DEFAULT),
      String(DEFAULT),
      String(DEFAULT),
    ]);
  });

  it('is idempotent: re-running on its own output changes nothing', () => {
    const html =
      '<table>' +
      '<colgroup><col width="120"><col width="80"></colgroup>' +
      '<tbody><tr><td>a</td><td>b</td></tr></tbody>' +
      '</table>';
    const { $, $root } = run(html);
    const afterFirst = $root.html();

    // second pass
    normalizeTableColumnWidths($, $root);
    expect($root.html()).toBe(afterFirst);
    expect(firstRowColwidths($root)).toEqual(['120', '80']);
  });
});
