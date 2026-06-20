import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { FastifyReply, FastifyRequest } from 'fastify';
import { EnvironmentService } from '../environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { AuthService } from '../../core/auth/services/auth.service';
import { TokenService } from '../../core/auth/services/token.service';
import { validateSsoEnforcement } from '../../core/auth/auth.util';
import { JwtType, JwtPayload } from '../../core/auth/dto/jwt-payload';
import { Workspace } from '@docmost/db/types/entity.types';
import {
  FailedLoginLimiter,
  resolveMcpSessionConfig,
  verifyBearerAccess,
  isInitializeRequestBody,
  DocmostMcpConfig,
  ResolvedMcpAuth,
} from './mcp-auth.helpers';

// Minimal shape of the embedded MCP HTTP handler exported by @docmost/mcp/http.
interface McpHttpHandler {
  handleRequest(
    req: unknown,
    res: unknown,
    parsedBody?: unknown,
  ): Promise<void>;
}

type McpConfigResolver = (
  req: IncomingMessage,
) => DocmostMcpConfig | Promise<DocmostMcpConfig>;

interface McpHttpModule {
  createMcpHttpHandler(
    config: DocmostMcpConfig | McpConfigResolver,
    options?: { identify?: (req: IncomingMessage) => string | Promise<string> },
  ): McpHttpHandler;
}

// Stash key for the per-request resolved config/identity computed (and
// validated) in handle() BEFORE res.hijack(), then read back by the resolver
// the MCP package invokes. Doing the validation pre-hijack lets a bad-creds
// failure return a clean 401 JSON instead of tearing a hijacked response.
const MCP_RESOLVED = Symbol('mcpResolvedConfig');

