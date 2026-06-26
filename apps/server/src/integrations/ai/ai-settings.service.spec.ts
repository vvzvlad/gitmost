import { parsePositiveInt } from './ai-settings.service';

/**
 * Round-trip coercion for numeric `::text` provider settings (e.g.
 * chatContextWindow). Values are stored as text and read back as strings, so
 * this guards the read path the DTO write-validation does not cover: a silent
 * loss of `Math.floor` or a `> 0` → `>= 0` drift would otherwise go unnoticed.
 */
describe('parsePositiveInt', () => {
  it('keeps a valid positive integer string', () => {
    expect(parsePositiveInt('200000')).toBe(200000);
  });

  it('floors a fractional string', () => {
    expect(parsePositiveInt('1.9')).toBe(1);
    expect(parsePositiveInt('1.0')).toBe(1);
  });

  it('returns undefined for zero', () => {
    expect(parsePositiveInt('0')).toBeUndefined();
  });

  it('returns undefined for a negative value', () => {
    expect(parsePositiveInt('-5')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parsePositiveInt('')).toBeUndefined();
  });

  it('returns undefined for a non-numeric string', () => {
    expect(parsePositiveInt('abc')).toBeUndefined();
  });

  it('returns undefined for undefined / null', () => {
    expect(parsePositiveInt(undefined)).toBeUndefined();
    expect(parsePositiveInt(null)).toBeUndefined();
  });

  it('accepts a real number too (not only ::text strings)', () => {
    expect(parsePositiveInt(42)).toBe(42);
  });
});
