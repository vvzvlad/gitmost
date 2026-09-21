import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { pathToFileURL } from 'node:url';
import { IncomingMessage } from 'node:http';
import { FastifyReply, FastifyRequest } from 'fastify';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { TokenService } from '../../core/auth/services/token.service';
import { JwtApiKeyPayload } from '../../core/auth/dto/jwt-payload';
import { ApiKeyService } from '../../core/api-key/api-key.service';
import {
  resolveMcpSessionConfig,
  verifyMcpBearer,
  sharedTokenMatches,
  bindMcpBearerVerifier,
  mapAuthResultToResponse,
  isCredentialHeaderPresent,
  DocmostMcpConfig,
  ResolvedMcpAuth,
} from './mcp-auth.helpers';
import { SandboxStore } from '../sandbox/sandbox.store';
import {
  isMetricsEnabled,
  observeMcpTool,
  incConnectTimeout,
  incGetPageCacheHit,
  incGetPageCacheMiss,
  addMcpDownloadBytes,
  incMcpRyowLive,
  incMcpRyowDbrow,
  incMcpRyowExpired,
} from '../metrics/metrics.registry';

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
const esmImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

/**
 * Route ONE dependency-neutral metric sample emitted by the @docmost/mcp package
 * onto this app's prom-client registry (#402, #479, #613).
 *
 * This is the ONLY place the package's generic (name, value, labels) names are
 * mapped to instruments, and it is a CLOSED mapping: a name with no branch here
 * is DISCARDED and never reaches /metrics. So every new sample the package emits
 * MUST get a branch here (that omission is exactly what this function was
 * extracted for — it makes the mapping unit-testable without instantiating the
 * Nest graph). `labels?.tool` is guarded defensively; the package's tool wrapper
 * always sets it.
 *
 * Exported (not inlined in the onMetric closure) so mcp.service.spec can assert
 * the mapping directly. The isMetricsEnabled() gate stays at the CALL site: when
 * metrics are off, onMetric is undefined and the package skips even building the
 * label object.
 */
export function routeMcpMetric(
  name: string,
  value: number,
  labels?: Record<string, string>,
): void {
  if (name === 'mcp_tool_duration_seconds') {
    observeMcpTool(labels?.tool ?? 'other', value);
  } else if (name === 'collab_connect_timeouts_total') {
    incConnectTimeout();
  } else if (name === 'mcp_getpage_cache_hits_total') {
    incGetPageCacheHit();
  } else if (name === 'mcp_getpage_cache_misses_total') {
    incGetPageCacheMiss();
  } else if (name === 'mcp_download_bytes_total') {
    addMcpDownloadBytes(labels?.tool ?? 'other', value);
  } else if (name === 'mcp_ryow_live_total') {
    incMcpRyowLive();
  } else if (name === 'mcp_ryow_dbrow_total') {
    incMcpRyowDbrow(labels?.reason);
  } else if (name === 'mcp_ryow_expired_total') {
    incMcpRyowExpired();
  }
}

