import { parseToolAllowlist, blankToNull } from './ai-mcp-server.repo';

/**
 * The `tool_allowlist` jsonb column historically round-trips as a JSON STRING
 * (rows written by the old double-encoding `jsonbArray`), so the driver hands
 * back `'["a","b"]'` instead of an array. `parseToolAllowlist` normalizes both
 * shapes to the `string[] | null` the entity type promises — fixing the settings
 * UI crash (TagsInput `.map` on a string) and the tool-allowlist enforcement
 * (which did `Array.isArray(allow)` and silently allowed ALL tools for a string).
 */
describe('parseToolAllowlist', () => {
  it('passes a real string array through unchanged', () => {
    expect(parseToolAllowlist(['search', 'crawl'])).toEqual([
      'search',
      'crawl',
    ]);
  });

  it('parses a JSON-string array (the double-encoded read) into an array', () => {
    // This is exactly what the DB returns for an old row: a jsonb string scalar.
    expect(parseToolAllowlist('["alpha","beta"]')).toEqual(['alpha', 'beta']);
  });

  it('returns null for null / undefined (unrestricted)', () => {
    expect(parseToolAllowlist(null)).toBeNull();
    expect(parseToolAllowlist(undefined)).toBeNull();
  });

  it('returns [] for an empty array (no items, but a present allowlist)', () => {
    expect(parseToolAllowlist([])).toEqual([]);
  });

  it('returns null for a JSON string that is not an array', () => {
    expect(parseToolAllowlist('"justastring"')).toBeNull();
    expect(parseToolAllowlist('{"a":1}')).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseToolAllowlist('not json at all')).toBeNull();
  });

  it('returns null when elements are not all strings (defensive)', () => {
    expect(parseToolAllowlist([1, 2, 3] as unknown)).toBeNull();
    expect(parseToolAllowlist('[1,2,3]')).toBeNull();
  });

  it('returns null for a non-string, non-array primitive', () => {
    expect(parseToolAllowlist(42 as unknown)).toBeNull();
    expect(parseToolAllowlist(true as unknown)).toBeNull();
  });
});

/**
 * `blankToNull` normalizes the per-server `instructions` free text before it is
 * stored (#180): a missing/blank/whitespace-only value becomes null (so an empty
 * guide is never persisted), any other value is trimmed.
 */
describe('blankToNull', () => {
  it('returns null for null / undefined', () => {
    expect(blankToNull(null)).toBeNull();
    expect(blankToNull(undefined)).toBeNull();
  });

  it('returns null for an empty / whitespace-only string', () => {
    expect(blankToNull('')).toBeNull();
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull('\n\t ')).toBeNull();
  });

  it('trims and returns a non-blank string', () => {
    expect(blankToNull('  use the search tool  ')).toBe('use the search tool');
    expect(blankToNull('guide')).toBe('guide');
  });
});
