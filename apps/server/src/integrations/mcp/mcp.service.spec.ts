import { UnauthorizedException } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  resolveMcpSessionConfig,
  verifyMcpBearer,
  bindMcpBearerVerifier,
  sharedTokenMatches,
  extractBearer,
  mapAuthResultToResponse,
  isCredentialHeaderPresent,
  McpAuthDeps,
  MCP_WWW_AUTHENTICATE,
  MCP_WWW_AUTHENTICATE_SHARED_TOKEN,
  MCP_CHALLENGE_BEARER_DESCRIPTION,
  MCP_CHALLENGE_SHARED_TOKEN_DESCRIPTION,
} from './mcp-auth.helpers';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { McpService, routeMcpMetric } from './mcp.service';

// The prom instruments are mocked so the metric ROUTING can be asserted directly:
// the real registry is a disabled no-op under jest (no METRICS_PORT), which would
// make any assertion against it vacuous. McpService's own tests below never touch
// metrics, so the mock is inert for them.
jest.mock('../metrics/metrics.registry', () => ({
  isMetricsEnabled: jest.fn(() => false),
  observeMcpTool: jest.fn(),
  incConnectTimeout: jest.fn(),
  incGetPageCacheHit: jest.fn(),
  incGetPageCacheMiss: jest.fn(),
  addMcpDownloadBytes: jest.fn(),
  incMcpRyowLive: jest.fn(),
  incMcpRyowDbrow: jest.fn(),
  incMcpRyowExpired: jest.fn(),
}));
import * as metrics from '../metrics/metrics.registry';

// The /mcp per-request auth decision logic is tested through the framework-free
// `resolveMcpSessionConfig` helper that McpService delegates to. McpService
// itself cannot be instantiated under jest because importing the heavy auth
// graph drags in the React email templates + queue constants graph; extracting
// the pure logic (and wiring it in) keeps it both tested AND used.
//
// /mcp accepts EXACTLY ONE credential: a Bearer api_key JWT. There is no HTTP
// Basic email:password, no human ACCESS session token, and no env service
// account — everything else is a 401.

function basicHeader(email: string, password: string): string {
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

function makeDeps(over: Partial<McpAuthDeps> = {}): McpAuthDeps {
  return {
    apiUrl: 'http://127.0.0.1:3000/api',
    findWorkspace:
      over.findWorkspace ?? jest.fn().mockResolvedValue({ id: 'ws-1' }),
    // Default: a valid api_key verification returning a principal.
    verifyAccessJwt:
      over.verifyAccessJwt ??
      jest.fn().mockResolvedValue({ sub: 'svc-1', email: 'svc@e.com' }),
  };
}

describe('extractBearer', () => {
  it('extracts the token from a "Bearer <token>" header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme (lowercase + uppercase)', () => {
    // The split keeps the token as-is; only the scheme is compared lowercased.
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('BEARER abc')).toBe('abc');
  });

  it('returns undefined for a non-Bearer scheme (e.g. Basic)', () => {
    expect(extractBearer('Basic abc')).toBeUndefined();
  });

  it('returns undefined for an undefined header', () => {
    expect(extractBearer(undefined)).toBeUndefined();
  });
});

// #636 — the input to the RFC 6750 §3.1 decision ("did the request carry ANY
// authentication information?"). It has to be right about every shape Node can hand
// a header value in, because a wrong reading here puts (or omits) an
// `error="invalid_token"` on a challenge about a credential that was never sent.
describe('isCredentialHeaderPresent', () => {
  it('a non-empty string is a presented credential', () => {
    expect(isCredentialHeaderPresent('Bearer abc')).toBe(true);
    expect(isCredentialHeaderPresent('shared-secret')).toBe(true);
  });

  it('an absent header is not', () => {
    expect(isCredentialHeaderPresent(undefined)).toBe(false);
  });

  it.each(['', ' ', '\t', '  \n '])(
    'a present-but-empty header (%j) carries NO authentication information',
    (value) => {
      // `Authorization:` with no value is a legal request and Node reports it as
      // ''. RFC 6750 §3.1 asks whether the request "lacks ANY authentication
      // information" — an empty value carries none, so it is not a bad token.
      expect(isCredentialHeaderPresent(value)).toBe(false);
    },
  );

  it('a string[] (a duplicated header) with a real value counts as presented', () => {
    // Node joins most duplicate headers into one comma-separated string, but not
    // all of them — an array is a shape that really reaches us, and reading it as
    // "absent" would deny the credential the client actually sent twice.
    expect(isCredentialHeaderPresent(['tok-a', 'tok-b'])).toBe(true);
    expect(isCredentialHeaderPresent([''])).toBe(false);
    expect(isCredentialHeaderPresent([])).toBe(false);
  });

  it('a non-string, non-array value is not a credential', () => {
    expect(isCredentialHeaderPresent(null)).toBe(false);
    expect(isCredentialHeaderPresent(42)).toBe(false);
    expect(isCredentialHeaderPresent({})).toBe(false);
  });
});

