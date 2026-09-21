import { isValidShareAlias, normalizeShareAlias } from './share-alias.util';

describe('normalizeShareAlias', () => {
  it('lowercases and trims', () => {
    expect(normalizeShareAlias('  HelloWorld  ')).toBe('helloworld');
  });

  it('converts spaces and underscores to single hyphens', () => {
    expect(normalizeShareAlias('my cool   page')).toBe('my-cool-page');
    expect(normalizeShareAlias('my_cool_page')).toBe('my-cool-page');
  });

  it('collapses repeated hyphens and trims edge hyphens', () => {
    expect(normalizeShareAlias('--a---b--')).toBe('a-b');
  });

  it('handles null/undefined defensively', () => {
    expect(normalizeShareAlias(undefined as unknown as string)).toBe('');
  });
});

describe('isValidShareAlias', () => {
  it('accepts ascii lowercase hyphen-separated slugs', () => {
    expect(isValidShareAlias('hello')).toBe(true);
    expect(isValidShareAlias('hello-world-2')).toBe(true);
    expect(isValidShareAlias('a1')).toBe(true);
  });

  it('rejects too short / too long', () => {
    expect(isValidShareAlias('a')).toBe(false);
    expect(isValidShareAlias('a'.repeat(61))).toBe(false);
    expect(isValidShareAlias('a'.repeat(60))).toBe(true);
  });

  it('rejects leading/trailing/double hyphens', () => {
    expect(isValidShareAlias('-abc')).toBe(false);
    expect(isValidShareAlias('abc-')).toBe(false);
    expect(isValidShareAlias('a--b')).toBe(false);
  });

  it('rejects uppercase, cyrillic and other non-ascii', () => {
    expect(isValidShareAlias('Hello')).toBe(false);
    expect(isValidShareAlias('привет')).toBe(false);
    expect(isValidShareAlias('a b')).toBe(false);
    expect(isValidShareAlias('a_b')).toBe(false);
    expect(isValidShareAlias('a.b')).toBe(false);
  });

  it('normalize + validate round-trips a messy input to a valid slug', () => {
    const alias = normalizeShareAlias('  My  Cool_Page!! ');
    // "!!" is not stripped by normalize (only case/separators), so the result
    // still fails validation — the charset gate is intentionally separate.
    expect(alias).toBe('my-cool-page!!');
    expect(isValidShareAlias(alias)).toBe(false);

    const ok = normalizeShareAlias('  My  Cool Page ');
    expect(ok).toBe('my-cool-page');
    expect(isValidShareAlias(ok)).toBe(true);
  });
});
