import { type LookupAddress } from 'node:dns';
import { validateResolvedAddresses } from './mcp-clients.service';

/**
 * Unit tests for validateResolvedAddresses — the connect-time half of the SSRF
 * DNS-rebinding defense. It applies the REAL `isIpAllowed` rule (imported
 * transitively via the service) and must block if ANY resolved address is
 * disallowed, treat an EMPTY set as blocked, and unwrap IPv4-mapped IPv6.
 *
 * These tests intentionally use real public/private literals (no DNS, no mock)
 * so they exercise the actual ssrf-guard classification.
 */
function addr(address: string, family = 4): LookupAddress {
  return { address, family };
}

describe('validateResolvedAddresses', () => {
  it('allows an all-public set', () => {
    const res = validateResolvedAddresses([
      addr('8.8.8.8'),
      addr('1.1.1.1'),
      addr('2001:4860:4860::8888', 6),
    ]);
    expect(res.ok).toBe(true);
  });

  it('blocks when ONE address among many is private (any-private-blocks)', () => {
    const res = validateResolvedAddresses([
      addr('8.8.8.8'),
      addr('1.1.1.1'),
      addr('10.0.0.5'), // private 10/8 hidden among public addresses
      addr('1.0.0.1'),
    ]);
    expect(res.ok).toBe(false);
    expect(res.blockedHost).toBe('10.0.0.5');
  });

  it('blocks an empty set (nothing safe to connect to)', () => {
    expect(validateResolvedAddresses([]).ok).toBe(false);
  });

  it('blocks an IPv4-mapped IPv6 private address', () => {
    const res = validateResolvedAddresses([addr('::ffff:10.0.0.1', 6)]);
    expect(res.ok).toBe(false);
  });

  it('blocks the cloud metadata link-local address', () => {
    const res = validateResolvedAddresses([
      addr('8.8.8.8'),
      addr('169.254.169.254'),
    ]);
    expect(res.ok).toBe(false);
  });

  /**
   * Regression sentinel: if the "any private blocks" rule were weakened to
   * "all private blocks" / "first address wins", this mixed set (public first,
   * private second) would wrongly pass. The assertion below FAILS in that case.
   */
  it('FAILS if the any-private rule is weakened (sentinel)', () => {
    const res = validateResolvedAddresses([
      addr('8.8.8.8'), // public first
      addr('192.168.1.1'), // private second — must still block the whole set
    ]);
    expect(res.ok).toBe(false);
  });
});
