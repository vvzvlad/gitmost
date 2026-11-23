import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../../../core/auth/services/auth.service';
import SpaceAbilityFactory from '../../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../../core/casl/interfaces/space-ability.type';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { User } from '@docmost/db/types/entity.types';
import {
  parseBasicAuth,
  FailedLoginLimiter,
  clientIp,
  isCredentialsFailure,
} from './git-http-auth.helpers';
import {
  cachedWorkspaceLoader,
  resolveRequestWorkspace,
  WorkspaceLoader,
} from '../../../common/helpers/resolve-request-workspace';
import { EnvironmentService } from '../../environment/environment.service';
import { VaultRegistryService } from '../services/vault-registry.service';
import {
  GitSyncLockHeldError,
  GitSyncOrchestrator,
} from '../services/git-sync.orchestrator';
import { GitSyncRestrictionsService } from '../services/git-sync-restrictions.service';
import { GitHttpBackendService } from './git-http-backend.service';
import {
  decideGitHttpGate,
  parseGitPath,
  resolveServiceKind,
  GitHttpServiceKind,
} from './git-http.helpers';

const WWW_AUTHENTICATE = 'Basic realm="DozoR WIKI"';

/** The 403 body for a member of a space that contains restricted pages. */
const RESTRICTED_SPACE_MESSAGE =
  'Git sync is unavailable for spaces that contain pages with restricted access.';

/** `Name: message` of a thrown value, plus its `cause` when present (for logs). */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeText =
    cause === undefined
      ? ''
      : ` (cause: ${
          cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : String(cause)
        })`;
  return `${err.name}: ${err.message}${causeText}`;
}

/**
 * The /git smart-HTTP host. Wires request parsing, the reused auth primitives
 * (HTTP Basic -> AuthService.verifyUserCredentials), per-space gating
 * (EnvironmentService flags + space.settings.gitSync.enabled), CASL authz
 * (SpaceAbilityFactory), and dispatch to `git http-backend`:
 *   - fetch  (read)  -> ensureServable then stream http-backend directly (no lock).
 *   - push   (write) -> ensureServable then orchestrator.ingestExternalPush, which
 *     runs the receive-pack under the space lock and then a Docmost cycle.
 *
 * Mounted at the ROOT (`/git/...`) by a raw Fastify route in main.ts (the global
 * `/api` prefix does not apply). Never logs the password or Authorization header.
 */
@Injectable()
export class GitHttpService implements OnModuleDestroy {
  private readonly logger = new Logger(GitHttpService.name);

