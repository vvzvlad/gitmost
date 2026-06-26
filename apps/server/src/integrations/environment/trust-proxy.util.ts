// Trust X-Forwarded-For ONLY from real proxies on private/loopback nets by
// default, so a public-IP client cannot spoof its IP via X-Forwarded-For.
// TRUST_PROXY env overrides: 'true'/'false', a hop count (integer), or a
// CIDR/IP list string passed through to Fastify/proxy-addr.
export function resolveTrustProxy(
  rawInput?: string,
): boolean | number | string {
  const raw = rawInput?.trim();
  if (raw == null || raw === '') return 'loopback, linklocal, uniquelocal';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : raw;
}