@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private handler: McpHttpHandler | null = null;
  private handlerPromise: Promise<McpHttpHandler> | null = null;

  constructor(
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly tokenService: TokenService,
    // Shared api-key row-check for the /mcp API_KEY Bearer branch (the same
    // validator REST uses). An agent authenticates to /mcp EXCLUSIVELY with a
    // Bearer api_key.
    private readonly apiKeyService: ApiKeyService,
    // Shared singleton in-RAM blob store backing the stash tool.
    private readonly sandboxStore: SandboxStore,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // Tear down any live loopback CollabSession providers at shutdown (#486). The
    // embedded MCP (and the in-app AI agent) open Hocuspocus collab sockets against
    // THIS process; without an explicit teardown those sessions keep their docs
    // "open" on the collab server and hold providers/buffers until they idle out,
    // so a restart can race a doc still pinned by the dying worker. Best-effort:
    // any failure is logged, never allowed to break shutdown.
    try {
      await this.destroyAllMcpSessions();
    } catch (err) {
      this.logger.error(
        'MCP CollabSession teardown on shutdown failed',
        err as Error,
      );
    }
  }

  /**
   * Resolve @docmost/mcp's `destroyAllSessions` and invoke it (#486). The live
   * CollabSession registry is a module-level singleton in the ESM package, shared
   * by every entry (`.`/`./http`), so this tears down ALL sessions regardless of
   * which surface opened them. The module is already loaded whenever MCP was used;
   * if it was never loaded (or is absent) the import + no-op is harmless.
   *
   * Held as an overridable field so a unit test can spy the teardown without
   * loading the ESM-only package or standing up the DI graph.
   */
  private destroyAllMcpSessions: () => Promise<void> = async () => {
    const entry = require.resolve('@docmost/mcp');
    const mod = (await esmImport(pathToFileURL(entry).href)) as {
      destroyAllSessions?: () => void;
    };
    mod.destroyAllSessions?.();
  };

  // The loopback base URL the embedded MCP uses to talk back to this Docmost
  // instance over REST + the collaboration WebSocket.
  private getApiUrl(): string {
    return (
      process.env.MCP_DOCMOST_API_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/api`
    );
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

  // Bearer verification for the /mcp token path. The Bearer slot accepts ONLY an
  // API_KEY token (an agent's key) — the allowlist is pinned to {API_KEY} in
  // bindMcpBearerVerifier. The key is HMAC-verified (microseconds) then
  // row-checked via the shared ApiKeyService.validate (the same validator REST
  // uses), so the MCP path is exactly as strong as the REST api-key path.
  private async verifyMcpBearer(
    token: string,
  ): Promise<{ sub?: string; email?: string }> {
    // Resolve THIS instance's workspace so the router can bind the token's
    // `workspaceId` claim to it (mirrors jwt.strategy). The community build is
    // single-workspace (findFirst), so this is the default workspace and the
    // check is a no-op here; it only rejects a foreign-workspace token in a
    // multi-workspace deployment. Undefined (no workspace configured) means no
    // check — validate would already reject a key with no matching workspace.
    const instanceWorkspace = await this.workspaceRepo.findFirst();
    // The type-routing + workspace-binding decision logic lives in the
    // framework-free verifyMcpBearer helper (unit-testable without the heavy auth
    // graph); this method only wires in the concrete TokenService + the shared
    // api-key validator.
    return verifyMcpBearer(token, {
      // The {API_KEY} allowlist enforcement lives in bindMcpBearerVerifier
      // (a pure, testable seam) so the type set cannot silently drift.
      verifyJwtOneOf: bindMcpBearerVerifier(this.tokenService),
      expectedWorkspaceId: instanceWorkspace?.id,
      // Shared with REST: a definite deny throws Unauthorized, an infra error
      // propagates (→ 5xx). The /mcp bearer catch must preserve that distinction.
      validateApiKey: (payload) =>
        this.apiKeyService.validate(payload as JwtApiKeyPayload),
    });
  }

  /**
   * Resolve the per-session identity from the request and produce the
   * DocmostMcpConfig the MCP package will run under, plus an opaque identity
   * key for anti-fixation. The decision logic lives in the framework-free
   * `resolveMcpSessionConfig` helper (so it is unit-testable without the heavy
   * auth graph); this method only wires McpService's injected collaborators in.
   *
   * /mcp accepts EXACTLY ONE credential: a Bearer api_key JWT. Throws
   * UnauthorizedException on failure (never a generic "MCP error"); never
   * logs/echoes the token or the Authorization header. Run BEFORE res.hijack()
   * so the 401 is clean JSON.
   */
  async resolveSessionConfig(req: FastifyRequest): Promise<ResolvedMcpAuth> {
    const authHeader = req.headers['authorization'] as string | undefined;
    return resolveMcpSessionConfig(authHeader, {
      apiUrl: this.getApiUrl(),
      findWorkspace: () => this.workspaceRepo.findFirst(),
      verifyAccessJwt: (token) => this.verifyMcpBearer(token),
    });
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
            // Inject the blob-sandbox sink after the auth decision so stashPage
            // can store blobs in the shared in-RAM store regardless of which
            // credential variant resolved. The sink (put/has/evict + uri↔id
            // mapping) is owned by SandboxStore.asSink().
            // Route the package's dependency-neutral metric samples onto the
            // prom-client registry (the closed mapping lives in routeMcpMetric,
            // above). When metrics are disabled, onMetric is undefined → the
            // package's tool-timer/timeout hooks are a negligible-overhead
            // no-op: the registerTool wrapper still runs a performance.now() +
            // async try/finally per tool call, but the `onMetric?.()`
            // short-circuits so no label/object is built. (Cost is immaterial at
            // LLM tool-call rate.)
            return {
              ...resolved.config,
              sandbox: this.sandboxStore.asSink(),
              onMetric: isMetricsEnabled() ? routeMcpMetric : undefined,
            };
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
        // A definite auth verdict (bad/expired/missing api_key) is a routine
        // 401 — do not log it here (the per-key deny observability lives in
        // ApiKeyService.validate). Only an UNEXPECTED (infra) error is logged.
        if (!(err instanceof UnauthorizedException)) {
          this.logger.error('MCP auth resolution failed', err as Error);
        }
      }
    }

    // RFC 6750 §3.1 — "if the request lacks any authentication information ... the
    // resource server SHOULD NOT include an error code". `error="invalid_token"` on
    // a request that sent NO credential (the common `claude mcp add` without
    // --header) would tell the client its token is bad when it never sent one.
    //
    // The two credentials are tracked SEPARATELY because the two 401 branches
    // challenge different ones: the shared-token 401 is about `X-MCP-Token`, the
    // api_key 401 about `Authorization`. Collapsing them into one flag would make a
    // request that sent only the api_key draw an `error="invalid_token"` about an
    // X-MCP-Token it never sent (and vice versa). isCredentialHeaderPresent also
    // reads a present-but-empty header as "no credential".
    const bearerPresented = isCredentialHeaderPresent(
      req.headers['authorization'],
    );
    const sharedTokenPresented = isCredentialHeaderPresent(
      req.headers['x-mcp-token'],
    );

    // Pure status/body mapping for the whole pre-hijack gauntlet.
    const decision = mapAuthResultToResponse({
      sharedTokenOk,
      enabled,
      error: authError,
      sharedTokenPresented,
      bearerPresented,
    });
    if (decision.kind === 'respond') {
      // #636 — a 401 carries the RFC 6750 challenge (WWW-Authenticate: Bearer ...)
      // so the client learns the accepted scheme instead of guessing OAuth.
      if (decision.headers) {
        for (const [name, value] of Object.entries(decision.headers)) {
          res.header(name, value);
        }
      }
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
