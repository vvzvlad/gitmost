// Unit tests for GitHttpService — the /git smart-HTTP handler. Everything it
// depends on (backend, auth, repos, ability factory, env, orchestrator) is
// mocked so we exercise ONLY the handler wiring: workspace resolution (which is
// done HERE, not by DomainMiddleware), the auth/gating precedence,
// the read-vs-write dispatch, and that a fetch does NOT take the lock.
//
// These tests deliberately NEVER set `req.raw.workspaceId`: the workspace must
// come from WorkspaceRepo; a handler reading `req.raw.workspaceId` would 401 in
// the happy-path fetch test below.
import {
  BadRequestException,
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
  /** What workspaceRepo.findFirst() returns (self-hosted resolution). */
  workspace?: { id: string } | null;
  /** What spaceRepo.findById() returns. */
  space?: { id: string; settings?: unknown } | null;
  /** Result of authService.verifyUserCredentials: a user, or throw 401. */
  user?: { id: string; email: string } | null;
  /** Whether the created ability grants the requested action. */
  abilityCan?: boolean;
  /** What GitSyncRestrictionsService.spaceHasRestrictedPages() returns. */
  restricted?: boolean;
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
  };
  backend: { run: AnyMock };
  restrictions: { spaceHasRestrictedPages: AnyMock };
}

