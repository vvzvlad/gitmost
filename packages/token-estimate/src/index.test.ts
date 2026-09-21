import { describe, it, expect } from 'vitest';
import { estimateTokens, CHARS_PER_TOKEN } from './index';

describe('estimateTokens (shared chars/2.5)', () => {
  it('returns 0 for empty / nullish input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('uses the chars/2.5 ratio, ceiled', () => {
    expect(CHARS_PER_TOKEN).toBe(2.5);
    // 5 chars / 2.5 = 2
    expect(estimateTokens('abcde')).toBe(2);
    // any non-empty string is at least 1 token (ceil)
    expect(estimateTokens('a')).toBe(1);
    // 100 chars / 2.5 = 40
    expect(estimateTokens('x'.repeat(100))).toBe(40);
  });

  it('counts Cyrillic ~2x higher than the old chars/4 rule (no undercount)', () => {
    const cyr = 'привет мир как дела'; // 19 chars
    expect(estimateTokens(cyr)).toBe(Math.ceil(19 / 2.5)); // 8
    expect(estimateTokens(cyr)).toBeGreaterThan(Math.ceil(19 / 4)); // > 5
  });

  it('is deterministic / byte-stable (same input => same output)', () => {
    const s = 'the quick brown fox';
    expect(estimateTokens(s)).toBe(estimateTokens(s));
  });
});
