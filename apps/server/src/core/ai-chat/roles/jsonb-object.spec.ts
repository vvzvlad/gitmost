import { jsonbObject } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';

/**
 * Unit tests for jsonbObject: the repo helper that encodes a model_config object
 * as a jsonb bind (or null when there is nothing to persist). It is the last
 * line of defence before the column write, so the null-vs-bind decision is what
 * matters here. We assert only null vs non-null because the non-null value is a
 * kysely `sql` template fragment whose internal shape is an implementation
 * detail of the SQL tag.
 */
describe('jsonbObject', () => {
  it('returns null for null', () => {
    expect(jsonbObject(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(jsonbObject(undefined)).toBeNull();
  });

  it('returns null for an empty object (nothing to persist)', () => {
    expect(jsonbObject({})).toBeNull();
  });

  it('returns a (non-null) jsonb bind for a non-empty object', () => {
    const out = jsonbObject({ driver: 'gemini', chatModel: 'gemini-2.0-flash' });
    // A real sql fragment is produced, never null/undefined.
    expect(out).not.toBeNull();
    expect(out).toBeDefined();
  });
});
