import { parseModelConfig } from './ai-agent-roles.repo';

/**
 * Unit tests for parseModelConfig: the read-side normalizer that repairs the
 * jsonb double-encoding regression on `model_config`. Rows written by the old
 * `::jsonb` bind round-trip as a JSON STRING, which the read path's
 * `typeof === 'object'` check rejected — silently dropping the model override.
 * parseModelConfig accepts an already-parsed object, parses a legacy JSON
 * string, and rejects everything that is not an object (null = no override).
 */
describe('parseModelConfig', () => {
  it('passes an already-parsed object through', () => {
    expect(parseModelConfig({ driver: 'gemini' })).toEqual({
      driver: 'gemini',
    });
  });

  it('parses a legacy double-encoded JSON string into an object', () => {
    expect(parseModelConfig('{"driver":"gemini","chatModel":"x"}')).toEqual({
      driver: 'gemini',
      chatModel: 'x',
    });
  });

  it('returns null for null / undefined', () => {
    expect(parseModelConfig(null)).toBeNull();
    expect(parseModelConfig(undefined)).toBeNull();
  });

  it('returns null for a non-object JSON value (string/number/array)', () => {
    expect(parseModelConfig('"justastring"')).toBeNull();
    expect(parseModelConfig('42')).toBeNull();
    // An array is an object in JS but not a valid model_config shape.
    expect(parseModelConfig('["a","b"]')).toBeNull();
    expect(parseModelConfig(['a', 'b'])).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseModelConfig('not json at all')).toBeNull();
  });

  it('returns null for a raw non-object primitive', () => {
    expect(parseModelConfig(42 as unknown)).toBeNull();
    expect(parseModelConfig(true as unknown)).toBeNull();
  });
});
