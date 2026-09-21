import {
  resolveCurrentPageResult,
  sanitizeSelection,
} from './current-page.util';

/**
 * Unit tests for resolveCurrentPageResult (pure function). Mirrors the
 * getCurrentPage tool's contract: { page: null, selection: null } when no page
 * is open (no id), otherwise { page: { id, title }, selection } with title
 * defaulting to '' and the selection passed through from the resolved context.
 */
describe('resolveCurrentPageResult', () => {
  it('returns { page: null, selection: null } when openedPage is undefined', () => {
    expect(resolveCurrentPageResult(undefined)).toEqual({
      page: null,
      selection: null,
    });
  });

  it('returns { page: null, selection: null } when openedPage is null', () => {
    expect(resolveCurrentPageResult(null)).toEqual({
      page: null,
      selection: null,
    });
  });

  it('returns { page: null, selection: null } when openedPage has no id', () => {
    expect(resolveCurrentPageResult({})).toEqual({
      page: null,
      selection: null,
    });
    expect(resolveCurrentPageResult({ title: 'x' })).toEqual({
      page: null,
      selection: null,
    });
  });

  it('returns { page: null, selection: null } when id is an empty string', () => {
    expect(resolveCurrentPageResult({ id: '' })).toEqual({
      page: null,
      selection: null,
    });
  });

  it('drops the selection when there is no page (selection dies with the page)', () => {
    // Even if a selection somehow rode along without a page id, a null page
    // always yields a null selection.
    expect(
      resolveCurrentPageResult({ selection: { text: 'orphan' } }),
    ).toEqual({ page: null, selection: null });
  });

  it('returns the page id and title with a null selection by default', () => {
    expect(resolveCurrentPageResult({ id: 'p1', title: 'Hello' })).toEqual({
      page: { id: 'p1', title: 'Hello' },
      selection: null,
    });
  });

  it('passes the nested selection through verbatim', () => {
    const selection = {
      text: 'fix this',
      blockIds: ['b1'],
      before: 'please ',
      after: ' now',
    };
    expect(
      resolveCurrentPageResult({ id: 'p1', title: 'Hello', selection }),
    ).toEqual({
      page: { id: 'p1', title: 'Hello' },
      selection,
    });
  });

  it('defaults title to "" when it is missing', () => {
    expect(resolveCurrentPageResult({ id: 'p1' })).toEqual({
      page: { id: 'p1', title: '' },
      selection: null,
    });
  });

  it('keeps an explicit empty-string title as ""', () => {
    expect(resolveCurrentPageResult({ id: 'p1', title: '' })).toEqual({
      page: { id: 'p1', title: '' },
      selection: null,
    });
  });
});

/**
 * Unit tests for sanitizeSelection (#388). The selection is an attacker-
 * controllable client snapshot: every field is type-checked and capped, and
 * anything that is not a real selection collapses to null. It is NEVER verified
 * against the page content (decision 5 — a hint, not ground truth).
 */
describe('sanitizeSelection', () => {
  it('accepts a well-formed payload unchanged', () => {
    const raw = {
      text: 'the selected fragment',
      truncated: true,
      blockIds: ['b1', 'b2'],
      before: 'context before ',
      after: ' context after',
    };
    expect(sanitizeSelection(raw)).toEqual(raw);
  });

  it('returns null for non-objects', () => {
    expect(sanitizeSelection(null)).toBeNull();
    expect(sanitizeSelection(undefined)).toBeNull();
    expect(sanitizeSelection('text')).toBeNull();
    expect(sanitizeSelection(42)).toBeNull();
    expect(sanitizeSelection([])).toBeNull();
  });

  it('returns null when text is missing, non-string or blank-after-trim', () => {
    expect(sanitizeSelection({})).toBeNull();
    expect(sanitizeSelection({ text: 123 })).toBeNull();
    expect(sanitizeSelection({ text: '' })).toBeNull();
    expect(sanitizeSelection({ text: '   \n  ' })).toBeNull();
  });

  it('keeps only text when the other fields are garbage', () => {
    expect(
      sanitizeSelection({
        text: 'hello',
        truncated: 'yes',
        blockIds: 'nope',
        before: 5,
        after: {},
      }),
    ).toEqual({ text: 'hello' });
  });

  it('caps text at 4000 and forces truncated', () => {
    const raw = { text: 'a'.repeat(5000) };
    const out = sanitizeSelection(raw)!;
    expect(out.text).toHaveLength(4000);
    expect(out.truncated).toBe(true);
  });

  it('does not set truncated for text under the cap', () => {
    expect(sanitizeSelection({ text: 'short' })).toEqual({ text: 'short' });
  });

  it('slices blockIds to 20 and drops non-string / oversized ids', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
    const out = sanitizeSelection({
      text: 'x',
      blockIds: [...ids, 123, '', 'y'.repeat(65)],
    })!;
    // The 30 valid ids cap to the first 20; the number, empty string and the
    // 65-char id are dropped before the slice.
    expect(out.blockIds).toHaveLength(20);
    expect(out.blockIds).toEqual(ids.slice(0, 20));
  });

  it('keeps a 64-char id but drops a 65-char one (boundary)', () => {
    const ok = 'z'.repeat(64);
    const tooLong = 'z'.repeat(65);
    expect(
      sanitizeSelection({ text: 'x', blockIds: [ok, tooLong] })!.blockIds,
    ).toEqual([ok]);
  });

  it('omits blockIds entirely when none survive', () => {
    const out = sanitizeSelection({ text: 'x', blockIds: [123, ''] })!;
    expect(out.blockIds).toBeUndefined();
  });

  it('caps before/after at 200 chars and drops empty ones', () => {
    const out = sanitizeSelection({
      text: 'x',
      before: 'b'.repeat(300),
      after: '',
    })!;
    expect(out.before).toHaveLength(200);
    expect(out.after).toBeUndefined();
  });
});
