import {
  selectAccessibleHits,
  type SearchHitLike,
} from './ai-chat-tools.service';

/**
 * Unit tests for selectAccessibleHits — the CASL leak guard for the in-process
 * hybrid search. The hybrid query runs over pgvector + full-text WITHOUT CASL,
 * so this post-filter is the ONLY thing that drops pages the user cannot read.
 *
 * Core invariant: a hit on a page that is NOT in `accessibleSet` is dropped,
 * even when that page lives in an otherwise-accessible space. Plus: only the
 * best chunk per page survives (dedupe), results are capped, and an empty
 * accessibleSet yields nothing.
 */
function hit(pageId: string, title: string | null, content: string): SearchHitLike {
  return { pageId, title, content };
}

describe('selectAccessibleHits', () => {
  it('drops a hit on a page NOT in accessibleSet (the core leak guard)', () => {
    const hits = [
      hit('public-page', 'Public', 'visible body'),
      // restricted-page is in an accessible space but NOT page-accessible.
      hit('restricted-page', 'Secret', 'leaked body'),
    ];
    const accessibleSet = new Set(['public-page']);

    const out = selectAccessibleHits(hits, accessibleSet, 10);

    expect(out).toEqual([
      { id: 'public-page', title: 'Public', snippet: 'visible body' },
    ]);
    // The restricted page must NEVER appear in the output.
    expect(out.some((r) => r.id === 'restricted-page')).toBe(false);
  });

  it('keeps only the best (first) chunk per page when a page has duplicates', () => {
    const hits = [
      hit('p1', 'Page One', 'best chunk'),
      hit('p1', 'Page One', 'lower-ranked chunk'),
      hit('p2', 'Page Two', 'p2 chunk'),
    ];
    const accessibleSet = new Set(['p1', 'p2']);

    const out = selectAccessibleHits(hits, accessibleSet, 10);

    expect(out).toEqual([
      { id: 'p1', title: 'Page One', snippet: 'best chunk' },
      { id: 'p2', title: 'Page Two', snippet: 'p2 chunk' },
    ]);
  });

  it('caps the number of results at `cap`', () => {
    const hits = [
      hit('p1', 't1', 'c1'),
      hit('p2', 't2', 'c2'),
      hit('p3', 't3', 'c3'),
      hit('p4', 't4', 'c4'),
    ];
    const accessibleSet = new Set(['p1', 'p2', 'p3', 'p4']);

    const out = selectAccessibleHits(hits, accessibleSet, 2);

    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('returns an empty list when accessibleSet is empty', () => {
    const hits = [hit('p1', 't1', 'c1'), hit('p2', 't2', 'c2')];

    expect(selectAccessibleHits(hits, new Set<string>(), 10)).toEqual([]);
  });

  it('defaults a null title to an empty string', () => {
    const out = selectAccessibleHits(
      [hit('p1', null, 'body')],
      new Set(['p1']),
      10,
    );
    expect(out).toEqual([{ id: 'p1', title: '', snippet: 'body' }]);
  });

  /**
   * Regression sentinel for the leak guard: if the access intersection
   * (`accessibleSet.has(hit.pageId)` filter) were removed, the restricted page
   * would slip into the output and THIS assertion would fail. Documents that
   * the filter — not the dedupe/cap — is what enforces page-level access.
   */
  it('FAILS if the access intersection is removed (sentinel)', () => {
    const hits = [hit('restricted', 'Secret', 'leaked')];
    // Page is NOT accessible -> output MUST be empty. Without the intersection
    // check the function would return the restricted hit and break this test.
    expect(selectAccessibleHits(hits, new Set<string>(), 10)).toEqual([]);
  });
});
