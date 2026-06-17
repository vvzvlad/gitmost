import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';
import * as ipaddr from 'ipaddr.js';

const dnsLookup = promisify(dnsLookupCb);

/**
 * SSRF protection for the admin-configured external MCP server URLs (§8.11/§14).
 *
 * An admin supplies the URL and the request is made from OUR backend, so a
 * malicious or compromised config could point at internal services or the cloud
 * metadata endpoint. We defend in two places:
 *  - at SAVE time: reject a config whose URL scheme is not http/https or whose
 *    host (or any resolved IP) lands in a blocked range;
 *  - right before EACH connect (and on every request via a guarded fetch in the
 *    client layer): re-resolve and re-check, which closes the DNS-rebinding hole
 *    where a name resolved fine at save time but now points at a private IP.
 *
 * IP ranges blocked (both IPv4 and IPv6, incl. IPv4-mapped IPv6):
 *  - loopback           127.0.0.0/8, ::1
 *  - link-local         169.254.0.0/16 (incl. metadata 169.254.169.254), fe80::/10
 *  - private            10/8, 172.16/12, 192.168/16
 *  - unique-local IPv6  fc00::/7 (ULA)
 *  - carrier-grade NAT  100.64.0.0/10
 *  - unspecified        0.0.0.0, ::
 *  - reserved/broadcast everything ipaddr.js flags as reserved/broadcast
 * Only `unicast` (public) addresses are allowed through.
 */

/** ipaddr.js range() labels we treat as routable/public and therefore allow. */
const ALLOWED_RANGES = new Set<string>(['unicast']);

export interface UrlCheckResult {
  ok: boolean;
  /** Short, non-sensitive reason; safe to surface to an admin. */
  reason?: string;
}

/** Classify a single resolved IP literal. Returns ok=false when blocked. */
export function isIpAllowed(ip: string): UrlCheckResult {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip); // process() unwraps IPv4-mapped IPv6 to IPv4
  } catch {
    return { ok: false, reason: 'unparseable IP address' };
  }
  const range = addr.range();
  if (!ALLOWED_RANGES.has(range)) {
    return { ok: false, reason: `blocked address range: ${range}` };
  }
  return { ok: true };
}

/**
 * Validate a URL string for use as an external MCP endpoint. Checks the scheme,
 * then resolves the hostname to ALL addresses (DNS) and blocks if ANY of them is
 * non-public. IP-literal hosts are checked directly (no DNS). Never throws — a
 * resolution failure is reported as a blocked result so the caller skips it.
 */
export async function isUrlAllowed(rawUrl: string): Promise<UrlCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http/https URLs are allowed' };
  }

  // Hostname may be a bracketed IPv6 literal ([::1]); strip the brackets.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host.length === 0) {
    return { ok: false, reason: 'missing host' };
  }

  // IP-literal host: check directly, no DNS.
  if (ipaddr.isValid(host)) {
    return isIpAllowed(host);
  }

  // Resolve the hostname to every address and block if ANY is non-public. This
  // is the DNS-rebinding defense at connect time (a name that pointed public at
  // save time may now resolve to a private IP).
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    // Unresolvable host: treat as blocked so the caller skips it cleanly.
    return { ok: false, reason: 'host could not be resolved' };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'host did not resolve to any address' };
  }
  for (const { address } of addresses) {
    const res = isIpAllowed(address);
    if (!res.ok) {
      // Do NOT echo the resolved IP — just the range class.
      return { ok: false, reason: res.reason };
    }
  }
  return { ok: true };
}