describe('resolveMcpSessionConfig (Bearer api_key ONLY)', () => {
  it('valid api_key Bearer -> verifies and returns a getToken config', async () => {
    const verifyAccessJwt = jest
      .fn()
      .mockResolvedValue({ sub: 'svc-9', email: 'svc@e.com' });
    const resolved = await resolveMcpSessionConfig(
      'Bearer some.api.key',
      makeDeps({ verifyAccessJwt }),
    );
    expect(verifyAccessJwt).toHaveBeenCalledWith('some.api.key');
    const cfg = resolved.config as { getToken: () => Promise<string> };
    await expect(cfg.getToken()).resolves.toBe('some.api.key');
    expect(resolved.identity).toBe('bearer:svc-9');
  });

  it('HTTP Basic email:password -> 401 (api_key only), verify NOT called', async () => {
    const verifyAccessJwt = jest.fn();
    await expect(
      resolveMcpSessionConfig(
        basicHeader('user@example.com', 'pw'),
        makeDeps({ verifyAccessJwt }),
      ),
    ).rejects.toThrow(/Bearer api_key/);
    // A Basic header is not a Bearer token, so the verifier is never consulted.
    expect(verifyAccessJwt).not.toHaveBeenCalled();
  });

  it('a Bearer token the {API_KEY} allowlist refuses (e.g. an ACCESS session JWT) -> generic 401', async () => {
    // In production verifyAccessJwt is verifyMcpBearer, whose bound verifier pins
    // the allowlist to {API_KEY}; a human ACCESS-session token is rejected there
    // with an UnauthorizedException. resolveMcpSessionConfig must surface the
    // UNIFORM generic 401 (anti-enumeration), not the specific reason.
    const verifyAccessJwt = jest
      .fn()
      .mockRejectedValue(new UnauthorizedException('invalid token type'));
    await expect(
      resolveMcpSessionConfig(
        'Bearer human.access.jwt',
        makeDeps({ verifyAccessJwt }),
      ),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('no Authorization header -> 401, EVEN when MCP_DOCMOST_EMAIL/PASSWORD are set (no service-account fallback)', async () => {
    // Prove there is no env service-account fallback: with the old service-account
    // vars set, a credential-less request STILL 401s. The helper never reads env.
    const prevEmail = process.env.MCP_DOCMOST_EMAIL;
    const prevPassword = process.env.MCP_DOCMOST_PASSWORD;
    process.env.MCP_DOCMOST_EMAIL = 'svc@example.com';
    process.env.MCP_DOCMOST_PASSWORD = 'svcpw';
    try {
      const verifyAccessJwt = jest.fn();
      await expect(
        resolveMcpSessionConfig(undefined, makeDeps({ verifyAccessJwt })),
      ).rejects.toThrow(/Bearer api_key/);
      expect(verifyAccessJwt).not.toHaveBeenCalled();
    } finally {
      if (prevEmail === undefined) delete process.env.MCP_DOCMOST_EMAIL;
      else process.env.MCP_DOCMOST_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.MCP_DOCMOST_PASSWORD;
      else process.env.MCP_DOCMOST_PASSWORD = prevPassword;
    }
  });

  it('Bearer INFRA error -> propagates (NOT masked as 401)', async () => {
    // A non-UnauthorizedException (e.g. a DB outage in the api-key row-check) is
    // not an auth verdict: it must propagate so the surface maps it to 5xx.
    const verifyAccessJwt = jest
      .fn()
      .mockRejectedValue(new Error('connection terminated'));
    await expect(
      resolveMcpSessionConfig('Bearer x', makeDeps({ verifyAccessJwt })),
    ).rejects.toThrow('connection terminated');
  });

  it('different keys yield different identity keys (anti-fixation)', async () => {
    const a = await resolveMcpSessionConfig(
      'Bearer key-a',
      makeDeps({
        verifyAccessJwt: jest.fn().mockResolvedValue({ sub: 'svc-a' }),
      }),
    );
    const b = await resolveMcpSessionConfig(
      'Bearer key-b',
      makeDeps({
        verifyAccessJwt: jest.fn().mockResolvedValue({ sub: 'svc-b' }),
      }),
    );
    expect(a.identity).toBe('bearer:svc-a');
    expect(b.identity).toBe('bearer:svc-b');
    expect(a.identity).not.toBe(b.identity);
  });
});

describe('sharedTokenMatches (X-MCP-Token constant-time guard)', () => {
  it('equal token -> true', () => {
    expect(sharedTokenMatches('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('wrong token of the SAME length -> false (timingSafeEqual path)', () => {
    // Same length so it reaches timingSafeEqual; the bytes differ -> no match.
    expect(sharedTokenMatches('aaaaaa', 'aaaaab')).toBe(false);
  });

  it('different-length token -> false WITHOUT throwing (early-return before timingSafeEqual)', () => {
    // timingSafeEqual throws on unequal-length buffers; the early length check
    // must short-circuit so a length mismatch is a clean non-match, not a throw.
    expect(() => sharedTokenMatches('expected', 'short')).not.toThrow();
    expect(sharedTokenMatches('expected', 'short')).toBe(false);
    expect(sharedTokenMatches('expected', 'a-much-longer-provided-value')).toBe(
      false,
    );
  });

  it('array-valued header -> uses the FIRST element', () => {
    // Multiple X-MCP-Token headers arrive as string[]; only the first is used.
    expect(sharedTokenMatches('tok', ['tok', 'ignored'])).toBe(true);
    expect(sharedTokenMatches('tok', ['wrong', 'tok'])).toBe(false);
  });

  it('undefined / non-string provided -> false', () => {
    expect(sharedTokenMatches('tok', undefined)).toBe(false);
    // An empty array yields provided[0] === undefined -> non-string -> false.
    expect(sharedTokenMatches('tok', [])).toBe(false);
    expect(sharedTokenMatches('tok', [undefined as unknown as string])).toBe(
      false,
    );
  });
});

describe('bindMcpBearerVerifier pins the {API_KEY} allowlist (#558)', () => {
  it('calls verifyJwtOneOf with exactly [API_KEY]', async () => {
    const verifyJwtOneOf = jest
      .fn()
      .mockResolvedValue({ type: JwtType.API_KEY, sub: 'u-1' });
    await bindMcpBearerVerifier({ verifyJwtOneOf })('the.jwt');
    expect(verifyJwtOneOf).toHaveBeenCalledWith('the.jwt', [JwtType.API_KEY]);
    // Pin the concrete enum value too — an ACCESS token is NOT accepted.
    expect(verifyJwtOneOf.mock.calls[0][1]).toEqual(['api_key']);
    expect(verifyJwtOneOf.mock.calls[0][1]).not.toContain('access');
  });
});

describe('verifyMcpBearer (API_KEY only)', () => {
  const apiKeyDeps = (over: any = {}) => ({
    verifyJwtOneOf: jest.fn(),
    expectedWorkspaceId: 'ws-1',
    validateApiKey: jest.fn(),
    ...over,
  });

  it('API_KEY -> row-checks via validateApiKey and returns the principal', async () => {
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.API_KEY,
        sub: 'svc-1',
        workspaceId: 'ws-1',
        apiKeyId: 'k-1',
      }),
      validateApiKey: jest.fn().mockResolvedValue({ user: { id: 'svc-1' } }),
    });
    const res = await verifyMcpBearer('tok', deps);
    expect(deps.validateApiKey).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ sub: 'svc-1' });
  });

  it('API_KEY for ANOTHER workspace -> rejected before the row-check', async () => {
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.API_KEY,
        sub: 'svc-1',
        workspaceId: 'ws-OTHER',
        apiKeyId: 'k-1',
      }),
      validateApiKey: jest.fn(),
    });
    await expect(verifyMcpBearer('tok', deps)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(deps.validateApiKey).not.toHaveBeenCalled();
  });

  it('API_KEY infra error from validateApiKey PROPAGATES (not masked)', async () => {
    const boom = new Error('db down');
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.API_KEY,
        sub: 'svc-1',
        workspaceId: 'ws-1',
        apiKeyId: 'k-1',
      }),
      validateApiKey: jest.fn().mockRejectedValue(boom),
    });
    await expect(verifyMcpBearer('tok', deps)).rejects.toBe(boom);
  });

  it('a non-API_KEY payload (defence in depth) -> 401 without touching validateApiKey', async () => {
    // The allowlist already pins the type to API_KEY, so verifyJwtOneOf would
    // reject an ACCESS token first; if a non-API_KEY payload ever reached here,
    // verifyMcpBearer must still deny it uniformly and never row-check it.
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.ACCESS,
        sub: 'u-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
      }),
    });
    await expect(verifyMcpBearer('tok', deps)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(deps.validateApiKey).not.toHaveBeenCalled();
  });

  it('verifies the signature exactly ONCE (single verifyJwtOneOf)', async () => {
    const verifyJwtOneOf = jest.fn().mockResolvedValue({
      type: JwtType.API_KEY,
      sub: 'svc-1',
      workspaceId: 'ws-1',
      apiKeyId: 'k-1',
    });
    await verifyMcpBearer('tok', apiKeyDeps({ verifyJwtOneOf }));
    expect(verifyJwtOneOf).toHaveBeenCalledTimes(1);
  });
});