// TS with module:commonjs downlevels a literal import() to require(), which
// cannot load the ESM-only @docmost/mcp package. Indirect through Function so
// the real dynamic import() survives compilation and can load ESM from
// CommonJS at runtime.
const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private handler: McpHttpHandler | null = null;
  private handlerPromise: Promise<McpHttpHandler> | null = null;
  private warnedMissingCreds = false;

  // In-memory per-IP/email throttle for FAILED /mcp Basic logins. Calling
  // AuthService.login directly bypasses the controller's ThrottlerGuard, so
  // this is the brute-force speed bump for /mcp. 5 failures per 60s window.
  private readonly failedLogins = new FailedLoginLimiter(5, 60_000);

  // Periodically drop expired limiter buckets so never-revisited keys do not
  // accumulate forever (unbounded memory growth / DoS via forgeable XFF keys).
  // unref()'d so it never keeps the process alive; cleared on module destroy.
  // Mirrors the sweepTimer pattern in packages/mcp/src/http.ts.
  private readonly sweepIntervalMs = 60_000;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly userRepo: UserRepo,
    private readonly userSessionRepo: UserSessionRepo,
    private readonly moduleRef: ModuleRef,
  ) {
    this.sweepTimer = setInterval(() => {
      try {
        this.failedLogins.sweep();
      } catch (err) {
        this.logger.error('MCP failed-login limiter sweep failed', err as Error);
      }
    }, this.sweepIntervalMs);
    // Do not let this interval hold the event loop open.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  // Service account the embedded MCP uses to talk back to this Docmost
  // instance over loopback REST + the collaboration WebSocket. Now OPTIONAL:
  // it is only a fallback when no per-user Basic/Bearer credentials are sent.
  private getEmail(): string | undefined {
    return process.env.MCP_DOCMOST_EMAIL;
  }

  private getPassword(): string | undefined {
    return process.env.MCP_DOCMOST_PASSWORD;
  }

  private getApiUrl(): string {
    return (
      process.env.MCP_DOCMOST_API_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/api`
    );
  }

  private credsConfigured(): boolean {
    return Boolean(this.getEmail() && this.getPassword());
  }

  // MCP is a community feature gated by the workspace `ai.mcp` setting (the
  // same toggle the settings UI writes). Docmost self-host is single-workspace,
  // so we read the first/default workspace and treat settings.ai.mcp === true
  // as enabled.
  private async isEnabled(): Promise<boolean> {
    try {
      const workspace = await this.workspaceRepo.findFirst();
      const settings = (workspace?.settings ?? {}) as {
        ai?: { mcp?: boolean };
      };
      return settings?.ai?.mcp === true;
    } catch (err) {
      this.logger.error('Failed to read workspace MCP setting', err as Error);
      return false;
    }
  }

  // Constant-time comparison of the optional shared X-MCP-Token guard. A header
  // value may arrive as string | string[] (multiple X-MCP-Token headers), so we
  // normalise to the first string. crypto.timingSafeEqual avoids leaking the
  // token's length-prefix via early-exit string comparison; it requires equal
  // buffer lengths, so a length mismatch is treated as a non-match WITHOUT
  // calling timingSafeEqual (which would throw on unequal lengths).
  private sharedTokenMatches(
    expected: string,
    provided: string | string[] | undefined,
  ): boolean {
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (typeof value !== 'string') return false;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // Best-effort client IP for the failed-login limiter key. Prefer Fastify's
  // req.ip (which honours a configured trustProxy chain) and the socket address
  // over a raw X-Forwarded-For hop, since XFF is client-forgeable when no
  // trusted proxy is configured. The first XFF hop is only used as a last
  // resort. NOTE: a forged IP can only dodge the per-IP limiter keys — the
  // GLOBAL per-email key in resolveMcpSessionConfig is the real account-brute
  // backstop and does not depend on this value.
  private clientIp(req: FastifyRequest): string {
    if (req.ip) return req.ip;
    if (req.socket?.remoteAddress) return req.socket.remoteAddress;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
    return 'unknown';
  }

  // Bearer access-JWT verification for the /mcp token fallback. verifyJwt only
  // checks signature/exp/type, but a logged-out (revoked) or disabled user can
  // still hold an unexpired access JWT. JwtStrategy additionally checks the
  // session is active and the user is not disabled; we mirror those exact checks
  // here so the MCP Bearer path is not weaker than the normal cookie/header path.
  private async verifyMcpBearer(
    token: string,
  ): Promise<{ sub?: string; email?: string }> {
    // The revocation/disabled decision logic lives in the framework-free
    // verifyBearerAccess helper (unit-testable without the heavy auth graph);
    // this method only wires in the concrete TokenService + repos.
    return verifyBearerAccess(token, {
      verifyJwt: (t) =>
        this.tokenService.verifyJwt(t, JwtType.ACCESS) as Promise<JwtPayload>,
      findUser: (sub, workspaceId) =>
        this.userRepo.findById(sub, workspaceId),
      findActiveSession: (sessionId) =>
        this.userSessionRepo.findActiveById(sessionId),
    });
  }

  /**
   * Resolve the per-session identity from the request and produce the
   * DocmostMcpConfig the MCP package will run under, plus an opaque identity
   * key for anti-fixation. The decision logic lives in the framework-free
   * `resolveMcpSessionConfig` helper (so it is unit-testable without the heavy
   * auth graph); this method only wires McpService's injected collaborators in.
   *
   * Throws UnauthorizedException with a SPECIFIC message on failure (never a
   * generic "MCP error"); never logs/echoes the password or Authorization
   * header. Run BEFORE res.hijack() so the 401 is clean JSON.
   */
  async resolveSessionConfig(req: FastifyRequest): Promise<ResolvedMcpAuth> {
    const authHeader = req.headers['authorization'] as string | undefined;
    // A request carrying an mcp-session-id is operating on an ALREADY
    // established session (see packages/mcp/src/http.ts: a new session is only
    // minted by an initialize POST with no session id). The session-minting
    // login() (user_sessions insert + USER_LOGIN audit + lastLoginAt bump) must
    // run ONLY for a genuine session INITIALIZE: no mcp-session-id AND the
    // JSON-RPC body is an `initialize` request — the same signal http.ts uses to
    // decide whether to mint a session. Any other request (e.g. a non-initialize
    // body with no session id, which http.ts will 400) uses the non-side-
    // effecting verifyCredentials path so it never mints an orphan DB
    // session/audit row before being rejected.
    const isSessionInit =
      !req.headers['mcp-session-id'] &&
      isInitializeRequestBody((req as unknown as { body?: unknown }).body);
    return resolveMcpSessionConfig(authHeader, {
      apiUrl: this.getApiUrl(),
      email: this.getEmail(),
      password: this.getPassword(),
      findWorkspace: () => this.workspaceRepo.findFirst(),
      enforceBasicGate: (workspace, creds) =>
        this.enforceBasicLoginGate(workspace as Workspace, creds),
      login: (creds, workspaceId) => this.authService.login(creds, workspaceId),
      verifyCredentials: async (creds, workspaceId) => {
        await this.authService.verifyUserCredentials(creds, workspaceId);
      },
      verifyAccessJwt: (token) => this.verifyMcpBearer(token),
      limiter: this.failedLogins,
      clientIp: this.clientIp(req),
      isSessionInit,
    });
  }

  // Pre-token gate for the /mcp HTTP-Basic path, replicating EXACTLY what
  // AuthController.login does before issuing a token, so the Basic path is not
  // an SSO/MFA bypass:
  //   1) validateSsoEnforcement(workspace) — reject if the workspace enforces
  //      SSO (a password login is not allowed there).
  //   2) Lazily require the EE MFA module (same pattern/path as the controller).
  //      If it is bundled and the user has MFA enabled OR the workspace enforces
  //      MFA, reject the Basic path and tell the caller to use a Bearer token (a
  //      Bearer ACCESS JWT is only minted AFTER the normal gated login, so it is
  //      safe). A fork WITHOUT the EE module behaves exactly like the controller:
  //      no MFA module -> no MFA gate.
  // Throws UnauthorizedException on rejection (surfaced as a clean 401, never a
  // torn/hijacked response, never a token). Never logs the password.
  private async enforceBasicLoginGate(
    workspace: Workspace,
    creds: { email: string; password: string },
  ): Promise<void> {
    // 1) SSO enforcement. validateSsoEnforcement throws BadRequestException; we
    // re-surface it as Unauthorized so the /mcp 401 path is consistent and a
    // token is never issued.
    try {
      validateSsoEnforcement(workspace);
    } catch {
      throw new UnauthorizedException(
        'This workspace has enforced SSO login. Use SSO; MCP HTTP Basic is not allowed.',
      );
    }

    // 2) MFA gate — lazy-require the EE module exactly like AuthController.login.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let MfaModule: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      MfaModule = require('./../../ee/mfa/services/mfa.service');
    } catch {
      // No EE MFA module bundled in this build: same as the controller -> no
      // MFA gate. (A community/fork build has no MFA, so Basic is allowed.)
      return;
    }

    const mfaService = this.moduleRef.get(MfaModule.MfaService, {
      strict: false,
    });
    // Use the same requirement check the controller uses. We pass NO FastifyReply
    // (the controller passes `res` only to set a cookie on the no-MFA happy path,
    // which we never take here): we only read the requirement flags. Be tolerant
    // of either a (loginInput, workspace) or (loginInput, workspace, res) shape.
    const mfaResult = await mfaService.checkMfaRequirements(
      creds,
      workspace,
      undefined,
    );

    if (mfaResult && (mfaResult.userHasMfa || mfaResult.requiresMfaSetup)) {
      throw new UnauthorizedException(
        'This account requires multi-factor authentication. MCP HTTP Basic ' +
          'cannot complete MFA — log in normally and use a Bearer access token ' +
          'instead.',
      );
    }
  }

  // Lazily create the HTTP handler exactly once. The import is indirected so
  // the ESM-only @docmost/mcp package can be loaded from this CommonJS module.
  // The handler is created with a per-request RESOLVER (and an `identify` hook
  // for anti-fixation): both read the auth that handle() resolved and stashed
  // on req before hijack, so the package never re-parses credentials.
  private async getHandler(): Promise<McpHttpHandler> {
    if (this.handler) {
      return this.handler;
    }
    if (!this.handlerPromise) {
      this.handlerPromise = (async () => {
        // Resolve the package's HTTP entry to an absolute path, then import it as a
        // file:// URL. require.resolve honours the package "exports" map without
        // executing the module, avoiding bare-specifier resolution-base fragility.
        const httpEntry = require.resolve('@docmost/mcp/http');
        const mod = (await esmImport(
          pathToFileURL(httpEntry).href,
        )) as McpHttpModule;
        const handler = mod.createMcpHttpHandler(
          (req: IncomingMessage) => {
            const resolved = (req as unknown as Record<symbol, unknown>)[
              MCP_RESOLVED
            ] as ResolvedMcpAuth | undefined;
            if (!resolved) {
              // Should never happen: handle() always stashes before delegating.
              throw new UnauthorizedException('MCP authentication missing.');
            }
            return resolved.config;
          },
          {
            identify: (req: IncomingMessage) => {
              const resolved = (req as unknown as Record<symbol, unknown>)[
                MCP_RESOLVED
              ] as ResolvedMcpAuth | undefined;
              if (!resolved || resolved.identity === undefined) {
                throw new UnauthorizedException('MCP authentication missing.');
              }
              return resolved.identity;
            },
          },
        );
        this.handler = handler;
        return handler;
      })().catch((err) => {
        // Do not cache a rejected import — allow the next request to retry.
        this.handlerPromise = null;
        throw err;
      });
    }
    return this.handlerPromise;
  }

  async handle(req: FastifyRequest, res: FastifyReply): Promise<void> {
    // Optional shared-guard. When MCP_TOKEN is set, the request must carry a
    // matching `X-MCP-Token` header. It now lives in its OWN header so it never
    // collides with `Authorization`, which carries the per-user credentials.
    const sharedToken = process.env.MCP_TOKEN;
    if (sharedToken) {
      const provided = req.headers['x-mcp-token'];
      if (!this.sharedTokenMatches(sharedToken, provided)) {
        res.status(401).send({ error: 'Unauthorized' });
        return;
      }
    }

    if (!(await this.isEnabled())) {
      res.status(403).send({ error: 'MCP is disabled for this workspace' });
      return;
    }

    // Resolve + validate the per-session identity BEFORE hijacking the response
    // so bad credentials surface as a clean 401 JSON (never a torn response and
    // never a generic "MCP error"). The resolved config/identity is stashed on
    // the raw request for the package's resolver + identify hook to read back.
    let resolved: ResolvedMcpAuth;
    try {
      resolved = await this.resolveSessionConfig(req);
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        // Warn once if the only thing missing is the service account, to keep
        // the original operator hint.
        if (
          !this.credsConfigured() &&
          !req.headers['authorization'] &&
          !this.warnedMissingCreds
        ) {
          this.warnedMissingCreds = true;
          this.logger.warn(
            'MCP is enabled but received a request with no credentials and no ' +
              'MCP_DOCMOST_EMAIL/MCP_DOCMOST_PASSWORD service account configured.',
          );
        }
        res.status(401).send({ error: err.message });
        return;
      }
      this.logger.error('MCP auth resolution failed', err as Error);
      res.status(500).send({ error: 'Internal server error' });
      return;
    }

    // Stash the resolved auth on the raw request so the package's resolver +
    // identify hook (wired in getHandler) read it back instead of re-parsing.
    (req.raw as unknown as Record<symbol, unknown>)[MCP_RESOLVED] = resolved;

    // Hand the raw Node req/res to the MCP transport. hijack() tells Fastify
    // to stop managing this response so the transport can write to it directly.
    res.hijack();

    try {
      const handler = await this.getHandler();
      await handler.handleRequest(
        req.raw as unknown,
        res.raw as unknown,
        (req as unknown as { body?: unknown }).body,
      );
    } catch (err) {
      this.logger.error('MCP request handling failed', err as Error);
      if (!res.raw.headersSent) {
        res.raw.statusCode = 500;
        res.raw.setHeader('Content-Type', 'application/json');
        res.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  }
}
