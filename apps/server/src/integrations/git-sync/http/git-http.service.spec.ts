// Unit tests for GitHttpService — the /git smart-HTTP handler. Everything it
// depends on (backend, auth, repos, ability factory, env, orchestrator) is
// mocked so we exercise ONLY the handler wiring: workspace resolution (which is
// done HERE, not by DomainMiddleware — see FIX 1), the auth/gating precedence,
// the read-vs-write dispatch, and that a fetch does NOT take the lock.
//
// These tests deliberately NEVER set `req.raw.workspaceId`: the workspace must
// come from WorkspaceRepo. If the handler regressed to reading
// `req.raw.workspaceId`, the happy-path fetch test below would fail (the repo
// would not be consulted and the request would 401).
import {
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CREDENTIALS_MISMATCH_MESSAGE } from '../../../core/auth/auth.constants';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../../core/casl/interfaces/space-ability.type';
import { GitHttpService } from './git-http.service';
import { GitSyncLockHeldError } from '../services/git-sync.orchestrator';

type AnyMock = jest.Mock;

interface BuildOptions {
  selfHosted?: boolean;
  gitSyncEnabled?: boolean;
  gitHttpEnabled?: boolean;
  /** What workspaceRepo.findFirst() returns (self-hosted resolution). */
  workspace?: { id: string } | null;
  /** What spaceRepo.findById() returns. */
  space?: { id: string; settings?: unknown } | null;
  /** Result of authService.verifyUserCredentials: a user, or throw 401. */
  user?: { id: string; email: string } | null;
  /** Whether the created ability grants the requested action. */
  abilityCan?: boolean;
}

interface Built {
  service: GitHttpService;
  env: Record<string, AnyMock>;
  authService: { verifyUserCredentials: AnyMock };
  spaceRepo: { findById: AnyMock };
  workspaceRepo: { findFirst: AnyMock; findByHostname: AnyMock };
  abilityFactory: { createForUser: AnyMock };
  abilityCan: AnyMock;
  vaultRegistry: { ensureServable: AnyMock };
  orchestrator: {
    ingestExternalPush: AnyMock;
    serveReadAdvertisement: AnyMock;
  };
  backend: { run: AnyMock };
}

function build(opts: BuildOptions = {}): Built {
  const {
    selfHosted = true,
    gitSyncEnabled = true,
    gitHttpEnabled = true,
    workspace = { id: 'ws-1' },
    space = { id: 'space-1', settings: { gitSync: { enabled: true } } },
    user = { id: 'user-1', email: 'dev@example.com' },
    abilityCan = true,
  } = opts;

  const env: Record<string, AnyMock> = {
    isSelfHosted: jest.fn(() => selfHosted),
    isCloud: jest.fn(() => !selfHosted),
    isGitSyncEnabled: jest.fn(() => gitSyncEnabled),
    isGitSyncHttpEnabled: jest.fn(() => gitHttpEnabled),
  };

  const authService = {
    verifyUserCredentials: jest.fn(async () => {
      if (!user) throw new UnauthorizedException();
      return user;
    }),
  };

  const spaceRepo = { findById: jest.fn(async () => space) };

  const workspaceRepo = {
    findFirst: jest.fn(async () => workspace),
    findByHostname: jest.fn(async () => workspace),
  };

  const abilityCanMock = jest.fn(() => abilityCan);
  const abilityFactory = {
    createForUser: jest.fn(async () => ({ can: abilityCanMock })),
  };

  const vaultRegistry = { ensureServable: jest.fn(async () => undefined) };
  const orchestrator = {
    ingestExternalPush: jest.fn(async () => undefined),
    // The read-advertisement wrapper pins HEAD under the lock then serves; the
    // mock just runs the serve callback so the read path still hits backend.run.
    serveReadAdvertisement: jest.fn(
      async (_spaceId: string, serve: () => Promise<void>) => serve(),
    ),
  };
  const backend = { run: jest.fn(async () => undefined) };

  const service = new GitHttpService(
    env as any,
    authService as any,
    spaceRepo as any,
    workspaceRepo as any,
    abilityFactory as any,
    vaultRegistry as any,
    orchestrator as any,
    backend as any,
  );

  return {
    service,
    env,
    authService,
    spaceRepo,
    workspaceRepo,
    abilityFactory,
    abilityCan: abilityCanMock,
    vaultRegistry,
    orchestrator,
    backend,
  };
}