function build(opts: BuildOptions = {}): Built {
  const {
    selfHosted = true,
    workspace = { id: 'ws-1' },
    space = { id: 'space-1', settings: { gitSync: { enabled: true } } },
    user = { id: 'user-1', email: 'dev@example.com' },
    abilityCan = true,
    restricted = false,
  } = opts;

  const env: Record<string, AnyMock> = {
    isSelfHosted: jest.fn(() => selfHosted),
    isCloud: jest.fn(() => !selfHosted),
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
  };
  const backend = { run: jest.fn(async () => undefined) };
  const restrictions = {
    spaceHasRestrictedPages: jest.fn(async () => restricted),
  };
  // An in-memory stand-in for the global cache-manager (the cached workspace
  // loader shared with DomainMiddleware goes through it).
  const store = new Map<string, unknown>();
  const cacheManager = {
    get: jest.fn(async (key: string) => store.get(key)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  };

  const service = new GitHttpService(
    env as any,
    authService as any,
    spaceRepo as any,
    workspaceRepo as any,
    abilityFactory as any,
    vaultRegistry as any,
    orchestrator as any,
    backend as any,
    restrictions as any,
    cacheManager as any,
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
    restrictions,
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
      // Fastify 5: `reply.sent` is true once the reply is hijacked.
      state.hijacked = true;
      state.sent = true;
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
  /** The framework-parsed client IP (the limiter key source). */
  ip?: string;
}) {
  const {
    url,
    method = 'GET',
    authorization,
    host = 'docs.example.com',
    ip,
  } = opts;
  const headers: Record<string, string> = { host };
  if (authorization) headers['authorization'] = authorization;
  // query is parsed by Fastify; mirror it, including that a repeated key
  // becomes an array.
  const qIdx = url.indexOf('?');
  const query: Record<string, string | string[]> = {};
  if (qIdx !== -1) {
    for (const pair of url.slice(qIdx + 1).split('&')) {
      const [k, v] = pair.split('=');
      if (!k) continue;
      const prev = query[k];
      if (prev === undefined) query[k] = v ?? '';
      else query[k] = [...(Array.isArray(prev) ? prev : [prev]), v ?? ''];
    }
  }
  return {
    url,
    method,
    headers,
    query,
    ip,
    // raw is intentionally WITHOUT workspaceId — the handler must resolve it
    // itself via WorkspaceRepo (reading req.raw.workspaceId would 401).
    raw: {},
  } as any;
}

function basic(email: string, password: string): string {
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  // Silence the handler's logger.warn/error in negative-path tests.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  errorSpy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
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
    expect(state.headers['WWW-Authenticate']).toBe('Basic realm="DozoR WIKI"');
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
    expect(state.headers['WWW-Authenticate']).toBe('Basic realm="DozoR WIKI"');
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
    // brute-force which spaces exist / have git-sync enabled.
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

  it('a push that fails before its receive-pack wrote anything -> 500, socket ended', async () => {
    const built = build({ abilityCan: true });
    // The vault recovery that runs before the receive-pack threw.
    built.orchestrator.ingestExternalPush.mockRejectedValue(
      new Error('git status failed'),
    );
    const { reply } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/git-receive-pack',
      method: 'POST',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    const raw = reply.raw as any;
    expect(raw.statusCode).toBe(500);
    expect(raw.end).toHaveBeenCalledTimes(1);
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
    expect(state.headers['WWW-Authenticate']).toBe('Basic realm="DozoR WIKI"');
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  // --- brute-force throttle (per-IP and per-IP+email keys) --------------------
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
      expect(state.headers['WWW-Authenticate']).toBe('Basic realm="DozoR WIKI"');
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

      // 10 such failures — far beyond the threshold — must all be 500 (never a
      // 401), never 429, because each releases its reservation.
      for (let i = 0; i < 10; i++) {
        const { reply, state } = fakeReply();
        await built.service.handle(wrongCredReq(), reply);
        expect(state.statusCode).toBe(500);
      }
      expect(built.authService.verifyUserCredentials).toHaveBeenCalledTimes(10);

      built.service.onModuleDestroy();
    });

    it('failures from one IP do not lock the victim out from another IP', async () => {
      const built = build();
      built.authService.verifyUserCredentials.mockRejectedValue(
        new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE),
      );
      const attempt = (ip: string, password: string) =>
        fakeRequest({
          url: '/git/space-1.git/info/refs?service=git-upload-pack',
          method: 'GET',
          authorization: basic('victim@example.com', password),
          ip,
        });

      // The attacker burns the (attacker IP, victim email) budget...
      for (let i = 0; i < 5; i++) {
        const { reply, state } = fakeReply();
        await built.service.handle(attempt('203.0.113.9', 'guess'), reply);
        expect(state.statusCode).toBe(401);
      }
      const blocked = fakeReply();
      await built.service.handle(
        attempt('203.0.113.9', 'guess'),
        blocked.reply,
      );
      expect(blocked.state.statusCode).toBe(429);

      // ...but the victim, from their own IP, is still checked and gets in.
      built.authService.verifyUserCredentials.mockResolvedValueOnce({
        id: 'user-1',
        email: 'victim@example.com',
      });
      const victim = fakeReply();
      await built.service.handle(
        attempt('198.51.100.7', 'right'),
        victim.reply,
      );
      expect(victim.state.statusCode).toBeUndefined();
      expect(victim.state.hijacked).toBe(true);
      expect(built.authService.verifyUserCredentials).toHaveBeenCalledTimes(6);
      expect(built.backend.run).toHaveBeenCalledTimes(1);

      built.service.onModuleDestroy();
    });

    it('the per-IP bucket throttles one source across different emails', async () => {
      const built = build();
      built.authService.verifyUserCredentials.mockRejectedValue(
        new UnauthorizedException(CREDENTIALS_MISMATCH_MESSAGE),
      );
      const spray = (email: string) =>
        fakeRequest({
          url: '/git/space-1.git/info/refs?service=git-upload-pack',
          method: 'GET',
          authorization: basic(email, 'guess'),
          ip: '203.0.113.9',
        });

      for (let i = 0; i < 5; i++) {
        const { reply, state } = fakeReply();
        await built.service.handle(spray(`user${i}@example.com`), reply);
        expect(state.statusCode).toBe(401);
      }
      const { reply, state } = fakeReply();
      await built.service.handle(spray('user5@example.com'), reply);
      expect(state.statusCode).toBe(429);
      // The 6th email never reached bcrypt.
      expect(built.authService.verifyUserCredentials).toHaveBeenCalledTimes(5);

      built.service.onModuleDestroy();
    });
  });

  // --- infrastructure failures are logged 500s, never 401/404 ----------------
  describe('infrastructure failures', () => {
    const fetchReq = () =>
      fakeRequest({
        url: '/git/space-1.git/info/refs?service=git-upload-pack',
        method: 'GET',
        authorization: basic('dev@example.com', 'pw'),
      });

    it('a workspace lookup failure -> logged 500, not 401 (git would erase the saved password)', async () => {
      const built = build();
      built.workspaceRepo.findFirst.mockRejectedValue(
        new Error('ECONNREFUSED'),
      );
      const { reply, state } = fakeReply();

      await built.service.handle(fetchReq(), reply);

      expect(state.statusCode).toBe(500);
      expect(state.headers['WWW-Authenticate']).toBeUndefined();
      expect(String(state.body)).toContain('could not resolve the workspace');
      expect(built.authService.verifyUserCredentials).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error: ECONNREFUSED'),
        expect.stringContaining('ECONNREFUSED'),
      );
    });

    it('a credential-check infrastructure failure -> logged 500 with its stack, not 401', async () => {
      const built = build();
      built.authService.verifyUserCredentials.mockRejectedValue(
        new Error('connection terminated'),
      );
      const { reply, state } = fakeReply();

      await built.service.handle(fetchReq(), reply);

      expect(state.statusCode).toBe(500);
      expect(state.headers['WWW-Authenticate']).toBeUndefined();
      expect(String(state.body)).toContain('could not verify the credentials');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection terminated'),
        expect.stringContaining('connection terminated'),
      );
      expect(built.backend.run).not.toHaveBeenCalled();
    });

    it('a client error from the credential check (unverified email) -> its own 400 + message, not 500/401, reservation released', async () => {
      const built = build();
      // The shape throwIfEmailNotVerified throws in cloud mode.
      built.authService.verifyUserCredentials.mockRejectedValue(
        new BadRequestException({
          message: 'Please verify your email address.',
          emailSignature: 'sig',
        }),
      );

      // Beyond the limiter threshold: each attempt releases its reservation.
      for (let i = 0; i < 6; i++) {
        const { reply, state } = fakeReply();
        await built.service.handle(fetchReq(), reply);
        expect(state.statusCode).toBe(400);
        expect(state.body).toBe('Please verify your email address.');
        expect(state.headers['WWW-Authenticate']).toBeUndefined();
      }
      expect(built.authService.verifyUserCredentials).toHaveBeenCalledTimes(6);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(built.backend.run).not.toHaveBeenCalled();

      built.service.onModuleDestroy();
    });

    it('a membership-check infrastructure failure -> logged 500, not the non-member 404', async () => {
      const built = build();
      built.abilityFactory.createForUser.mockRejectedValue(
        new Error('pool exhausted'),
      );
      const { reply, state } = fakeReply();

      await built.service.handle(fetchReq(), reply);

      expect(state.statusCode).toBe(500);
      expect(String(state.body)).toContain(
        'could not check the space membership',
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('pool exhausted'),
        expect.stringContaining('pool exhausted'),
      );
      expect(built.backend.run).not.toHaveBeenCalled();
    });
  });

  // --- a duplicated `service` parameter is refused ---------------------------
  it('a duplicated service query parameter -> 400, nothing authorized or served', async () => {
    const built = build();
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack&service=git-receive-pack',
      method: 'GET',
      authorization: basic('dev@example.com', 'pw'),
    });

    await built.service.handle(req, reply);

    expect(state.statusCode).toBe(400);
    expect(String(state.body)).toContain("'service'");
    expect(built.abilityFactory.createForUser).not.toHaveBeenCalled();
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  it('a duplicated service parameter without credentials still gets the 401 first', async () => {
    const built = build();
    const { reply, state } = fakeReply();
    const req = fakeRequest({
      url: '/git/space-1.git/info/refs?service=git-upload-pack&service=git-receive-pack',
      method: 'GET',
    });

    await built.service.handle(req, reply);

    expect(state.statusCode).toBe(401);
  });

  // --- every throw on the raw route ends in a logged 500 ---------------------
  describe('unexpected throws', () => {
    it('a space lookup that throws BEFORE the hijack -> logged 500 via the reply, handle() resolves', async () => {
      const built = build();
      built.spaceRepo.findById.mockRejectedValue(new Error('relation missing'));
      const { reply, state } = fakeReply();

      await expect(
        built.service.handle(
          fakeRequest({
            url: '/git/space-1.git/info/refs?service=git-upload-pack',
            method: 'GET',
            authorization: basic('dev@example.com', 'pw'),
          }),
          reply,
        ),
      ).resolves.toBeUndefined();

      expect(state.statusCode).toBe(500);
      expect(String(state.body)).toContain('Internal server error');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('relation missing'),
        expect.stringContaining('relation missing'),
      );
    });

    it('a backend bridge that throws AFTER the hijack -> 500 on the raw socket, which is ended', async () => {
      const built = build();
      built.backend.run.mockRejectedValue(new Error('git-sync loader failed'));
      const { reply, state } = fakeReply();

      await expect(
        built.service.handle(
          fakeRequest({
            url: '/git/space-1.git/git-upload-pack',
            method: 'POST',
            authorization: basic('dev@example.com', 'pw'),
          }),
          reply,
        ),
      ).resolves.toBeUndefined();

      expect(state.hijacked).toBe(true);
      const raw = reply.raw as any;
      expect(raw.statusCode).toBe(500);
      expect(raw.end).toHaveBeenCalledTimes(1);
      expect(String(raw.end.mock.calls[0][0])).toContain(
        'Internal server error',
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('git-sync loader failed'),
        expect.stringContaining('git-sync loader failed'),
      );
    });

    it('a vault preparation failure -> logged 500, nothing hijacked', async () => {
      const built = build();
      built.vaultRegistry.ensureServable.mockRejectedValue(
        new Error('config.lock exists'),
      );
      const { reply, state } = fakeReply();

      await built.service.handle(
        fakeRequest({
          url: '/git/space-1.git/info/refs?service=git-upload-pack',
          method: 'GET',
          authorization: basic('dev@example.com', 'pw'),
        }),
        reply,
      );

      expect(state.statusCode).toBe(500);
      expect(state.hijacked).toBe(false);
      expect(built.backend.run).not.toHaveBeenCalled();
    });
  });

  // --- restricted spaces -------------------------------------------------------
  it('a MEMBER of a space with restricted pages -> 403 naming the reason, nothing served', async () => {
    const built = build({ restricted: true });
    const { reply, state } = fakeReply();

    await built.service.handle(
      fakeRequest({
        url: '/git/space-1.git/info/refs?service=git-upload-pack',
        method: 'GET',
        authorization: basic('dev@example.com', 'pw'),
      }),
      reply,
    );

    expect(built.restrictions.spaceHasRestrictedPages).toHaveBeenCalledWith(
      'space-1',
      'ws-1',
    );
    expect(state.statusCode).toBe(403);
    expect(String(state.body)).toContain('restricted');
    expect(built.vaultRegistry.ensureServable).not.toHaveBeenCalled();
    expect(built.backend.run).not.toHaveBeenCalled();
  });

  it('a NON-member of a space with restricted pages -> the same 404 as a missing space', async () => {
    const built = build({ restricted: true });
    built.abilityFactory.createForUser.mockRejectedValue(
      new NotFoundException('Space permissions not found'),
    );
    const { reply, state } = fakeReply();

    await built.service.handle(
      fakeRequest({
        url: '/git/space-1.git/info/refs?service=git-upload-pack',
        method: 'GET',
        authorization: basic('dev@example.com', 'pw'),
      }),
      reply,
    );

    expect(state.statusCode).toBe(404);
    expect(built.restrictions.spaceHasRestrictedPages).not.toHaveBeenCalled();
  });

  it('repeated requests share the cached workspace lookup (one DB query)', async () => {
    const built = build();
    for (let i = 0; i < 3; i++) {
      const { reply } = fakeReply();
      await built.service.handle(
        fakeRequest({
          url: '/git/space-1.git/git-upload-pack',
          method: 'POST',
          authorization: basic('dev@example.com', 'pw'),
        }),
        reply,
      );
    }
    expect(built.workspaceRepo.findFirst).toHaveBeenCalledTimes(1);
    expect(built.backend.run).toHaveBeenCalledTimes(3);
  });
});
