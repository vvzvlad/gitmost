import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
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
import { resolveRequestWorkspace } from '../../../common/helpers/resolve-request-workspace';
import { EnvironmentService } from '../../environment/environment.service';
import { VaultRegistryService } from '../services/vault-registry.service';
import {
  GitSyncLockHeldError,
  GitSyncOrchestrator,
} from '../services/git-sync.orchestrator';
import { GitHttpBackendService } from './git-http-backend.service';
import {
  decideGitHttpGate,
  parseGitPath,
  resolveServiceKind,
  GitHttpServiceKind,
} from './git-http.helpers';

const WWW_AUTHENTICATE = 'Basic realm="gitmost"';

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
   * request once GIT_SYNC_HTTP_ENABLED is on. Mirrors the /mcp Basic path EXACTLY
   * (FailedLoginLimiter, same 5/60s thresholds, the same per-IP / per-IP+email /
   * global-per-email keys) so the two auth seams cannot diverge. A speed bump, not
   * a hard boundary (in-process, per replica).
   */
  private readonly failedLogins = new FailedLoginLimiter(5, 60_000);
  /** Periodic sweep to bound limiter memory (mirrors McpService / mcp http.ts). */
  private readonly sweepIntervalMs = 60_000;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly authService: AuthService,
    private readonly spaceRepo: SpaceRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceAbilityFactory: SpaceAbilityFactory,
    private readonly vaultRegistry: VaultRegistryService,
    private readonly orchestrator: GitSyncOrchestrator,
    private readonly backend: GitHttpBackendService,
  ) {
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
   * Resolve the workspace for a /git request the SAME way DomainMiddleware does,
   * because Nest middleware does NOT run for this raw root-mounted route (it is
   * registered under the global '/api' router), so `req.raw.workspaceId` is never
   * populated here. Delegates to the shared `resolveRequestWorkspace` helper (the
   * SAME self-hosted/cloud branch DomainMiddleware uses) and returns just the id:
   *   - self-hosted (single workspace) -> workspaceRepo.findFirst();
   *   - cloud (multi-tenant)           -> resolve by the host-header subdomain.
   * Returns null when no workspace resolves; the gate then 404s (after the
   * 401-before-404 credential check encoded in decideGitHttpGate).
   */
  private async resolveWorkspaceId(req: FastifyRequest): Promise<string | null> {
    try {
      // Same self-hosted/cloud resolution DomainMiddleware uses — shared so the
      // branch cannot drift between the two call sites.
      const workspace = await resolveRequestWorkspace(
        this.environmentService,
        this.workspaceRepo,
        this.headerValue(req.headers['host']),
      );
      return workspace?.id ?? null;
    } catch (err) {
      // A DB error resolving the workspace must not leak details; treat as
      // unresolvable (the gate will 404, unless creds are missing -> 401 first).
      this.logger.warn(
        `git-http: workspace resolution error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return null;
  }

  /**
   * Handle one `/git/<spaceId>.git/<subpath>` request. `rest` is the path AFTER
   * the `/git/` prefix (no query string). The Fastify reply is hijacked before
   * any streaming so the binary CGI body is written directly to the raw socket.
   */
  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rawReq = req.raw;
    const rawRes = reply.raw;

    // --- parse the URL into spaceId + subpath -------------------------------
    const rest = this.extractRest(req.url);
    const parsedPath = rest === null ? null : parseGitPath(rest);

    // --- resolve the requested git service kind (read vs write) -------------
    const service =
      typeof req.query === 'object' && req.query !== null
        ? (req.query as Record<string, string | undefined>).service
        : undefined;
    const serviceKind: GitHttpServiceKind | null = parsedPath
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
    const workspaceId: string | null = await this.resolveWorkspaceId(req);

    let user: User | undefined;
    let credentialsValid = false;
    let throttled = false;
    if (basic && workspaceId) {
      // Brute-force speed bump, mirroring the /mcp Basic path EXACTLY. Reserve
      // ALL three keys ATOMICALLY and BEFORE bcrypt (tryReserve folds the check
      // and the increment into one synchronous step), so the (threshold+1)-th
      // attempt is rejected before verifyUserCredentials/bcrypt ever runs and
      // concurrent attempts for one email cannot all observe count=0. The
      // reservation IS the recorded failure: a genuine credential failure leaves
      // it in place, a SUCCESS clears it (reset), a non-credential error releases
      // it (so it cannot burn a victim's budget).
      const emailLc = basic.email.toLowerCase();
      const ip = clientIp(req);
      const ipKey = `ip:${ip}`;
      const ipEmailKey = `ip-email:${ip}:${emailLc}`;
      // GLOBAL per-email backstop (no IP): the only key that survives IP / XFF
      // rotation, so it is the real account-brute defense (see mcp-auth.helpers).
      const emailKey = `email:${emailLc}`;
      const ipOk = this.failedLogins.tryReserve(ipKey);
      const ipEmailOk = this.failedLogins.tryReserve(ipEmailKey);
      const emailOk = this.failedLogins.tryReserve(emailKey);
      if (!ipOk || !ipEmailOk || !emailOk) {
        // Blocked: release only the keys we actually reserved this call so an
        // already-throttled request does not over-charge keys still under budget
        // (matches the /mcp reserve model). Do NOT run bcrypt.
        if (ipOk) this.failedLogins.release(ipKey);
        if (ipEmailOk) this.failedLogins.release(ipEmailKey);
        if (emailOk) this.failedLogins.release(emailKey);
        throttled = true;
      } else {
        try {
          user = await this.authService.verifyUserCredentials(
            { email: basic.email, password: basic.password },
            workspaceId,
          );
          credentialsValid = true;
          // Success: clear the per-IP and per-IP+email budgets fully; for the
          // GLOBAL per-email key only release the one increment THIS request took
          // (do not reset() it, or a victim's own success would wipe a parallel
          // attacker's accumulated failures for that email — same rule as /mcp).
          this.failedLogins.reset(ipKey);
          this.failedLogins.reset(ipEmailKey);
          this.failedLogins.release(emailKey);
        } catch (err) {
          // Only a genuine credentials failure (wrong email/password) keeps the
          // reservation (it IS the recorded failure). Any other error — DB error,
          // etc. — is NOT a password-guess signal, so release the reservation so
          // it cannot burn a victim's limiter budget. credentialsValid stays
          // false either way (the gate then 401s).
          if (!isCredentialsFailure(err)) {
            this.failedLogins.release(ipKey);
            this.failedLogins.release(ipEmailKey);
            this.failedLogins.release(emailKey);
          }
          if (!(err instanceof UnauthorizedException)) {
            // A non-credential failure (e.g. DB error): treat as invalid creds
            // for the gate (a 401), and log without leaking the password/header.
            this.logger.warn(
              `git-http: credential check error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
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
    // reserved for a MEMBER who lacks the required role (existence already known).
    let userIsSpaceMember = false;
    let permissionGranted = false;
    if (credentialsValid && user && workspaceId && parsedPath && serviceKind) {
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
          try {
            const ability = await this.spaceAbilityFactory.createForUser(
              user,
              space.id,
            );
            // createForUser RESOLVED -> the user holds a role in this space (it
            // throws NotFound for a non-member). Record membership BEFORE the
            // permission check: a member lacking the role -> 403; a non-member ->
            // 404 (handled by the gate via userIsSpaceMember=false below).
            userIsSpaceMember = true;
            const action =
              serviceKind === 'write'
                ? SpaceCaslAction.Manage
                : SpaceCaslAction.Read;
            permissionGranted = ability.can(action, SpaceCaslSubject.Page);
          } catch {
            // createForUser throws NotFoundException when the user has no role in
            // the space (a non-member). Leave userIsSpaceMember=false so the gate
            // returns 404, NOT 403 — a non-member must not be able to tell this
            // space apart from a non-existent one. (Any other error also falls
            // here and is treated as non-member -> 404, the safe default that
            // never reveals existence.)
            userIsSpaceMember = false;
            permissionGranted = false;
          }
        }
      }
    }

    // --- the gate decision (pure) -------------------------------------------
    const decision = decideGitHttpGate({
      hasCredentials: Boolean(basic),
      credentialsValid,
      serviceKind,
      gitSyncEnabled: this.environmentService.isGitSyncEnabled(),
      gitHttpEnabled: this.environmentService.isGitSyncHttpEnabled(),
      spaceExists,
      spaceGitSyncEnabled,
      userIsSpaceMember,
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
      reply.status(400).send('Bad request');
      return;
    }
    if (decision.kind === 'not-found') {
      reply.status(404).send('Not found');
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
      this.logger.error(
        `git-http: failed to prepare vault for space ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (!reply.sent) reply.status(500).send('Internal server error');
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
      // The clone's default branch comes from the HEAD symref advertised by the
      // upload-pack ref advertisement (or a dumb `GET HEAD`). The engine
      // transiently checks out the read-only `docmost` mirror mid-cycle, so serve
      // THAT advertisement with HEAD pinned to `main` under the per-space lock so
      // a clone never defaults to `docmost` (bug #3). Pack streaming and every
      // other read are resolved by object SHA and need no pin, so they stream
      // directly (no lock) as before.
      const isReadAdvertise =
        req.method === 'GET' &&
        ((parsedPath.subpath === 'info/refs' &&
          service === 'git-upload-pack') ||
          parsedPath.subpath === 'HEAD');
      if (isReadAdvertise) {
        // The read-advertise path runs under the space lock (to pin HEAD=main).
        // AFTER reply.hijack() Fastify no longer manages this response, so a
        // rejection here (e.g. SpaceLockService.acquire when Redis is down) would
        // otherwise leave the socket open forever — every clone/fetch hangs until
        // the client times out (review #5). Mirror the push branch: catch, answer
        // 500 if nothing was written yet, and always end the raw socket.
        try {
          await this.orchestrator.serveReadAdvertisement(spaceId, () =>
            this.backend.run(backendRequest, rawReq, rawRes),
          );
        } catch (err) {
          this.logger.error(
            `git-sync: read advertisement failed for space ${spaceId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (!rawRes.headersSent) {
            rawRes.statusCode = 500;
            rawRes.setHeader('Content-Type', 'text/plain');
            rawRes.end('Internal server error');
          } else if (!rawRes.writableEnded) {
            rawRes.end();
          }
        }
      } else {
        await this.backend.run(backendRequest, rawReq, rawRes);
      }
      return;
    }

    // Push: run the receive-pack under the space lock, then a Docmost cycle.
    try {
      await this.orchestrator.ingestExternalPush(
        spaceId,
        workspaceId,
        // The lock's lost-lock signal is threaded into the backend so the
        // receive-pack child is killed if the lock lapses mid-write (warning #3).
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
      // we only log here and make sure the socket is closed.
      this.logger.error(
        `git-http: push ingestion error for space ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      try {
        if (!rawRes.writableEnded) rawRes.end();
      } catch {
        /* ignore */
      }
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