/** A fake Fastify reply capturing the terminal status/headers/body. */
function fakeReply() {
  const state: {
    statusCode?: number;
    headers: Record<string, string>;
    body?: unknown;
    hijacked: boolean;
    sent: boolean;
  } = { headers: {}, hijacked: false, sent: false };

  const reply: any = {
    header(name: string, value: string) {
      state.headers[name] = value;
      return reply;
    },
    status(code: number) {
      state.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      state.sent = true;
      return reply;
    },
    hijack() {
      state.hijacked = true;
    },
    get sent() {
      return state.sent;
    },
    // The raw Node response — only touched on the streaming/error paths.
    raw: {
      headersSent: false,
      writableEnded: false,
      statusCode: 200,
      setHeader: jest.fn(),
      end: jest.fn(),
    },
  };
  return { reply, state };
}

/** A fake Fastify request for a /git smart-HTTP call. */
function fakeRequest(opts: {
  url: string;
  method?: string;
  authorization?: string;
  host?: string;
}) {
  const { url, method = 'GET', authorization, host = 'docs.example.com' } = opts;
  const headers: Record<string, string> = { host };
  if (authorization) headers['authorization'] = authorization;
  // query is parsed by Fastify; mirror the `service` param when present.
  const qIdx = url.indexOf('?');
  const query: Record<string, string> = {};
  if (qIdx !== -1) {
    for (const pair of url.slice(qIdx + 1).split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[k] = v ?? '';
    }
  }
  return {
    url,
    method,
    headers,
    query,
    // raw is intentionally WITHOUT workspaceId — the handler must resolve it
    // itself via WorkspaceRepo (a regression to req.raw.workspaceId would 401).
    raw: {},
  } as any;
}

