import { jsonbBind } from './utils';

/**
 * Unit tests for jsonbBind: THE shared helper that encodes a JS array/object as
 * a jsonb bind (or null when there is nothing to persist). It is the last line
 * of defence before a jsonb column write, so the null-vs-bind decision is what
 * matters here. We assert only null vs non-null because the non-null value is a
 * kysely `sql` template fragment whose internal shape is an implementation
 * detail of the SQL tag (the `::text::jsonb` double-encoding fix is verified
 * end-to-end by the repo integration specs, where a real DB round-trip can
 * actually observe `jsonb_typeof`).
 */
describe('jsonbBind', () => {
  it('returns null for null / undefined', () => {
    expect(jsonbBind(null)).toBeNull();
    expect(jsonbBind(undefined)).toBeNull();
  });

  it('returns null for an empty array (nothing to persist)', () => {
    expect(jsonbBind([])).toBeNull();
  });

  it('returns null for an empty object (nothing to persist)', () => {
    expect(jsonbBind({})).toBeNull();
  });

  it('returns a (non-null) bind for a non-empty array', () => {
    const out = jsonbBind(['search', 'crawl']);
    expect(out).not.toBeNull();
    expect(out).toBeDefined();
  });

  it('returns a (non-null) bind for a non-empty object', () => {
    const out = jsonbBind({ driver: 'gemini', chatModel: 'gemini-2.0-flash' });
    expect(out).not.toBeNull();
    expect(out).toBeDefined();
  });

  // preserveEmpty (#476): opts a column OUT of the empty-to-null collapse so an
  // empty container is persisted verbatim (e.g. `[]` = deny-all for
  // tool_allowlist). null stays null regardless of the flag.
  describe('preserveEmpty', () => {
    it('returns a (non-null) bind for an empty array', () => {
      const out = jsonbBind([], { preserveEmpty: true });
      expect(out).not.toBeNull();
      expect(out).toBeDefined();
    });

    it('returns a (non-null) bind for an empty object', () => {
      const out = jsonbBind({}, { preserveEmpty: true });
      expect(out).not.toBeNull();
      expect(out).toBeDefined();
    });

    it('still returns null for null (null means null, flag or not)', () => {
      expect(jsonbBind(null, { preserveEmpty: true })).toBeNull();
    });
  });
});