  /**
   * In-process brute-force speed bump for the /git HTTP-Basic path. The raw
   * `/git/*` Fastify route bypasses the Nest pipeline (so ThrottlerGuard, which is
   * only on controllers, never runs) and there is no fastify rate-limit plugin, so
   * without this `verifyUserCredentials` (bcrypt) would run unthrottled on every
   * request. Both keys are scoped to the client IP: per IP (one source's
   * guesses across all emails) and per IP+email. There is deliberately NO global
   * per-email key — it let anyone, from any IP, lock a victim out of git without
   * even reaching bcrypt. 5 failures per key per 60 s. A speed bump, not a hard
   * boundary (in-process, per replica).
   */
  private readonly failedLogins = new FailedLoginLimiter(5, 60_000);
  /** Periodic sweep of expired limiter buckets, to bound the limiter's memory. */
  private readonly sweepIntervalMs = 60_000;
  private readonly sweepTimer: NodeJS.Timeout;
  /** The cached workspace lookups, shared with DomainMiddleware. */
  private readonly workspaceLoader: WorkspaceLoader;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly authService: AuthService,
    private readonly spaceRepo: SpaceRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceAbilityFactory: SpaceAbilityFactory,
    private readonly vaultRegistry: VaultRegistryService,
    private readonly orchestrator: GitSyncOrchestrator,
    private readonly backend: GitHttpBackendService,
    private readonly restrictions: GitSyncRestrictionsService,
    @Inject(CACHE_MANAGER) cacheManager: Cache,
  ) {
    this.workspaceLoader = cachedWorkspaceLoader(cacheManager, workspaceRepo);
    this.sweepTimer = setInterval(() => {
      try {
        this.failedLogins.sweep();
      } catch (err) {
        this.logger.error('git-http failed-login limiter sweep failed', err as Error);
      }
    }, this.sweepIntervalMs);
    // Never keep the event loop alive solely for the sweep timer.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  /**
   * Resolve the workspace for a /git request with the SAME helper and cached
   * loader DomainMiddleware uses, because Nest middleware does NOT run for this
   * raw root-mounted route (it is registered under the global '/api' router), so
   * `req.raw.workspaceId` is never populated here. Returns just the id:
   *   - self-hosted (single workspace) -> the first/default workspace;
   *   - cloud (multi-tenant)           -> resolve by the host-header subdomain.
   * Returns null when no workspace resolves (credentials then cannot be
   * validated, so the gate answers 401). A lookup error is NOT caught here: the
   * caller answers it with a logged 500.
   */
  private async resolveWorkspaceId(
    req: FastifyRequest,
  ): Promise<string | null> {
    const workspace = await resolveRequestWorkspace(
      this.environmentService,
      this.workspaceLoader,
      this.headerValue(req.headers['host']),
    );
    return workspace?.id ?? null;
  }

  /**
   * Handle one `/git/<spaceId>.git/<subpath>` request. This raw root route runs
   * outside Nest's exception filter, so every unexpected throw — a DB
   * lookup, the vault preparation, the backend bridge — ends here in a logged
   * 500 instead of an unhandled rejection or, after `reply.hijack()`, a socket
   * left open.
   */
  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await this.serve(req, reply);
    } catch (err) {
      this.respondInternalError(
        reply,
        'the git request failed unexpectedly',
        err,
      );
    }
  }

  /**
   * Log an infrastructure failure in full and answer 500 with what failed,
   * through the Fastify reply when it is still ours, or on the raw response
   * after a hijack. Never throws. The 500 matters: a 401/404 for an
   * infrastructure failure would make git clients erase saved credentials or
   * hide the outage as a missing repository.
   */
  private respondInternalError(
    reply: FastifyReply,
    what: string,
    err: unknown,
  ): void {
    this.logger.error(
      `git-http: ${what}: ${describeError(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
    const body = `Internal server error: ${what} (details in the server log)`;
    try {
      // `reply.sent` is true once the reply was sent OR hijacked.
      if (!reply.sent) {
        reply.status(500).send(body);
        return;
      }
      const rawRes = reply.raw;
      if (!rawRes.headersSent) {
        rawRes.statusCode = 500;
        rawRes.setHeader('Content-Type', 'text/plain');
        rawRes.end(body);
      } else if (!rawRes.writableEnded) {
        rawRes.end();
      }
    } catch (sendErr) {
      this.logger.error(
        `git-http: failed to send the 500 response: ${describeError(sendErr)}`,
        sendErr instanceof Error ? sendErr.stack : undefined,
      );
    }
  }

  /**
   * Serve one request. `rest` is the path AFTER the `/git/` prefix (no query
   * string). The Fastify reply is hijacked before any streaming so the binary CGI
   * body is written directly to the raw socket.
   */
  private async serve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rawReq = req.raw;
    const rawRes = reply.raw;

    // --- parse the URL into spaceId + subpath -------------------------------
    const rest = this.extractRest(req.url);
    const parsedPath = rest === null ? null : parseGitPath(rest);

    // --- resolve the requested git service kind (read vs write) -------------
    // A duplicated `service` query parameter parses here as an array,
    // while git http-backend reads the raw query string itself — the authz
    // classification and the service that actually runs could disagree. Such a
    // request is refused (400 via the gate's bad-request) instead of guessed.
    const serviceParam: unknown =
      typeof req.query === 'object' && req.query !== null
        ? (req.query as Record<string, unknown>).service
        : undefined;
    const duplicateService = Array.isArray(serviceParam);
    const service = typeof serviceParam === 'string' ? serviceParam : undefined;
    const serviceKind: GitHttpServiceKind | null =
      parsedPath && !duplicateService
        ? resolveServiceKind({
            method: req.method,
            subpath: parsedPath.subpath,
            service,
          })
        : null;

    // --- authenticate (HTTP Basic) ------------------------------------------
    const authHeader = req.headers['authorization'];
    const basic = parseBasicAuth(
      Array.isArray(authHeader) ? authHeader[0] : authHeader,
    );
    // Resolve the workspace ourselves — DomainMiddleware does NOT run for this
    // raw root route, so `req.raw.workspaceId` is never set (see resolver doc).
    let workspaceId: string | null;
    try {
      workspaceId = await this.resolveWorkspaceId(req);
    } catch (err) {
      this.respondInternalError(
        reply,
        'could not resolve the workspace for this request',
        err,
      );
      return;
    }

    let user: User | undefined;
    let credentialsValid = false;
    let throttled = false;
    if (basic && workspaceId) {
      // Brute-force speed bump (both keys scoped to the client IP, see
      // `failedLogins`). Reserve BOTH keys ATOMICALLY and BEFORE bcrypt
      // (tryReserve folds the check and the increment into one synchronous
      // step), so the (threshold+1)-th attempt is rejected before
      // verifyUserCredentials/bcrypt ever runs and concurrent attempts cannot
      // all observe count=0. The reservation IS the recorded failure: a genuine
      // credential failure leaves it in place, a SUCCESS clears it (reset), a
      // non-credential error releases it (so it cannot burn a victim's budget).
      const emailLc = basic.email.toLowerCase();
      const ip = clientIp(req);
      const ipKey = `ip:${ip}`;
      const ipEmailKey = `ip-email:${ip}:${emailLc}`;
      const ipOk = this.failedLogins.tryReserve(ipKey);
      const ipEmailOk = this.failedLogins.tryReserve(ipEmailKey);
      if (!ipOk || !ipEmailOk) {
        // Blocked: release only the key we actually reserved this call so an
        // already-throttled request does not over-charge a key still under
        // budget. Do NOT run bcrypt.
        if (ipOk) this.failedLogins.release(ipKey);
        if (ipEmailOk) this.failedLogins.release(ipEmailKey);
        throttled = true;
      } else {
        try {
          user = await this.authService.verifyUserCredentials(
            { email: basic.email, password: basic.password },
            workspaceId,
          );
          credentialsValid = true;
          // Success: clear this client's per-IP and per-IP+email budgets.
          this.failedLogins.reset(ipKey);
          this.failedLogins.reset(ipEmailKey);
        } catch (err) {
          // Only a genuine credentials failure (wrong email/password) keeps the
          // reservation (it IS the recorded failure). Any other error is NOT a
          // password-guess signal, so release the reservation so it cannot burn
          // a victim's limiter budget.
          if (!isCredentialsFailure(err)) {
            this.failedLogins.release(ipKey);
            this.failedLogins.release(ipEmailKey);
          }
          if (
            err instanceof HttpException &&
            !(err instanceof UnauthorizedException) &&
            err.getStatus() < 500
          ) {
            // A client error the credential check raised on purpose (e.g. the
            // cloud email-not-verified 400): answer it with its own status and
            // message. Not a 401 — that is reserved for a credentials mismatch.
            this.logger.warn(
              `git-http: the credential check refused the request with ` +
                `${err.getStatus()}: ${err.message}`,
            );
            reply.status(err.getStatus()).send(err.message);
            return;
          }
          if (!(err instanceof UnauthorizedException)) {
            // Not a credentials rejection (e.g. a DB error): answer a logged
            // 500 — a 401 here would make git's credential helper erase the
            // user's saved password. The password/header is never logged.
            this.respondInternalError(
              reply,
              'could not verify the credentials',
              err,
            );
            return;
          }
          credentialsValid = false;
        }
      }
    }

    // Brute-force throttle tripped: reject BEFORE the gate (and before any space
    // lookup), so a throttled attacker gets a uniform 429 with no bcrypt and no
    // existence signal. WWW-Authenticate is still sent so a legitimate client
    // re-prompts after the window.
    if (throttled) {
      reply
        .header('WWW-Authenticate', WWW_AUTHENTICATE)
        .header('Retry-After', '60')
        .status(429)
        .send('Too many failed authentication attempts. Try again later.');
      return;
    }

    // --- resolve the space + per-space gating + CASL ------------------------
    let spaceExists = false;
    let spaceGitSyncEnabled = false;
    let spaceId: string | undefined;
    // The user has SOME role in the space. SECURITY: a non-member must get the
    // SAME 404 a missing/disabled space gets — never a 403 — or the 403↔404 split
    // would let any authenticated user brute-force slugs to learn which spaces
    // exist / have sync enabled (the leak this gate's contract forbids). 403 is
    // reserved for a MEMBER (existence already known): a space with restricted
    // pages, or a member who lacks the required role.
    let userIsSpaceMember = false;
    let spaceHasRestrictedPages = false;
    let permissionGranted = false;
    if (credentialsValid && user && workspaceId && parsedPath && serviceKind) {
      // A lookup failure here reaches handle()'s logged 500.
      const space = await this.spaceRepo.findById(
        parsedPath.spaceId,
        workspaceId,
      );
      if (space) {
        spaceExists = true;
        spaceId = space.id;
        spaceGitSyncEnabled =
          (space.settings as any)?.gitSync?.enabled === true;

        // Only evaluate CASL when the space is actually a sync candidate — an
        // unrelated space stays a 404 (existence is never revealed).
        if (spaceGitSyncEnabled) {
          let ability: Awaited<
            ReturnType<SpaceAbilityFactory['createForUser']>
          > | null = null;
          try {
            ability = await this.spaceAbilityFactory.createForUser(
              user,
              space.id,
            );
          } catch (err) {
            if (!(err instanceof NotFoundException)) {
              // An infrastructure failure is NOT "non-member": answering the
              // non-member 404 would hide the outage. Logged 500.
              this.respondInternalError(
                reply,
                'could not check the space membership',
                err,
              );
              return;
            }
            // createForUser throws NotFoundException when the user has no role in
            // the space (a non-member). Leave userIsSpaceMember=false so the gate
            // returns 404, NOT 403 — a non-member must not be able to tell this
            // space apart from a non-existent one.
          }
          if (ability) {
            // createForUser RESOLVED -> the user holds a role in this space.
            // Record membership BEFORE the permission check: a member lacking the
            // role -> 403; a non-member -> 404 (userIsSpaceMember=false).
            userIsSpaceMember = true;
            // Git-sync refuses spaces with page-level restrictions. Only a member
            // gets this far, so the 403 it leads to reveals nothing new; a
            // lookup failure reaches handle()'s logged 500.
            spaceHasRestrictedPages =
              await this.restrictions.spaceHasRestrictedPages(
                space.id,
                workspaceId,
              );
            const action =
              serviceKind === 'write'
                ? SpaceCaslAction.Manage
                : SpaceCaslAction.Read;
            permissionGranted = ability.can(action, SpaceCaslSubject.Page);
          }
        }
      }
    }

    // --- the gate decision (pure) -------------------------------------------
    const decision = decideGitHttpGate({
      hasCredentials: Boolean(basic),
      credentialsValid,
      serviceKind,
      spaceExists,
      spaceGitSyncEnabled,
      userIsSpaceMember,
      spaceHasRestrictedPages,
      permissionGranted,
    });

    if (decision.kind === 'unauthorized') {
      reply
        .header('WWW-Authenticate', WWW_AUTHENTICATE)
        .status(401)
        .send('Authentication required');
      return;
    }
    if (decision.kind === 'bad-request') {
      reply
        .status(400)
        .send(
          duplicateService
            ? "Bad request: the 'service' query parameter must appear once"
            : 'Bad request',
        );
      return;
    }
    if (decision.kind === 'not-found') {
      reply.status(404).send('Not found');
      return;
    }
    if (decision.kind === 'restricted') {
      reply.status(403).send(RESTRICTED_SPACE_MESSAGE);
      return;
    }
    if (decision.kind === 'forbidden') {
      reply.status(403).send('Forbidden');
      return;
    }

    // decision.kind === 'proceed' — guaranteed below (narrowing for TS).
    if (!parsedPath || !serviceKind || !spaceId || !user || !workspaceId) {
      // Defensive: 'proceed' implies these are set, but keep TS + runtime safe.
      reply.status(500).send('Internal server error');
      return;
    }

    // --- dispatch to git http-backend ---------------------------------------
    const backendRequest = {
      spaceId,
      subpath: parsedPath.subpath,
      method: req.method,
      queryString: this.extractQueryString(req.url),
      contentType: this.headerValue(req.headers['content-type']) ?? '',
      gitProtocol: this.headerValue(req.headers['git-protocol']),
      // Forward Content-Encoding so http-backend inflates gzip'd RPC bodies
      // (review #4) — else a non-trivial `git pull` fails with expected 'packfile'.
      contentEncoding: this.headerValue(req.headers['content-encoding']),
      remoteUser: user.email,
    };

    try {
      // Idempotently make the vault servable (repo + receive/upload config).
      await this.vaultRegistry.ensureServable(spaceId);
    } catch (err) {
      this.respondInternalError(
        reply,
        `could not prepare the git repository of space ${spaceId}`,
        err,
      );
      return;
    }

    // Hijack the reply so the backend can stream the raw (possibly binary) CGI
    // response directly to the socket (mirrors the MCP transport pattern).
    reply.hijack();

    // Only the ACTUAL pack-receiving write (POST git-receive-pack) runs under the
    // space lock + a Docmost cycle. Everything else streams the http-backend
    // directly with NO lock and NO cycle: a fetch/clone (read), AND the
    // write-AUTHORIZED but READ-ONLY ref advertisement
    // (GET info/refs?service=git-receive-pack). Running a cycle on info/refs is
    // both wasteful and HARMFUL — it holds the per-space lock, so the push's
    // immediately-following POST git-receive-pack collides with it and 503s
    // (a deterministic push failure). Authz already happened above via the gate.
    const isReceivePack =
      req.method === 'POST' && parsedPath.subpath === 'git-receive-pack';
    if (serviceKind === 'read' || !isReceivePack) {
      await this.backend.run(backendRequest, rawReq, rawRes);
      return;
    }

    // Push: run the receive-pack under the space lock, then a Docmost cycle.
    try {
      await this.orchestrator.ingestExternalPush(
        spaceId,
        workspaceId,
        // The lock's lost-lock signal is threaded into the backend so the
        // receive-pack child is killed if the lock lapses mid-write.
        (signal) => this.backend.run(backendRequest, rawReq, rawRes, signal),
      );
    } catch (err) {
      if (err instanceof GitSyncLockHeldError) {
        // The lock could not be acquired and the receive-pack never ran, so the
        // response is still unwritten — answer 503 so git retries.
        if (!rawRes.headersSent) {
          rawRes.statusCode = 503;
          rawRes.setHeader('Content-Type', 'text/plain');
          rawRes.setHeader('Retry-After', '1');
        }
        try {
          rawRes.end('git-sync busy, retry');
        } catch {
          /* ignore */
        }
        return;
      }
      // Any other error: the receive-pack closure handles its own response, so
      // we only log here and make sure the socket is closed. An error before the
      // receive-pack (the vault preparation) has written nothing yet: answer 500.
      this.respondInternalError(
        reply,
        `the push ingestion of space ${spaceId} failed`,
        err,
      );
    }
  }

  /** Normalise a possibly-array header value to its first string. */
  private headerValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
  }

  /**
   * Extract the part of the URL AFTER `/git/` and BEFORE the query string.
   * Returns null when the URL is not under `/git/`.
   */
  private extractRest(url: string): string | null {
    const qIdx = url.indexOf('?');
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const prefix = '/git/';
    if (!pathname.startsWith(prefix)) return null;
    return pathname.slice(prefix.length);
  }

  /** The raw query string without the leading '?', or '' when none. */
  private extractQueryString(url: string): string {
    const qIdx = url.indexOf('?');
    return qIdx === -1 ? '' : url.slice(qIdx + 1);
  }
}