function basic(email: string, password: string): string {
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

beforeEach(() => {
  jest.clearAllMocks();
  // Silence the handler's logger.warn/error in negative-path tests.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('GitHttpService.handle', () => {
  it('fetch with valid creds resolves the workspace via the repo and dispatches WITHOUT the lock', async () => {
    const built = build({ selfHosted: true });
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    // The workspace came from WorkspaceRepo, NOT req.raw.workspaceId.
    expect(built.workspaceRepo.findFirst).toHaveBeenCalledTimes(1);
    expect(built.authService.verifyUserCredentials).toHaveBeenCalledWith(
      { email: 'dev@example.com', password: 'pw' },
      'ws-1',
    );
    expect(built.spaceRepo.findById).toHaveBeenCalledWith('space-1', 'ws-1');
    // Read ability was evaluated.
    expect(built.abilityCan).toHaveBeenCalledWith(
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
    // It proceeded: vault prepared, reply hijacked, backend ran directly.
    expect(built.vaultRegistry.ensureServable).toHaveBeenCalledWith('space-1');
    expect(state.hijacked).toBe(true);
    expect(built.backend.run).toHaveBeenCalledTimes(1);
    // A fetch must NOT take the push lock.
    expect(built.orchestrator.ingestExternalPush).not.toHaveBeenCalled();
  });

  it('upload-pack ref advertisement is served HEAD-pinned via serveReadAdvertisement (bug #3)', async () => {
    // GET info/refs?service=git-upload-pack carries the HEAD symref a clone reads
    // for its default branch, so it must be served with HEAD pinned to `main`
    // (under the lock) — not streamed raw — or a clone racing a mid-pull cycle
    // would default to the read-only `docmost` mirror.
    const built = build({ abilityCan: true });
    const { reply } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    expect(built.orchestrator.serveReadAdvertisement).toHaveBeenCalledTimes(1);
    expect(built.orchestrator.serveReadAdvertisement.mock.calls[0][0]).toBe(
      'space-1',
    );
    // The wrapper still streams the backend (the mock runs the serve callback).
    expect(built.backend.run).toHaveBeenCalledTimes(1);
    expect(built.orchestrator.ingestExternalPush).not.toHaveBeenCalled();
  });

  it('a POST git-upload-pack pack fetch streams directly (no HEAD-pin needed, resolved by SHA)', async () => {
    // The pack negotiation is object-SHA based; only the ref advertisement carries
    // the HEAD symref, so the pack POST streams the backend directly (no lock).
    const built = build({ abilityCan: true });
    const { reply } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/git-upload-pack',
      method: 'POST',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    expect(built.orchestrator.serveReadAdvertisement).not.toHaveBeenCalled();
    expect(built.backend.run).toHaveBeenCalledTimes(1);
    expect(built.orchestrator.ingestExternalPush).not.toHaveBeenCalled();
  });

  it('cloud deployment resolves the workspace by the host subdomain', async () => {
    const built = build({ selfHosted: false });
    const { reply } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
      host: 'acme.example.com',
    });

    await built.service.handle(req, reply);

    expect(built.workspaceRepo.findByHostname).toHaveBeenCalledWith('acme');
    expect(built.workspaceRepo.findFirst).not.toHaveBeenCalled();
    expect(built.backend.run).toHaveBeenCalledTimes(1);
  });

  it('missing Basic credentials -> 401 with WWW-Authenticate', async () => {
    const built = build();
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      // no Authorization header
    });

    await built.service.handle(req, reply);

    expect(state.statusCode).toBe(401);
    expect(state.headers['WWW-Authenticate']).toBe('Basic realm="gitmost"');
    expect(built.backend.run).not.toHaveBeenCalled();
    expect(built.authService.verifyUserCredentials).not.toHaveBeenCalled();
  });

  it('invalid Basic credentials -> 401 with WWW-Authenticate', async () => {
    const built = build({ user: null }); // verifyUserCredentials throws 401
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'wrong'),
    });

    await built.service.handle(req, reply);

    expect(state.statusCode).toBe(401);
    expect(state.headers['WWW-Authenticate']).toBe('Basic realm="gitmost"');
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  it('a write by a Read-only user -> 403 (reader cannot push)', async () => {
    const built = build({ abilityCan: false });
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/git-receive-pack',
      method: 'POST',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    // The Manage ability was checked for a write and denied.
    expect(built.abilityCan).toHaveBeenCalledWith(
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Page,
    );
    expect(state.statusCode).toBe(403);
    expect(built.orchestrator.ingestExternalPush).not.toHaveBeenCalled();
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  it('an authenticated NON-member of a git-sync space -> 404, NOT 403 (no existence leak)', async () => {
    // createForUser throws NotFound when the user holds no role in the space (a
    // non-member). The gate must return 404 — the SAME response a missing /
    // sync-disabled space gives — so a 403↔404 difference cannot be used to
    // brute-force which spaces exist / have git-sync enabled (the security fix).
    const built = build({ abilityCan: false });
    built.abilityFactory.createForUser.mockRejectedValue(
      new NotFoundException('Space permissions not found'),
    );
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/secret-space.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    expect(built.abilityFactory.createForUser).toHaveBeenCalledTimes(1);
    expect(state.statusCode).toBe(404);
    expect(built.backend.run).not.toHaveBeenCalled();
    expect(built.orchestrator.ingestExternalPush).not.toHaveBeenCalled();
  });

  it('a space that is not git-sync-enabled -> 404 (existence never revealed)', async () => {
    const built = build({
      space: { id: 'space-1', settings: { gitSync: { enabled: false } } },
    });
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    expect(state.statusCode).toBe(404);
    // CASL is never even evaluated for a non-candidate space.
    expect(built.abilityFactory.createForUser).not.toHaveBeenCalled();
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  it('git-sync globally disabled -> 404 even with valid creds', async () => {
    const built = build({ gitSyncEnabled: false });
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    expect(state.statusCode).toBe(404);
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  it('a valid write proceeds through the orchestrator (push takes the lock)', async () => {
    const built = build({ abilityCan: true });
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/git-receive-pack',
      method: 'POST',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    expect(built.abilityCan).toHaveBeenCalledWith(
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Page,
    );
    expect(state.hijacked).toBe(true);
    expect(built.orchestrator.ingestExternalPush).toHaveBeenCalledTimes(1);
    const [spaceId, workspaceId] =
      built.orchestrator.ingestExternalPush.mock.calls[0];
    expect(spaceId).toBe('space-1');
    expect(workspaceId).toBe('ws-1');
  });

  it('GET info/refs?service=git-receive-pack streams the backend WITHOUT a cycle/lock (so the follow-up POST never 503-collides)', async () => {
    // A push is a TWO-request exchange: GET info/refs?service=git-receive-pack
    // (ref advertisement) then POST git-receive-pack (the pack). The info/refs
    // request is write-AUTHORIZED (push perms needed to see those refs) but is
    // READ-ONLY — it must NOT run ingestExternalPush (a Docmost cycle under the
    // per-space lock), or the immediately-following POST collides with the still-
    // running cycle and deterministically 503s. It must just stream the backend.
    const built = build({ abilityCan: true });
    const { reply } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-receive-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    // Authorized as a write (Manage), but executed as a plain stream.
    expect(built.abilityCan).toHaveBeenCalledWith(
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Page,
    );
    expect(built.orchestrator.ingestExternalPush).not.toHaveBeenCalled();
    expect(built.backend.run).toHaveBeenCalledTimes(1);
  });

  it('a push that loses the lock -> 503 with Retry-After and a busy body (headers not written twice)', async () => {
    const built = build({ abilityCan: true });
    // The lock could not be acquired: the receive-pack closure never ran, so the
    // response is still unwritten and the handler must answer 503 itself.
    built.orchestrator.ingestExternalPush.mockRejectedValue(
      new GitSyncLockHeldError('space-1'),
    );
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/git-receive-pack',
      method: 'POST',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    // It hijacked and went through the orchestrator (write path), but the lock
    // was held so the backend never ran.
    expect(state.hijacked).toBe(true);
    expect(built.orchestrator.ingestExternalPush).toHaveBeenCalledTimes(1);
    expect(built.backend.run).not.toHaveBeenCalled();

    // 503 + Retry-After were written on the raw response (headersSent was false).
    const raw = reply.raw as any;
    expect(raw.statusCode).toBe(503);
    expect(raw.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
    expect(raw.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    // The body carries the busy/retry message and the response was ended once.
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledWith('git-sync busy, retry');
    // Exactly the two headers above were set — no double write of headers.
    expect(raw.setHeader).toHaveBeenCalledTimes(2);
  });

  it('does NOT rewrite the 503 status/headers when the response is already sent', async () => {
    const built = build({ abilityCan: true });
    built.orchestrator.ingestExternalPush.mockRejectedValue(
      new GitSyncLockHeldError('space-1'),
    );
    const { reply } = fakeReply();
    // Simulate the (defensive) case where headers were already flushed: the
    // handler must skip statusCode/setHeader and only end() the socket.
    const raw = reply.raw as any;
    raw.headersSent = true;
    const req = fakeRequest({
      url: '/git/space-1.git/git-receive-pack',
      method: 'POST',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    // No header writes when headersSent is already true (no "headers already
    // sent" double-write path), but the body/end still runs.
    expect(raw.setHeader).not.toHaveBeenCalled();
    expect(raw.statusCode).toBe(200); // untouched default from the fake
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledWith('git-sync busy, retry');
  });

  it('an unresolvable workspace -> 401 (credentials cannot be validated without one)', async () => {
    const built = build({ workspace: null });
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    // Without a workspace we cannot run verifyUserCredentials, so credentials
    // are not validated -> 401 (the 401-before-404 ordering is preserved: an
    // unauthenticated request never reaches the space-existence 404).
    expect(built.workspaceRepo.findFirst).toHaveBeenCalledTimes(1);
    expect(built.authService.verifyUserCredentials).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(401);
    expect(state.headers['WWW-Authenticate']).toBe('Basic realm="gitmost"');
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  // --- brute-force throttle (must-fix #1, mirrors the /mcp Basic limiter) -----
  describe('HTTP-Basic brute-force throttle', () => {
    /** A request with wrong credentials for the given email. */
    const wrongCredReq = (email = 'dev@example.com') =>
      fakeRequest({
        url: '/git/space-1.git/info/refs?service=git-upload-pack',
        method: 'GET',
        authorization: basic(email, 'wrong'),
      });

    it('rejects the (threshold+1)-th failed attempt with 429 BEFORE bcrypt', async () => {
      const built = build();
      // Realistic credential failure: verifyUserCredentials throws the SAME
      // UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE) production throws, so
      // isCredentialsFailure matches and the reservation is KEPT (counted).
      built.authService.verifyUserCredentials.mockRejectedValue(
        new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE),
      );

      // 5 failed attempts (threshold = 5): each runs the credential check -> 401.
      for (let i = 0; i < 5; i++) {
        const { reply, state } = fakeReply();
        await built.service.handle(wrongCredReq(), reply);
        expect(state.statusCode).toBe(401);
      }
      expect(built.authService.verifyUserCredentials).toHaveBeenCalledTimes(5);

      // The 6th attempt is throttled: 429, Retry-After, and bcrypt is NOT run.
      const { reply, state } = fakeReply();
      await built.service.handle(wrongCredReq(), reply);
      expect(state.statusCode).toBe(429);
      expect(state.headers['Retry-After']).toBe('60');
      expect(state.headers['WWW-Authenticate']).toBe('Basic realm="gitmost"');
      // Still 5 — the 6th never reached verifyUserCredentials (pre-bcrypt reject).
      expect(built.authService.verifyUserCredentials).toHaveBeenCalledTimes(5);
      expect(built.backend.run).not.toHaveBeenCalled();

      built.service.onModuleDestroy();
    });

    it('a successful auth resets the limiter so later attempts are not throttled', async () => {
      const built = build();
      const verify = built.authService.verifyUserCredentials;
      // First 4 attempts fail (credential mismatch), then one SUCCEEDS.
      verify
        .mockRejectedValueOnce(new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE))
        .mockRejectedValueOnce(new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE))
        .mockRejectedValueOnce(new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE))
        .mockRejectedValueOnce(new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE))
        .mockResolvedValueOnce({ id: 'user-1', email: 'dev@example.com' });

      for (let i = 0; i < 4; i++) {
        const { reply } = fakeReply();
        await built.service.handle(wrongCredReq(), reply);
      }
      // 5th attempt succeeds -> proceeds (not throttled) and clears the budget.
      const okReply = fakeReply();
      await built.service.handle(
        fakeRequest({
          url: '/git/space-1.git/info/refs?service=git-upload-pack',
          method: 'GET',
          authorization: basic('dev@example.com', 'right'),
        }),
        okReply.reply,
      );
      expect(okReply.state.hijacked).toBe(true); // proceeded to the backend

      // After the reset, a fresh wrong attempt is evaluated (401), NOT a 429 —
      // proving the per-IP/per-IP+email budget was cleared by the success.
      verify.mockRejectedValueOnce(
        new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE),
      );
      const { reply, state } = fakeReply();
      await built.service.handle(wrongCredReq(), reply);
      expect(state.statusCode).toBe(401);

      built.service.onModuleDestroy();
    });

    it('a non-credential error releases the reservation (does not burn the budget)', async () => {
      const built = build();
      // A DB error (not a credentials mismatch) must NOT count toward the limiter.
      built.authService.verifyUserCredentials.mockRejectedValue(
        new Error('db down'),
      );

      // 10 such failures — far beyond the threshold — must all be 401, never 429,
      // because each releases its reservation.
      for (let i = 0; i < 10; i++) {
        const { reply, state } = fakeReply();
        await built.service.handle(wrongCredReq(), reply);
        expect(state.statusCode).toBe(401);
      }
      expect(built.authService.verifyUserCredentials).toHaveBeenCalledTimes(10);

      built.service.onModuleDestroy();
    });
  });
});
