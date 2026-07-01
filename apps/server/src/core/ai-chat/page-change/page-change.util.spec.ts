import {
  computePageChange,
  normalizeMarkdown,
} from './page-change.util';

/**
 * Unit tests for the pure page-change diff util (#274). Covers: a real content
 * change produces a non-empty unified diff; identical input produces no change;
 * a whitespace-only difference normalizes away to no change; and a large diff is
 * capped with the getPage hint.
 */
describe('computePageChange', () => {
  it('reports a change and a unified diff when content differs', () => {
    const before = '# Title\n\nHello world.';
    const after = '# Title\n\nHello brave new world.';

    const res = computePageChange(before, after);

    expect(res.changed).toBe(true);
    // Standard unified-diff markers + the actual removed/added lines.
    expect(res.diff).toContain('@@');
    expect(res.diff).toContain('-Hello world.');
    expect(res.diff).toContain('+Hello brave new world.');
  });

  it('reports no change for identical input', () => {
    const md = '# Title\n\nSame content.';
    expect(computePageChange(md, md)).toEqual({ changed: false, diff: '' });
  });

  it('normalizes whitespace-only differences to no change', () => {
    // Trailing spaces, CRLF line endings, and extra leading/trailing blank lines
    // are the kind of churn two renders can differ by — must NOT count as a change.
    const before = 'Line one\nLine two';
    const after = '\r\n\r\nLine one   \r\nLine two\t\r\n\r\n';

    const res = computePageChange(before, after);

    expect(res.changed).toBe(false);
    expect(res.diff).toBe('');
  });

  it('caps a large diff and appends the getPage hint', () => {
    const before = '';
    // A big block of distinct lines forces a diff well over the cap.
    const after = Array.from({ length: 2000 }, (_, i) => `new line ${i}`).join(
      '\n',
    );

    const res = computePageChange(before, after);

    expect(res.changed).toBe(true);
    expect(res.diff).toContain('use getPage to read the full current page');
    // Cap (6000) + the short truncation hint; never the full multi-KB patch.
    expect(res.diff.length).toBeLessThan(6200);
  });
});

describe('normalizeMarkdown', () => {
  it('strips trailing whitespace, unifies newlines, trims blank edges', () => {
    expect(normalizeMarkdown('\r\n a  \r\nb\t\n\n')).toBe(' a\nb');
  });

  it('coerces null/undefined to an empty string', () => {
    expect(normalizeMarkdown(undefined as unknown as string)).toBe('');
  });
});
