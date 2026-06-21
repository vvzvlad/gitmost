import { resolveCurrentPageResult } from './current-page.util';

/**
 * Unit tests for resolveCurrentPageResult (pure function). Mirrors the
 * getCurrentPage tool's contract: { page: null } when no page is open (no id),
 * otherwise { page: { id, title } } with title defaulting to ''.
 */
describe('resolveCurrentPageResult', () => {
  it('returns { page: null } when openedPage is undefined', () => {
    expect(resolveCurrentPageResult(undefined)).toEqual({ page: null });
  });

  it('returns { page: null } when openedPage is null', () => {
    expect(resolveCurrentPageResult(null)).toEqual({ page: null });
  });

  it('returns { page: null } when openedPage has no id', () => {
    expect(resolveCurrentPageResult({})).toEqual({ page: null });
    expect(resolveCurrentPageResult({ title: 'x' })).toEqual({ page: null });
  });

  it('returns { page: null } when id is an empty string', () => {
    expect(resolveCurrentPageResult({ id: '' })).toEqual({ page: null });
  });

  it('returns the page id and title when both are present', () => {
    expect(resolveCurrentPageResult({ id: 'p1', title: 'Hello' })).toEqual({
      page: { id: 'p1', title: 'Hello' },
    });
  });

  it('defaults title to "" when it is missing', () => {
    expect(resolveCurrentPageResult({ id: 'p1' })).toEqual({
      page: { id: 'p1', title: '' },
    });
  });

  it('keeps an explicit empty-string title as ""', () => {
    expect(resolveCurrentPageResult({ id: 'p1', title: '' })).toEqual({
      page: { id: 'p1', title: '' },
    });
  });
});
