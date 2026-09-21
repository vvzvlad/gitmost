import { describe, expect, it } from 'vitest';
import { envInt } from './env-int.js';

// Unit coverage for the shared PROPERTY_SEED / PROPERTY_NUM_RUNS parser. The key
// contract is that an explicit "0" is honored (a valid fast-check seed) while
// empty/absent/non-numeric fall back to the default.
describe('envInt', () => {
  it('honors an explicit "0" (does not fall back)', () => {
    expect(envInt('0', 42)).toBe(0);
  });
  it('falls back on empty string', () => {
    expect(envInt('', 42)).toBe(42);
  });
  it('falls back on undefined', () => {
    expect(envInt(undefined, 42)).toBe(42);
  });
  it('falls back on a non-numeric string', () => {
    expect(envInt('abc', 42)).toBe(42);
  });
  it('parses a plain integer string', () => {
    expect(envInt('300', 42)).toBe(300);
  });
  it('parses a negative integer', () => {
    expect(envInt('-5', 42)).toBe(-5);
  });
  it('parses a large integer', () => {
    expect(envInt('1073741824', 42)).toBe(1073741824);
  });
});
