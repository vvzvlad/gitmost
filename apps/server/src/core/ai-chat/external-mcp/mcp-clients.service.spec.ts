import {
  McpClientsService,
  McpAuthUnreadableError,
} from './mcp-clients.service';

/**
 * Unit tests for the two security-critical surfaces of McpClientsService that the
 * sibling specs (ssrf-guard / validate-resolved-addresses / lease) do NOT cover:
 *
 *  1. `decryptHeaders` (private) — FAIL-CLOSED behavior (#686). A decrypt/parse
 *     failure of a PRESENT blob (e.g. APP_SECRET rotated, tampered blob) must
 *     NEVER return undefined (which would connect the server ANONYMOUSLY) and
 *     must NEVER log the blob: it throws McpAuthUnreadableError so buildEntry
 *     skips the server with a clear `auth-unreadable` outcome. A truly ABSENT
 *     blob still returns undefined (a legitimately anonymous server).
 *
 *  2. `this.guardedFetch` (private, bound to the SSRF-pinned dispatcher) — the
 *     per-request DNS-rebinding guard. A blocked host (private/loopback/metadata
 *     IP literal, or an unparseable URL) must REJECT before any socket is opened;
 *     a public host is allowed through to the real `fetch` with the pinned
 *     dispatcher attached.
 *
 * No network and no DB: the repo + secretBox deps are stubbed, and global `fetch`
 * is mocked for the single allow-path assertion.
 */

// Build the service with a SecretBoxService stub whose decryptSecret is supplied
// per-test. The repo dep is unused by the methods under test.
function buildService(decryptSecret: (blob: string) => string) {
  const secretBox = { decryptSecret: jest.fn(decryptSecret) };
  const service = new McpClientsService({} as never, secretBox as never);
  return { service, secretBox };
}

describe('McpClientsService.decryptHeaders', () => {
  // Reach the private method via the as-any pattern common in these NestJS specs.
  const callDecrypt = (
    service: McpClientsService,
    blob: string | null,
  ): Record<string, string> | undefined =>
    (
      service as unknown as {
        decryptHeaders: (b: string | null) => Record<string, string> | undefined;
      }
    ).decryptHeaders(blob);

  it('returns undefined for a null blob without decrypting', () => {
    const { service, secretBox } = buildService(() => '{}');
    expect(callDecrypt(service, null)).toBeUndefined();
    expect(secretBox.decryptSecret).not.toHaveBeenCalled();
  });

  it('decrypts a valid blob and keeps only string-valued headers', () => {
    const { service } = buildService(() =>
      JSON.stringify({
        Authorization: 'Bearer abc',
        'X-Api-Key': 'k',
        // Non-string values must be dropped, not coerced.
        count: 5,
        flag: true,
        nested: { a: 1 },
      }),
    );
    expect(callDecrypt(service, 'cipher')).toEqual({
      Authorization: 'Bearer abc',
      'X-Api-Key': 'k',
    });
  });

  it('returns undefined when the decrypted object has no string headers', () => {
    const { service } = buildService(() => JSON.stringify({ count: 5 }));
    // No usable headers -> undefined (connect with no auth header), not {}.
    expect(callDecrypt(service, 'cipher')).toBeUndefined();
  });

  // #686: fail-CLOSED. A PRESENT-but-undecryptable blob (e.g. APP_SECRET rotated)
  // must NOT return undefined (which would connect the server ANONYMOUSLY, silently
  // dropping its credentials). It throws McpAuthUnreadableError so buildEntry skips
  // the server with a clear `auth-unreadable` outcome. The blob is never in the
  // error, and decryptHeaders itself no longer warns (the WARN, carrying the
  // server/workspace ids, moved to the skip site in buildEntry).
  it('FAILS CLOSED: a decrypt error throws McpAuthUnreadableError (no anonymous connect)', () => {
    const { service } = buildService(() => {
      throw new Error('Failed to decrypt secret — APP_SECRET may have changed');
    });
    let thrown: unknown;
    try {
      callDecrypt(service, 'tampered-blob');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpAuthUnreadableError);
    // The blob is never carried on the error.
    expect(String((thrown as Error).message)).not.toContain('tampered-blob');
  });

  it('FAILS CLOSED: malformed JSON (decrypts to non-JSON) throws McpAuthUnreadableError', () => {
    const { service } = buildService(() => 'not-json{');
    expect(() => callDecrypt(service, 'cipher')).toThrow(McpAuthUnreadableError);
  });
});

describe('McpClientsService.guardedFetch (SSRF per-request guard)', () => {
  // The bound guardedFetch closure lives on the instance as a private field.
  // #489 split it into per-transport HTTP/SSE bindings (they differ only in the
  // dispatcher's bodyTimeout); the SSRF guard is identical, so testing the HTTP
  // one is sufficient.
  const guardedFetchOf = (service: McpClientsService) =>
    (service as unknown as { guardedFetchHttp: typeof fetch }).guardedFetchHttp;

  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    // Any reachable real fetch would be a network call; assert per-test that the
    // blocked paths never reach it, and stub a Response for the allow path.
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const blocked: Array<[string, string]> = [
    ['loopback IPv4', 'http://127.0.0.1/mcp'],
    ['private 10/8', 'http://10.0.0.5/mcp'],
    ['private 192.168/16', 'http://192.168.1.1/mcp'],
    ['cloud metadata link-local', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback IPv6 (bracketed)', 'http://[::1]:8080/mcp'],
  ];

  it.each(blocked)(
    'rejects a request to %s without opening a socket',
    async (_label, url) => {
      const { service } = buildService(() => '{}');
      await expect(guardedFetchOf(service)(url)).rejects.toThrow(
        /blocked request/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('rejects an unparseable URL as a blocked request', async () => {
    const { service } = buildService(() => '{}');
    await expect(
      guardedFetchOf(service)('::: not a url :::'),
    ).rejects.toThrow('blocked request: invalid URL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows a public IP literal and forwards through the pinned dispatcher', async () => {
    const { service } = buildService(() => '{}');
    const res = await guardedFetchOf(service)('http://8.8.8.8/mcp');

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The init MUST carry the SSRF-pinned undici dispatcher (the rebinding pin);
    // dropping it would let undici do a second, unchecked DNS resolution.
    const init = fetchSpy.mock.calls[0][1] as RequestInit & {
      dispatcher?: unknown;
    };
    expect(init.dispatcher).toBeDefined();
  });
});