describe('mapAuthResultToResponse (handle status/body mapping)', () => {
  // The pure response decision extracted out of McpService.handle. It maps the
  // pre-hijack gauntlet (shared token, enablement, auth error) to either a fixed
  // JSON error response or the hijack path — never leaking the token/header.

  it('wrong X-MCP-Token -> 401 {error:"Unauthorized"} and NOT the hijack path', () => {
    const d = mapAuthResultToResponse({
      sharedTokenOk: false,
      enabled: true,
      sharedTokenPresented: true,
      bearerPresented: true,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Unauthorized' },
      headers: { 'WWW-Authenticate': MCP_WWW_AUTHENTICATE_SHARED_TOKEN },
    });
  });

  it('workspace MCP disabled -> 403 with NO WWW-Authenticate (not an auth challenge)', () => {
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: false,
      sharedTokenPresented: true,
      bearerPresented: true,
    });
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.status).toBe(403);
      expect(d.body).toEqual({ error: 'MCP is disabled for this workspace' });
      // #636 explicitly leaves the 403 (MCP disabled) path untouched: no
      // credential would help, so it carries no challenge.
      expect(d.headers).toBeUndefined();
    }
  });

  it('an UnauthorizedException -> 401 with err.message; no token/header leaked', () => {
    // Construct an UnauthorizedException whose message is the SPECIFIC auth reason.
    const err = new UnauthorizedException('Invalid or expired token');
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: true,
      error: err,
      sharedTokenPresented: true,
      bearerPresented: true,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Invalid or expired token' },
      headers: { 'WWW-Authenticate': MCP_WWW_AUTHENTICATE },
    });
    // The surfaced body is ONLY the exception message — never the raw secret.
    if (d.kind === 'respond') {
      const serialized = JSON.stringify(d.body);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Bearer ');
    }
  });

  it('a non-Unauthorized error -> 500 generic (no error detail surfaced)', () => {
    const err = new Error('db blew up: connection string secret');
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: true,
      error: err,
      sharedTokenPresented: true,
      bearerPresented: true,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 500,
      body: { error: 'Internal server error' },
    });
    // The generic body must NOT echo the underlying error message.
    if (d.kind === 'respond') {
      expect(d.body.error).not.toContain('secret');
    }
  });

  it('happy path (auth resolved, no error) -> hijack', () => {
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: true,
      sharedTokenPresented: true,
      bearerPresented: true,
    });
    expect(d).toEqual({ kind: 'hijack' });
  });

  it('shared-token failure takes precedence over disabled/error', () => {
    // Even with a disabled workspace and an error, a bad shared token is the
    // first gate, so the response is the uniform 401 Unauthorized.
    const d = mapAuthResultToResponse({
      sharedTokenOk: false,
      enabled: false,
      error: new UnauthorizedException('should not surface'),
      sharedTokenPresented: true,
      bearerPresented: true,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Unauthorized' },
      headers: { 'WWW-Authenticate': MCP_WWW_AUTHENTICATE_SHARED_TOKEN },
    });
  });

  // #636 — the 401 must state the credential /mcp ACTUALLY wants (RFC 6750 §3) and
  // must NOT advertise an OAuth authorization server we do not have.
  describe('WWW-Authenticate challenge on 401 (#636)', () => {
    const four01s = [
      [
        'shared-token mismatch',
        {
          sharedTokenOk: false,
          enabled: true,
          sharedTokenPresented: true,
          bearerPresented: true,
        },
        MCP_WWW_AUTHENTICATE_SHARED_TOKEN,
      ],
      [
        'bad/missing api_key',
        {
          sharedTokenOk: true,
          enabled: true,
          error: new UnauthorizedException(
            MCP_CHALLENGE_BEARER_DESCRIPTION,
          ) as unknown,
          sharedTokenPresented: true,
          bearerPresented: true,
        },
        MCP_WWW_AUTHENTICATE,
      ],
    ] as const;

    it.each(four01s)(
      'the 401 branch (%s) carries a Bearer challenge naming the credential it wants',
      (_name, input, expected) => {
        const d = mapAuthResultToResponse(input);
        expect(d.kind).toBe('respond');
        if (d.kind !== 'respond') return;
        expect(d.status).toBe(401);
        const challenge = d.headers?.['WWW-Authenticate'];
        expect(challenge).toBe(expected);
        expect(challenge).toContain('Bearer');
        expect(challenge).toContain('error="invalid_token"');
        expect(challenge).toContain('api_key');
      },
    );

    // The bug this finding is about: when MCP_TOKEN is set and the client omits (or
    // mis-sends) X-MCP-Token, a challenge that names ONLY the Bearer api_key sends
    // the client into an endless loop — it adds `Authorization: Bearer <api_key>`,
    // still misses the shared header, and 401s forever. The challenge MUST name the
    // header it is actually missing.
    it('the shared-token 401 names X-MCP-Token (not just the Bearer api_key)', () => {
      const d = mapAuthResultToResponse({
        sharedTokenOk: false,
        enabled: true,
        sharedTokenPresented: true,
        bearerPresented: true,
      });
      expect(d.kind).toBe('respond');
      if (d.kind !== 'respond') return;
      const challenge = d.headers?.['WWW-Authenticate'];
      expect(challenge).toContain('X-MCP-Token');
      // It still names the api_key too — BOTH credentials are required here.
      expect(challenge).toContain('Authorization: Bearer <api_key>');
      // And it is NOT the api_key-only challenge, which would be the bug.
      expect(challenge).not.toBe(MCP_WWW_AUTHENTICATE);
    });

    // RFC 6750 §3.1: "If the request lacks any authentication information ... the
    // resource server SHOULD NOT include an error code." `error="invalid_token"`
    // means "you sent a token and it was bad" — a lie for `claude mcp add` with no
    // --header, and it sends the user hunting a token they never sent.
    it.each([
      [
        'no credential at all -> NO error code',
        {
          sharedTokenOk: true,
          enabled: true,
          sharedTokenPresented: false,
          bearerPresented: false,
        },
        false,
      ],
      [
        'a credential was presented and rejected -> error="invalid_token"',
        {
          sharedTokenOk: true,
          enabled: true,
          sharedTokenPresented: true,
          bearerPresented: true,
        },
        true,
      ],
    ] as const)('%s', (_name, base, expectErrorCode) => {
      const d = mapAuthResultToResponse({
        ...base,
        error: new UnauthorizedException(MCP_CHALLENGE_BEARER_DESCRIPTION),
      });
      expect(d.kind).toBe('respond');
      if (d.kind !== 'respond') return;
      const challenge = d.headers?.['WWW-Authenticate'] ?? '';
      expect(challenge).toContain('Bearer realm="mcp"');
      // The description (what the client must actually DO) is always there.
      expect(challenge).toContain(MCP_CHALLENGE_BEARER_DESCRIPTION);
      if (expectErrorCode) {
        expect(challenge).toContain('error="invalid_token"');
      } else {
        expect(challenge).not.toContain('error="invalid_token"');
        expect(challenge).not.toContain('error=');
      }
    });

    it('the same §3.1 rule holds for the shared-token branch', () => {
      const d = mapAuthResultToResponse({
        sharedTokenOk: false,
        enabled: true,
        sharedTokenPresented: false,
        bearerPresented: false,
      });
      expect(d.kind).toBe('respond');
      if (d.kind !== 'respond') return;
      const challenge = d.headers?.['WWW-Authenticate'] ?? '';
      expect(challenge).not.toContain('error=');
      expect(challenge).toContain('X-MCP-Token');
    });

    // The §3.1 signal is PER BRANCH: the two 401s challenge two DIFFERENT
    // credentials, so "did the client present one?" has two different answers. One
    // shared flag would resurrect #636's own bug in miniature — an error code about
    // a credential that was never presented.
    describe('the error code is read per credential, not "any credential" (#636)', () => {
      it('the shared-token 401 stays code-free when the client sent ONLY the api_key', () => {
        // The deployment sets MCP_TOKEN. The client did exactly what the api_key
        // challenge told it to — `Authorization: Bearer <api_key>` and nothing else.
        // It never presented an X-MCP-Token, and THIS challenge is about X-MCP-Token,
        // so calling it an `invalid_token` would name a credential it never sent.
        const d = mapAuthResultToResponse({
          sharedTokenOk: false,
          enabled: true,
          sharedTokenPresented: false,
          bearerPresented: true,
        });
        expect(d.kind).toBe('respond');
        if (d.kind !== 'respond') return;
        const challenge = d.headers?.['WWW-Authenticate'] ?? '';
        expect(challenge).not.toContain('error=');
        // It still TELLS the client what to send — that is the whole point.
        expect(challenge).toContain('X-MCP-Token');
        expect(challenge).toContain(MCP_CHALLENGE_SHARED_TOKEN_DESCRIPTION);
      });

      it('the api_key 401 stays code-free when the client sent ONLY X-MCP-Token', () => {
        // The mirror case: no Authorization header at all, so the Bearer challenge
        // must not claim the api_key it never got was invalid.
        const d = mapAuthResultToResponse({
          sharedTokenOk: true,
          enabled: true,
          error: new UnauthorizedException(MCP_CHALLENGE_BEARER_DESCRIPTION),
          sharedTokenPresented: true,
          bearerPresented: false,
        });
        expect(d.kind).toBe('respond');
        if (d.kind !== 'respond') return;
        const challenge = d.headers?.['WWW-Authenticate'] ?? '';
        expect(challenge).not.toContain('error=');
        expect(challenge).toContain(MCP_CHALLENGE_BEARER_DESCRIPTION);
      });

      it('each branch still emits the code for ITS OWN rejected credential', () => {
        // X-MCP-Token WAS sent (and mismatched) while Authorization was not: the
        // shared-token challenge is a genuine `invalid_token`.
        const shared = mapAuthResultToResponse({
          sharedTokenOk: false,
          enabled: true,
          sharedTokenPresented: true,
          bearerPresented: false,
        });
        expect(shared.kind).toBe('respond');
        if (shared.kind !== 'respond') return;
        expect(shared.headers?.['WWW-Authenticate']).toBe(
          MCP_WWW_AUTHENTICATE_SHARED_TOKEN,
        );

        // ...and symmetrically for a rejected api_key with no X-MCP-Token sent.
        const bearer = mapAuthResultToResponse({
          sharedTokenOk: true,
          enabled: true,
          error: new UnauthorizedException(MCP_CHALLENGE_BEARER_DESCRIPTION),
          sharedTokenPresented: false,
          bearerPresented: true,
        });
        expect(bearer.kind).toBe('respond');
        if (bearer.kind !== 'respond') return;
        expect(bearer.headers?.['WWW-Authenticate']).toBe(MCP_WWW_AUTHENTICATE);
      });
    });

    it.each([
      ['bearer', MCP_WWW_AUTHENTICATE],
      ['shared-token', MCP_WWW_AUTHENTICATE_SHARED_TOKEN],
    ])(
      'the %s challenge does NOT advertise OAuth (no resource_metadata)',
      (_name, challenge) => {
        // Under the MCP spec `resource_metadata=` means "I have an OAuth AS, here
        // is its metadata" — that false promise is the root of #636. We have no AS.
        expect(challenge).not.toContain('resource_metadata');
        expect(challenge).not.toContain('.well-known');
        expect(challenge).not.toContain('oauth');
      },
    );

    // A comma inside the quoted error_description is legal (RFC 7235 §2.1) but
    // reckless: `WWW-Authenticate` is a comma-separated list, and the many naive
    // clients/proxies that split on `,` without honouring quotes would tear the
    // challenge in half and hand the user a garbage second "challenge".
    it.each([
      ['bearer', MCP_WWW_AUTHENTICATE],
      ['shared-token', MCP_WWW_AUTHENTICATE_SHARED_TOKEN],
    ])(
      'the %s challenge puts NO comma inside its quoted error_description',
      (_name, challenge) => {
        const marker = 'error_description="';
        const start = challenge.indexOf(marker) + marker.length;
        // Everything between the opening quote and the header's final quote.
        const description = challenge.slice(start, challenge.length - 1);
        expect(description.length).toBeGreaterThan(0);
        expect(description).not.toContain(',');
      },
    );

    // F9 — the header's error_description and the JSON body's message are the SAME
    // sentence (same constant), punctuation included.
    it('the error_description matches the 401 body message byte for byte', () => {
      const d = mapAuthResultToResponse({
        sharedTokenOk: true,
        enabled: true,
        error: new UnauthorizedException(MCP_CHALLENGE_BEARER_DESCRIPTION),
        sharedTokenPresented: true,
        bearerPresented: true,
      });
      expect(d.kind).toBe('respond');
      if (d.kind !== 'respond') return;
      expect(d.body.error).toBe(MCP_CHALLENGE_BEARER_DESCRIPTION);
      expect(d.headers?.['WWW-Authenticate']).toContain(
        `error_description="${d.body.error}"`,
      );
      expect(MCP_CHALLENGE_BEARER_DESCRIPTION.endsWith('.')).toBe(true);
      expect(MCP_CHALLENGE_SHARED_TOKEN_DESCRIPTION.endsWith('.')).toBe(true);
    });

    it('the 401 BODIES are unchanged by the challenge', () => {
      const shared = mapAuthResultToResponse({
        sharedTokenOk: false,
        enabled: true,
        sharedTokenPresented: true,
        bearerPresented: true,
      });
      expect(shared.kind).toBe('respond');
      if (shared.kind === 'respond') {
        expect(shared.body).toEqual({ error: 'Unauthorized' });
      }

      const badKey = mapAuthResultToResponse({
        sharedTokenOk: true,
        enabled: true,
        error: new UnauthorizedException('Invalid or expired token'),
        sharedTokenPresented: true,
        bearerPresented: true,
      });
      expect(badKey.kind).toBe('respond');
      if (badKey.kind === 'respond') {
        expect(badKey.body).toEqual({ error: 'Invalid or expired token' });
      }
    });

    it('the 500 (infra) path carries no challenge either', () => {
      const d = mapAuthResultToResponse({
        sharedTokenOk: true,
        enabled: true,
        error: new Error('boom'),
        sharedTokenPresented: true,
        bearerPresented: true,
      });
      expect(d.kind).toBe('respond');
      if (d.kind === 'respond') {
        expect(d.status).toBe(500);
        expect(d.headers).toBeUndefined();
      }
    });
  });
});

