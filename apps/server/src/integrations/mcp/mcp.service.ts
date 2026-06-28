import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { pathToFileURL } from 'node:url';
import { IncomingMessage } from 'node:http';
import { FastifyReply, FastifyRequest } from 'fastify';
import { EnvironmentService } from '../environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { AuthService } from '../../core/auth/services/auth.service';
import { TokenService } from '../../core/auth/services/token.service';
import { validateSsoEnforcement } from '../../core/auth/auth.util';
import { JwtPayload } from '../../core/auth/dto/jwt-payload';
import { Workspace } from '@docmost/db/types/entity.types';
import {
  FailedLoginLimiter,
  resolveMcpSessionConfig,
  verifyBearerAccess,
  isInitializeRequestBody,
  sharedTokenMatches,
  clientIp,
  bindAccessJwtVerifier,
  decideBasicGate,
  mapAuthResultToResponse,
  DocmostMcpConfig,
  ResolvedMcpAuth,
} from './mcp-auth.helpers';
import { SandboxStore } from '../sandbox/sandbox.store';

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

// One-time-per-process latch for the legacy-auth migration warning. The shared
// MCP token used to be sent as `Authorization: Bearer <MCP_TOKEN>`; it now lives
// in its own `X-MCP-Token` header. When we still see the old style we log ONCE
// (never the token value) so operators can migrate without log spam.
let warnedLegacyMcpAuth = false;

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
    // Shared singleton in-RAM blob store backing the stash tool.
    private readonly sandboxStore: SandboxStore,
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

  // Bind the stash tool to the shared in-RAM SandboxStore and compose the
  // anonymous public URL (the MCP package owns neither env nor the store).
  // put() returns the read URL + sha256/size; sha256 is also the blob ETag.
  private buildSandboxConfig(): DocmostMcpConfig['sandbox'] {
    return {
      put: (buf: Buffer, mime: string) => {
        const stored = this.sandboxStore.put(buf, mime);
        const base = this.environmentService.getSandboxPublicUrl();
        return {
          uri: `${base}/api/sb/${stored.id}`,
          sha256: stored.sha256,
          size: stored.size,
        };
      },
    };
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

  // Bearer access-JWT verification for the /mcp token fallback. verifyJwt only
  // checks signature/exp/type, but a logged-out (revoked) or disabled user can
  // still hold an unexpired access JWT. JwtStrategy additionally checks the
  // session is active and the user is not disabled; we mirror those exact checks
  // here so the MCP Bearer path is not weaker than the normal cookie/header path.
  private async verifyMcpBearer(
    token: string,
  ): Promise<{ sub?: string; email?: string }> {
    // Resolve THIS instance's workspace so verifyBearerAccess can bind the
    // token's `workspaceId` claim to it (mirrors JwtStrategy). The community
    // build is single-workspace (findFirst), so this is the default workspace
    // and the check is a no-op here; it only rejects a foreign-workspace token
    // in a multi-workspace deployment. Undefined (no workspace configured) means
    // no check — the credentials path would already have failed with no
    // workspace, and an undefined here keeps the helper a no-op rather than
    // rejecting every token.
    const instanceWorkspace = await this.workspaceRepo.findFirst();
    // The revocation/disabled decision logic lives in the framework-free
    // verifyBearerAccess helper (unit-testable without the heavy auth graph);
    // this method only wires in the concrete TokenService + repos.
    return verifyBearerAccess(token, {
      // The JwtType.ACCESS enforcement lives in bindAccessJwtVerifier (a pure,
      // testable seam) so the type literal cannot silently drift to REFRESH.
      verifyJwt: bindAccessJwtVerifier(this.tokenService) as (
        t: string,
      ) => Promise<JwtPayload>,
      expectedWorkspaceId: instanceWorkspace?.id,
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
      clientIp: clientIp(req),
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
    // 1) SSO enforcement. validateSsoEnforcement throws when the workspace
    // enforces SSO; we only need the boolean verdict for the pure decision.
    let ssoEnforced = false;
    try {
      validateSsoEnforcement(workspace);
    } catch {
      ssoEnforced = true;
    }

    // 2) MFA gate — lazy-require the EE module exactly like AuthController.login.
    // On a fork WITHOUT the EE module bundled, mfaResult stays undefined and the
    // pure gate behaves exactly like the controller (no MFA module -> no MFA
    // gate). We only LOAD the module + read the requirement flags here; the
    // accept/reject decision lives in the framework-free decideBasicGate so the
    // SSO/MFA logic is unit-testable without ModuleRef or the on-disk EE module.
    let mfaResult: { userHasMfa?: boolean; requiresMfaSetup?: boolean } | undefined;
    // Only consult the MFA module when SSO has not already disqualified the
    // request (SSO short-circuits, and skipping the load avoids a needless
    // require on the SSO-reject path).
    if (!ssoEnforced) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let MfaModule: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        MfaModule = require('./../../ee/mfa/services/mfa.service');
      } catch {
        // No EE MFA module bundled in this build: same as the controller -> no
        // MFA gate. (A community/fork build has no MFA, so Basic is allowed.)
        MfaModule = undefined;
      }

      if (MfaModule) {
        const mfaService = this.moduleRef.get(MfaModule.MfaService, {
          strict: false,
        });
        // Same requirement check the controller uses. We pass NO FastifyReply
        // (the controller passes `res` only to set a cookie on the no-MFA happy
        // path, which we never take here): we only read the requirement flags.
        mfaResult = await mfaService.checkMfaRequirements(
          creds,
          workspace,
          undefined,
        );
      }
    }

    // Pure accept/reject decision (throws UnauthorizedException on rejection).
    decideBasicGate({ ssoEnforced, mfa: mfaResult });
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
            // Inject the blob-sandbox sink after the auth decision so stash_page
            // can store blobs in the shared in-RAM store regardless of which
            // credential variant resolved.
            return { ...resolved.config, sandbox: this.buildSandboxConfig() };
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
    const sharedTokenOk = sharedToken
      ? sharedTokenMatches(sharedToken, req.headers['x-mcp-token'])
      : true;

    // Back-compat hint (does NOT change the auth decision). When MCP_TOKEN is
    // configured but the request carries no `X-MCP-Token` and instead sends the
    // legacy `Authorization: Bearer <MCP_TOKEN>`, warn ONCE per process so the
    // operator migrates the client. The token value is never logged; the bearer
    // value is compared in constant time via sharedTokenMatches.
    if (
      sharedToken &&
      !warnedLegacyMcpAuth &&
      req.headers['x-mcp-token'] === undefined
    ) {
      const auth = req.headers['authorization'];
      const header = Array.isArray(auth) ? auth[0] : auth;
      const bearer =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice('Bearer '.length)
          : undefined;
      if (bearer !== undefined && sharedTokenMatches(sharedToken, bearer)) {
        warnedLegacyMcpAuth = true;
        this.logger.warn(
          'MCP shared token received via `Authorization: Bearer <MCP_TOKEN>` ' +
            '(legacy). This is no longer accepted: send the shared token in the ' +
            '`X-MCP-Token` header instead, and reserve `Authorization` for ' +
            'per-user credentials. Reconfigure the MCP client to migrate.',
        );
      }
    }

    // Short-circuit checks (shared token, enablement) that do not need the auth
    // resolution. Compute them up front so the response mapping is a single pure
    // decision (mapAuthResultToResponse) that cannot leak the password/header.
    const enabled = sharedTokenOk ? await this.isEnabled() : false;

    // Resolve + validate the per-session identity BEFORE hijacking the response
    // so bad credentials surface as a clean 401 JSON (never a torn response and
    // never a generic "MCP error"). The resolved config/identity is stashed on
    // the raw request for the package's resolver + identify hook to read back.
    let resolved: ResolvedMcpAuth | undefined;
    let authError: unknown;
    if (sharedTokenOk && enabled) {
      try {
        resolved = await this.resolveSessionConfig(req);
      } catch (err) {
        authError = err;
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
        } else {
          this.logger.error('MCP auth resolution failed', err as Error);
        }
      }
    }

    // Pure status/body mapping for the whole pre-hijack gauntlet.
    const decision = mapAuthResultToResponse({
      sharedTokenOk,
      enabled,
      error: authError,
    });
    if (decision.kind === 'respond') {
      res.status(decision.status).send(decision.body);
      return;
    }

    // Stash the resolved auth on the raw request so the package's resolver +
    // identify hook (wired in getHandler) read it back instead of re-parsing.
    (req.raw as unknown as Record<symbol, unknown>)[MCP_RESOLVED] =
      resolved as ResolvedMcpAuth;

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
