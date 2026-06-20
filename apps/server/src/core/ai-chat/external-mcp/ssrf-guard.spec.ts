/**
 * Unit tests for the SSRF guard protecting admin-configured external MCP URLs.
 *
 * `isIpAllowed` is pure/sync: every blocked address class must be rejected and a
 * public address allowed. `isUrlAllowed` adds scheme/URL validation and, for
 * hostnames, a DNS resolve + re-check (the DNS-rebinding defense): a name that
 * resolves to a private address must be blocked. We mock `node:dns` `lookup`
 * (the guard promisifies it) so the rebinding case is deterministic and offline.
 */

// Mock node:dns BEFORE importing the guard so promisify(lookup) wraps our mock.
const lookupMock = jest.fn();
jest.mock('node:dns', () => ({
  __esModule: true,
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { isIpAllowed, isUrlAllowed } from './ssrf-guard';

// The guard calls promisify(lookup): our mock must honour the (host, opts, cb)
// callback signature. Helper to make it resolve to a given address list.
function dnsResolvesTo(addresses: { address: string }[]) {
  lookupMock.mockImplementation(
    (_host: string, _opts: unknown, cb: (e: unknown, a: unknown) => void) => {
      cb(null, addresses);
    },
  );
}

describe('isIpAllowed', () => {
  const blocked: Array<[string, string]> = [
    ['loopback IPv4', '127.0.0.1'],
    ['loopback IPv6', '::1'],
    ['link-local / metadata', '169.254.169.254'],
    ['private 10/8', '10.0.0.1'],
    ['private 172.16/12', '172.16.5.4'],
    ['private 192.168/16', '192.168.1.1'],
    ['CGNAT 100.64/10', '100.64.1.1'],
    ['ULA fc00::/7', 'fc00::1'],
    ['unspecified IPv4', '0.0.0.0'],
    ['unspecified IPv6', '::'],
    ['IPv4-mapped IPv6 (private)', '::ffff:10.0.0.1'],
  ];

  it.each(blocked)('blocks %s (%s)', (_label, ip) => {
    expect(isIpAllowed(ip).ok).toBe(false);
  });

  it('allows a public IPv4 (8.8.8.8)', () => {
    expect(isIpAllowed('8.8.8.8').ok).toBe(true);
  });

  it('allows a public IPv6', () => {
    expect(isIpAllowed('2001:4860:4860::8888').ok).toBe(true);
  });

  it('blocks an unparseable IP', () => {
    expect(isIpAllowed('not-an-ip').ok).toBe(false);
  });
});

describe('isUrlAllowed', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('blocks a non-http(s) scheme', async () => {
    const res = await isUrlAllowed('ftp://example.com/');
    expect(res.ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks an invalid URL', async () => {
    const res = await isUrlAllowed('::: not a url :::');
    expect(res.ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks a private IP literal host without DNS', async () => {
    const res = await isUrlAllowed('http://169.254.169.254/latest/meta-data/');
    expect(res.ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks a bracketed private IPv6 literal host', async () => {
    const res = await isUrlAllowed('http://[::1]:8080/');
    expect(res.ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks a hostname that resolves to a private address (DNS rebinding)', async () => {
    dnsResolvesTo([{ address: '10.0.0.5' }]);
    const res = await isUrlAllowed('http://rebind.example.com/');
    expect(res.ok).toBe(false);
    expect(lookupMock).toHaveBeenCalled();
  });

  it('blocks when ANY resolved address is private (mixed result)', async () => {
    dnsResolvesTo([{ address: '8.8.8.8' }, { address: '127.0.0.1' }]);
    const res = await isUrlAllowed('http://mixed.example.com/');
    expect(res.ok).toBe(false);
  });

  it('allows a hostname that resolves only to a public address', async () => {
    dnsResolvesTo([{ address: '8.8.8.8' }]);
    const res = await isUrlAllowed('https://public.example.com/mcp');
    expect(res.ok).toBe(true);
  });

  it('blocks when the host does not resolve', async () => {
    lookupMock.mockImplementation(
      (_host: string, _opts: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(new Error('ENOTFOUND'), undefined);
      },
    );
    const res = await isUrlAllowed('http://nonexistent.invalid/');
    expect(res.ok).toBe(false);
  });
});