// The docs quote the challenge VERBATIM (a user copies the header out of the README
// to debug a 401). A constant changed without the docs is a silent lie, so scrape
// them — the same drift-guard shape as the metric-name guard below.
describe('the docs quote the challenge byte for byte (#636)', () => {
  const repoRoot = resolve(__dirname, '../../../../..');

  it.each([
    'packages/mcp/README.md',
    'packages/mcp/README.ru.md',
    'CHANGELOG.md',
  ])('%s carries the exact WWW-Authenticate values', (relPath) => {
    const doc = readFileSync(join(repoRoot, relPath), 'utf8');
    expect(doc).toContain(MCP_WWW_AUTHENTICATE);
    expect(doc).toContain(MCP_WWW_AUTHENTICATE_SHARED_TOKEN);
  });
});

// #636 F1 — the REAL McpService.handle must APPLY the challenge to the reply. The
// pure mapping above only proves the decision CARRIES the header; this proves the
// service actually writes it, and writes it BEFORE the body (a header set after
// send() would never reach the wire).
describe('McpService.handle applies the WWW-Authenticate challenge (#636)', () => {
  function makeReply() {
    const res = {
      header: jest.fn(() => res),
      status: jest.fn(() => res),
      send: jest.fn(() => res),
      hijack: jest.fn(),
      raw: {},
    };
    return res;
  }

  function makeService(): McpService {
    // The constructor only stores its deps, so bare stubs suffice.
    const svc = new McpService({} as any, {} as any, {} as any, {} as any);
    (svc as any).isEnabled = jest.fn().mockResolvedValue(true);
    return svc;
  }

  // `string[]` is a real shape: Node joins most duplicate headers into one string,
  // but not all of them, so a client that sends X-MCP-Token twice can surface here
  // as an array — see isCredentialHeaderPresent.
  function makeRequest(headers: Record<string, string | string[]> = {}) {
    return { headers, raw: {}, body: undefined } as any;
  }

  function challengeOf(res: ReturnType<typeof makeReply>): string | undefined {
    return res.header.mock.calls.find(
      (c) => c[0] === 'WWW-Authenticate',
    )?.[1] as string | undefined;
  }

  const savedMcpToken = process.env.MCP_TOKEN;
  afterEach(() => {
    if (savedMcpToken === undefined) delete process.env.MCP_TOKEN;
    else process.env.MCP_TOKEN = savedMcpToken;
  });

  it('a 401 from a rejected api_key carries the Bearer challenge, set BEFORE send', async () => {
    delete process.env.MCP_TOKEN;
    const svc = makeService();
    svc.resolveSessionConfig = jest
      .fn()
      .mockRejectedValue(new UnauthorizedException('Invalid or expired token'));

    const res = makeReply();
    await svc.handle(makeRequest({ authorization: 'Bearer bad-key' }), res);

    expect(res.header).toHaveBeenCalledWith(
      'WWW-Authenticate',
      MCP_WWW_AUTHENTICATE,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({
      error: 'Invalid or expired token',
    });
    expect(res.hijack).not.toHaveBeenCalled();

    // The header MUST be written before the body is sent, or it never ships.
    const headerCall = res.header.mock.invocationCallOrder[0];
    const sendCall = res.send.mock.invocationCallOrder[0];
    expect(headerCall).toBeLessThan(sendCall);
  });

  it('a request with NO credential gets a challenge without error= (RFC 6750 §3.1)', async () => {
    delete process.env.MCP_TOKEN;
    const svc = makeService();
    svc.resolveSessionConfig = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException(MCP_CHALLENGE_BEARER_DESCRIPTION),
      );

    const res = makeReply();
    await svc.handle(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(401);
    const challenge = res.header.mock.calls.find(
      (c) => c[0] === 'WWW-Authenticate',
    )?.[1] as string;
    expect(challenge).toBeDefined();
    expect(challenge).toContain(MCP_CHALLENGE_BEARER_DESCRIPTION);
    expect(challenge).not.toContain('error=');
  });

  it('a missing X-MCP-Token 401 names X-MCP-Token, with NO error code (none was sent)', async () => {
    process.env.MCP_TOKEN = 'shared-secret';
    const svc = makeService();

    const res = makeReply();
    // The client did what the OLD challenge told it to: it sent the api_key. It
    // still has no X-MCP-Token, so the challenge must now say so...
    await svc.handle(makeRequest({ authorization: 'Bearer good-key' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    const challenge = challengeOf(res);
    expect(challenge).toContain('X-MCP-Token');
    expect(challenge).toContain(MCP_CHALLENGE_SHARED_TOKEN_DESCRIPTION);
    // ...and, per RFC 6750 §3.1, it must NOT call that absent X-MCP-Token invalid.
    // The Authorization header the client DID send is a different credential — this
    // challenge is not about it. Claiming `invalid_token` here would send the user
    // hunting a shared secret it never sent: the very "the error names a credential
    // that was never presented" bug #636 is about.
    expect(challenge).not.toContain('error=');
    expect(challenge).not.toBe(MCP_WWW_AUTHENTICATE_SHARED_TOKEN);
  });

  it('a WRONG X-MCP-Token (one WAS sent) does get error="invalid_token"', async () => {
    process.env.MCP_TOKEN = 'shared-secret';
    const svc = makeService();

    const res = makeReply();
    await svc.handle(makeRequest({ 'x-mcp-token': 'nope' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    // The credential this challenge asks for WAS presented and WAS rejected, so the
    // full challenge (with the error code) is correct here.
    expect(challengeOf(res)).toBe(MCP_WWW_AUTHENTICATE_SHARED_TOKEN);
  });

  it('a duplicated X-MCP-Token (Node hands us a string[]) still counts as presented', async () => {
    process.env.MCP_TOKEN = 'shared-secret';
    const svc = makeService();

    const res = makeReply();
    await svc.handle(
      makeRequest({ 'x-mcp-token': ['nope', 'also-nope'] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    // Reading an array as "absent" would drop the error code on a request that
    // presented the credential twice.
    expect(challengeOf(res)).toBe(MCP_WWW_AUTHENTICATE_SHARED_TOKEN);
  });

  it('an EMPTY X-MCP-Token header carries no authentication information -> no error code', async () => {
    process.env.MCP_TOKEN = 'shared-secret';
    const svc = makeService();

    const res = makeReply();
    // `X-MCP-Token:` with no value is a legal request and Node reports it as ''.
    // RFC 6750 §3.1 turns on whether the request "lacks ANY authentication
    // information" — an empty value carries none, so it is not a bad token.
    await svc.handle(makeRequest({ 'x-mcp-token': '   ' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(challengeOf(res)).not.toContain('error=');
  });

  it('the api_key 401 does not claim invalid_token when only X-MCP-Token was sent', async () => {
    // Mirror case: no MCP_TOKEN configured (so the shared gate passes trivially),
    // the client sent only X-MCP-Token and no Authorization. The Bearer challenge
    // must not claim an api_key it never received was invalid.
    delete process.env.MCP_TOKEN;
    const svc = makeService();
    svc.resolveSessionConfig = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException(MCP_CHALLENGE_BEARER_DESCRIPTION),
      );

    const res = makeReply();
    await svc.handle(makeRequest({ 'x-mcp-token': 'irrelevant' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    const challenge = challengeOf(res);
    expect(challenge).toContain(MCP_CHALLENGE_BEARER_DESCRIPTION);
    expect(challenge).not.toContain('error=');
  });

  it('an EMPTY Authorization header -> the Bearer challenge carries no error code', async () => {
    delete process.env.MCP_TOKEN;
    const svc = makeService();
    svc.resolveSessionConfig = jest
      .fn()
      .mockRejectedValue(
        new UnauthorizedException(MCP_CHALLENGE_BEARER_DESCRIPTION),
      );

    const res = makeReply();
    await svc.handle(makeRequest({ authorization: '' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(challengeOf(res)).not.toContain('error=');
  });

  it('the 403 (MCP disabled) response carries no challenge', async () => {
    delete process.env.MCP_TOKEN;
    const svc = makeService();
    (svc as any).isEnabled = jest.fn().mockResolvedValue(false);

    const res = makeReply();
    await svc.handle(makeRequest({ authorization: 'Bearer good-key' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.header).not.toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.anything(),
    );
  });
});

// #486: onModuleDestroy tears down the live loopback CollabSessions so the
// embedded MCP's collab sockets do not keep docs pinned open on the collab
// server past process exit. The teardown goes through an overridable seam
// (destroyAllMcpSessions) so it can be spied without loading the ESM-only
// @docmost/mcp package.
describe('McpService.onModuleDestroy — CollabSession teardown (#486)', () => {
  function makeService(): McpService {
    // The constructor only stores its deps, so bare stubs suffice.
    return new McpService({} as any, {} as any, {} as any, {} as any);
  }

  it('destroys all sessions on shutdown', async () => {
    const svc = makeService();
    const destroy = jest.fn().mockResolvedValue(undefined);
    (svc as any).destroyAllMcpSessions = destroy;

    await svc.onModuleDestroy();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('swallows a teardown failure so shutdown never throws', async () => {
    const svc = makeService();
    (svc as any).destroyAllMcpSessions = jest
      .fn()
      .mockRejectedValue(new Error('collab teardown boom'));

    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });
});

// The @docmost/mcp package is dependency-neutral: it emits generic
// (name, value, labels) samples through its `onMetric` sink and knows nothing
// about prom-client. routeMcpMetric is the ONLY place those names are mapped onto
// this app's instruments, and the mapping is CLOSED — a name with no branch is
// silently DISCARDED and never reaches /metrics. That is a real failure mode
// (#613 shipped mcp_download_bytes_total in the package with no branch here, so
// the metric existed in the package's unit tests and nowhere else), hence both a
// per-name mapping test AND a drift guard that scrapes the package source.
describe('routeMcpMetric — the package→prom metric mapping (#402/#479/#613)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes mcp_tool_duration_seconds onto the tool histogram, by tool label', () => {
    routeMcpMetric('mcp_tool_duration_seconds', 0.25, { tool: 'getPage' });
    expect(metrics.observeMcpTool).toHaveBeenCalledWith('getPage', 0.25);
  });

  it('routes an unlabelled duration sample to the bounded "other" bucket', () => {
    routeMcpMetric('mcp_tool_duration_seconds', 0.5, undefined);
    expect(metrics.observeMcpTool).toHaveBeenCalledWith('other', 0.5);
  });

  it('routes collab_connect_timeouts_total and the getPage cache counters', () => {
    routeMcpMetric('collab_connect_timeouts_total', 1);
    routeMcpMetric('mcp_getpage_cache_hits_total', 1);
    routeMcpMetric('mcp_getpage_cache_misses_total', 1);
    expect(metrics.incConnectTimeout).toHaveBeenCalledTimes(1);
    expect(metrics.incGetPageCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.incGetPageCacheMiss).toHaveBeenCalledTimes(1);
  });

  it('routes mcp_download_bytes_total onto the download counter WITH its tool label (#613)', () => {
    routeMcpMetric('mcp_download_bytes_total', 4096, { tool: 'downloadFile' });
    expect(metrics.addMcpDownloadBytes).toHaveBeenCalledWith(
      'downloadFile',
      4096,
    );
    // It must NOT be mistaken for a duration observation.
    expect(metrics.observeMcpTool).not.toHaveBeenCalled();
  });

  it('routes the three RYOW freshness samples, dbrow carrying its bounded reason label', () => {
    routeMcpMetric('mcp_ryow_live_total', 1);
    routeMcpMetric('mcp_ryow_dbrow_total', 1, { reason: 'owner_unreachable' });
    routeMcpMetric('mcp_ryow_expired_total', 1);
    expect(metrics.incMcpRyowLive).toHaveBeenCalledTimes(1);
    expect(metrics.incMcpRyowDbrow).toHaveBeenCalledWith('owner_unreachable');
    expect(metrics.incMcpRyowExpired).toHaveBeenCalledTimes(1);
  });

  it('discards an unknown name without throwing (the closed mapping)', () => {
    expect(() =>
      routeMcpMetric('totally_unknown_total', 1, { tool: 'x' }),
    ).not.toThrow();
    expect(metrics.observeMcpTool).not.toHaveBeenCalled();
    expect(metrics.incConnectTimeout).not.toHaveBeenCalled();
    expect(metrics.addMcpDownloadBytes).not.toHaveBeenCalled();
  });

  // Drift guard: EVERY metric name the package emits must have a branch here.
  // Scraped from the package source, so a new `onMetric(...)` sample added there
  // with no branch here reds THIS test instead of silently vanishing at runtime.
  it('has a branch for every metric name the @docmost/mcp package emits', () => {
    const pkgSrc = resolve(__dirname, '../../../../../packages/mcp/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(pkgSrc);

    const emitted = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /onMetric(?:Fn)?\?\.\(\s*["']([a-z0-9_]+)["']/g,
      )) {
        emitted.add(m[1]);
      }
    }
    // Sanity: if the scrape regressed, fail loudly rather than pass vacuously.
    expect(emitted.size).toBeGreaterThanOrEqual(5);
    expect(emitted.has('mcp_download_bytes_total')).toBe(true);

    for (const name of emitted) {
      jest.clearAllMocks();
      routeMcpMetric(name, 1, { tool: 'downloadFile' });
      const routed =
        (metrics.observeMcpTool as jest.Mock).mock.calls.length +
        (metrics.incConnectTimeout as jest.Mock).mock.calls.length +
        (metrics.incGetPageCacheHit as jest.Mock).mock.calls.length +
        (metrics.incGetPageCacheMiss as jest.Mock).mock.calls.length +
        (metrics.addMcpDownloadBytes as jest.Mock).mock.calls.length +
        (metrics.incMcpRyowLive as jest.Mock).mock.calls.length +
        (metrics.incMcpRyowDbrow as jest.Mock).mock.calls.length +
        (metrics.incMcpRyowExpired as jest.Mock).mock.calls.length;
      if (routed !== 1) {
        throw new Error(
          `the package emits "${name}" but routeMcpMetric routed it to ${routed} ` +
            `instrument(s) — with 0 the sample is DISCARDED and never reaches /metrics`,
        );
      }
    }
  });
});
