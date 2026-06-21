import {
  buildTree,
  computeLocalPath,
  getExportExtension,
  extractPageSlugId,
  getInternalLinkPageName,
  INTERNAL_LINK_REGEX,
  PageExportTree,
} from './utils';
import { ExportFormat } from './dto/export-dto';
import { Page } from '@docmost/db/types/entity.types';

/**
 * Unit tests for export/utils.ts pure helpers:
 *  - buildTree: groups pages by parentPageId and de-duplicates sibling titles.
 *  - computeLocalPath / getExportExtension: builds the slugId -> file path map.
 *  - extractPageSlugId / INTERNAL_LINK_REGEX: parse the trailing slugId.
 *  - getInternalLinkPageName: derive a page name from a relative file path.
 */

function page(partial: Partial<Page>): Page {
  return partial as Page;
}

describe('buildTree', () => {
  it('groups pages by their parentPageId', () => {
    const pages = [
      page({ id: 'a', parentPageId: 'root', title: 'A', slugId: 'sa' }),
      page({ id: 'b', parentPageId: 'root', title: 'B', slugId: 'sb' }),
      page({ id: 'c', parentPageId: 'a', title: 'C', slugId: 'sc' }),
    ];

    const tree = buildTree(pages);

    expect(Object.keys(tree).sort()).toEqual(['a', 'root']);
    expect(tree['root'].map((p) => p.id)).toEqual(['a', 'b']);
    expect(tree['a'].map((p) => p.id)).toEqual(['c']);
  });

  it('suffixes duplicate sibling titles with " (1)", " (2)"', () => {
    const pages = [
      page({ id: '1', parentPageId: 'root', title: 'Doc', slugId: 's1' }),
      page({ id: '2', parentPageId: 'root', title: 'Doc', slugId: 's2' }),
      page({ id: '3', parentPageId: 'root', title: 'Doc', slugId: 's3' }),
    ];

    const tree = buildTree(pages);

    expect(tree['root'].map((p) => p.title)).toEqual([
      'Doc',
      'Doc (1)',
      'Doc (2)',
    ]);
  });

  it('does not collide identical titles across different parents', () => {
    const pages = [
      page({ id: '1', parentPageId: 'p1', title: 'Same', slugId: 's1' }),
      page({ id: '2', parentPageId: 'p2', title: 'Same', slugId: 's2' }),
    ];

    const tree = buildTree(pages);

    expect(tree['p1'][0].title).toBe('Same');
    expect(tree['p2'][0].title).toBe('Same');
  });

  it('falls back to "untitled" for empty titles', () => {
    const pages = [
      page({ id: '1', parentPageId: 'root', title: '', slugId: 's1' }),
    ];

    const tree = buildTree(pages);

    expect(tree['root'][0].title).toBe('untitled');
  });

  it('returns an empty object for empty input', () => {
    expect(buildTree([])).toEqual({});
  });
});

describe('computeLocalPath + getExportExtension', () => {
  it('builds nested parent/child paths with the markdown extension', () => {
    const tree: PageExportTree = {
      // root level uses the literal string 'null' as key only when parentPageId
      // is null; here we use an explicit top-level key.
      top: [page({ id: 'parent', title: 'Parent', slugId: 'sp' })],
      parent: [page({ id: 'child', title: 'Child', slugId: 'sc' })],
    };
    const slugIdToPath: Record<string, string> = {};

    computeLocalPath(tree, ExportFormat.Markdown, 'top', '', slugIdToPath);

    expect(slugIdToPath['sp']).toBe('Parent.md');
    expect(slugIdToPath['sc']).toBe('Parent/Child.md');
  });

  it('uses the html extension when the format is html', () => {
    const tree: PageExportTree = {
      top: [page({ id: 'parent', title: 'Parent', slugId: 'sp' })],
    };
    const slugIdToPath: Record<string, string> = {};

    computeLocalPath(tree, ExportFormat.HTML, 'top', '', slugIdToPath);

    expect(slugIdToPath['sp']).toBe('Parent.html');
  });

  it('getExportExtension returns the right extension and undefined for unknown', () => {
    expect(getExportExtension(ExportFormat.HTML)).toBe('.html');
    expect(getExportExtension(ExportFormat.Markdown)).toBe('.md');
    expect(getExportExtension('pdf')).toBeUndefined();
  });
});

describe('extractPageSlugId', () => {
  it('returns the trailing segment after the last dash', () => {
    expect(extractPageSlugId('slug-with-dashes-abc123')).toBe('abc123');
  });

  it('returns the input unchanged when there is no dash (bare slugId)', () => {
    expect(extractPageSlugId('abc123')).toBe('abc123');
  });

  it('returns undefined for empty input', () => {
    expect(extractPageSlugId('')).toBeUndefined();
  });
});

describe('INTERNAL_LINK_REGEX', () => {
  it('matches a /s/{space}/p/{slug} url and captures the slug in group 5', () => {
    const match = '/s/space/p/page-abc123'.match(INTERNAL_LINK_REGEX);
    expect(match).not.toBeNull();
    expect(match![5]).toBe('page-abc123');
    expect(extractPageSlugId(match![5])).toBe('abc123');
  });

  it('does not match a non-internal url', () => {
    expect('https://example.com/foo/bar'.match(INTERNAL_LINK_REGEX)).toBeNull();
  });
});

describe('getInternalLinkPageName', () => {
  it('strips the file extension and decodes the name', () => {
    expect(getInternalLinkPageName('Parent/My%20Page.md')).toBe('My Page');
  });

  it('falls back to the raw name without throwing on malformed encoding', () => {
    // "%E0%A4" is an incomplete escape; decodeURIComponent throws and the
    // helper returns the raw (still-encoded) name.
    let result: string | undefined;
    expect(() => {
      result = getInternalLinkPageName('dir/%E0%A4.md', 'current.md');
    }).not.toThrow();
    expect(result).toBe('%E0%A4');
  });
});
