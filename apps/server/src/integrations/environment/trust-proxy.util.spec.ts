import { resolveTrustProxy } from './trust-proxy.util';

/**
 * Unit tests for resolveTrustProxy: the helper that turns the TRUST_PROXY env
 * string into a Fastify trustProxy value. The contract is: empty/undefined
 * falls back to the safe loopback/linklocal/uniquelocal default (so a public-IP
 * client cannot spoof X-Forwarded-For); 'true'/'false' become booleans; a
 * non-negative integer becomes a hop count (number); anything else (CIDR/IP
 * lists, negative numbers, named keywords) is passed through verbatim as a
 * trimmed string.
 */
describe('resolveTrustProxy', () => {
  const SAFE_DEFAULT = 'loopback, linklocal, uniquelocal';

  it('returns the safe default for an empty string', () => {
    expect(resolveTrustProxy('')).toBe(SAFE_DEFAULT);
  });

  it('returns the safe default for undefined', () => {
    expect(resolveTrustProxy(undefined)).toBe(SAFE_DEFAULT);
  });

  it("returns the boolean true for 'true'", () => {
    expect(resolveTrustProxy('true')).toBe(true);
  });

  it("returns the boolean false for 'false'", () => {
    expect(resolveTrustProxy('false')).toBe(false);
  });

  it("returns the number 2 for '2'", () => {
    expect(resolveTrustProxy('2')).toBe(2);
  });

  it("trims surrounding whitespace and returns the number 3 for '  3 '", () => {
    expect(resolveTrustProxy('  3 ')).toBe(3);
  });

  it('passes a CIDR string through unchanged', () => {
    expect(resolveTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it("passes a negative number through as a string ('-1' is not a valid hop count)", () => {
    expect(resolveTrustProxy('-1')).toBe('-1');
  });

  it('passes a non-numeric keyword through unchanged', () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
  });
});
