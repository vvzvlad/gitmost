// Pure, self-contained helpers for the embedded /mcp per-user auth flow. They
// are deliberately framework-free (no Nest, no DI, no concrete service imports)
// so they can be unit-tested in isolation WITHOUT loading the heavy auth/space
// dependency graph, and reused by McpService. Nothing here logs the password or
// the Authorization header.
import { UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { CREDENTIALS_MISMATCH_MESSAGE } from '../../core/auth/auth.constants';

/**
 * Decode an `Authorization: Basic base64(email:password)` header into its
 * email/password parts. The split is on the FIRST ':' because a password may
 * itself contain ':' characters (everything after the first ':' is the
 * password). Returns null when the header is absent or not a Basic header, or
 * when no ':' separator is present (malformed credentials).
 */
export function parseBasicAuth(
  authHeader: string | undefined,
): { email: string; password: string } | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  const b64 = authHeader.slice('Basic '.length).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null; // no separator -> not valid email:password
  const email = decoded.slice(0, sep);
  if (!email) return null; // empty email -> not valid credentials
  return {
    email,
    password: decoded.slice(sep + 1),
  };
}

/**
 * Lightweight in-memory, per-key fixed-window rate limiter for FAILED /mcp
 * Basic logins. Calling AuthService.login directly bypasses the controller's
 * ThrottlerGuard, so this blunts brute-force attempts against /mcp. State lives
 * in-process (per server instance); it is intentionally simple and not shared
 * across a cluster — it is a speed bump, not a hard security boundary.
 *
 * A key is typically `<ip>` and/or `<ip>:<email>`. When the number of failures
 * within `windowMs` reaches `threshold`, `isBlocked` returns true until the
 * window rolls over. A SUCCESSFUL login should clear the key via `reset`.
 */
export class FailedLoginLimiter {
  private readonly windowMs: number;
  private readonly threshold: number;
  // key -> { count, windowStart }
  private readonly buckets = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(threshold = 5, windowMs = 60_000) {
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  private bucket(key: string, now: number) {
    const existing = this.buckets.get(key);
    if (!existing || now - existing.windowStart >= this.windowMs) {
      const fresh = { count: 0, windowStart: now };
      this.buckets.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  /** True when the key has already reached the failure threshold this window. */
  isBlocked(key: string, now: number = Date.now()): boolean {
    const b = this.bucket(key, now);
    return b.count >= this.threshold;
  }

  /** Record one failed attempt for the key (within the current window). */
  recordFailure(key: string, now: number = Date.now()): void {
    const b = this.bucket(key, now);
    b.count += 1;
  }

  /**
   * Atomic check-and-reserve: if the key is already at/over the threshold this
   * window, return false (blocked). Otherwise count this in-flight attempt
   * (count += 1) and return true. Being synchronous, concurrent callers cannot
   * interleave between the check and the increment, so the (threshold+1)-th
   * concurrent attempt is rejected even before its bcrypt runs.
   *
   * This is the brute-force fix for the /mcp Basic path: the increment happens
   * BEFORE the async credential check, not after it, so N concurrent requests for
   * one email cannot all observe count=0 and all run bcrypt. A failed login then
   * leaves the reservation in place (it IS the recorded failure); a SUCCESSFUL
   * login clears it via reset(); a non-credential business error releases it via
   * release() so it does not count as a guessed-password signal.
   */
  tryReserve(key: string, now: number = Date.now()): boolean {
    const b = this.bucket(key, now);
    if (b.count >= this.threshold) return false;
    b.count += 1;
    return true;
  }

  /**
   * Undo a previous tryReserve for the key within the same window (count -= 1,
   * floored at 0). Used to release an optimistic in-flight reservation when the
   * attempt turned out NOT to be a password-guess signal (e.g. an "email not
   * verified" business error), so it does not burn a victim's limiter budget.
   * A no-op if the bucket rolled over to a fresh window in the meantime.
   */
  release(key: string, now: number = Date.now()): void {
    const b = this.bucket(key, now);
    if (b.count > 0) b.count -= 1;
  }

  /** Clear the key after a successful login so it does not accumulate. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop expired buckets to bound memory. Safe to call periodically. */
  sweep(now: number = Date.now()): void {
    for (const [key, b] of this.buckets) {
      if (now - b.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }
}

// The per-session DocmostMcpConfig shape understood by @docmost/mcp: either the
// service-account credentials variant OR the per-user getToken variant.
export type DocmostMcpConfig =
  | { apiUrl: string; email: string; password: string }
  | { apiUrl: string; getToken: () => Promise<string> };

export interface ResolvedMcpAuth {
  config: DocmostMcpConfig;
  // Opaque identity key bound to the MCP session for anti-fixation, or
  // undefined when no per-user identity applies.
  identity?: string;
}

// Narrow collaborator interfaces so this module never imports the concrete
// AuthService/TokenService/WorkspaceRepo classes (which drag in the heavy
// auth/space graph). McpService passes its injected instances; tests pass
// stubs. Decouples the testable decision logic from Nest DI wiring.
export interface McpAuthDeps {
  apiUrl: string;
  email?: string;
  password?: string;
  findWorkspace: () => Promise<{ id: string } | undefined>;
  // Pre-token gate for the Basic path ONLY, replicating what AuthController.login
  // does BEFORE issuing a token: validateSsoEnforcement(workspace) and the lazy
  // EE MFA requirement check. It is invoked with the resolved (default)
  // workspace right after it is loaded and BEFORE any login()/verifyCredentials()
  // call, so an SSO-enforced workspace or an MFA-required user never gets a token
  // via /mcp Basic. It MUST throw (UnauthorizedException) to reject; on a fork
  // without the EE MFA module bundled it behaves exactly like the controller
  // (no MFA module -> no MFA gate). The Bearer path skips this gate because those
  // ACCESS JWTs were already minted post-gate by the normal controller login.
  // Optional so existing callers/tests that don't exercise the gate are unchanged.
  enforceBasicGate?: (
    workspace: { id: string },
    creds: { email: string; password: string },
  ) => Promise<void> | void;
  // Full login: mints a user session + JWT, writes the USER_LOGIN audit event
  // and updates lastLoginAt. Called at MOST once per MCP session (at the
  // session-init request) so we do not spam the audit log / user_sessions table
  // on every tool call.
  login: (
    creds: { email: string; password: string },
    workspaceId: string,
  ) => Promise<string>;
  // Non-side-effecting credential check: same lookup/password/email-verified/
  // disabled checks as login() but mints NO session, writes NO audit row,
  // updates NO lastLoginAt. Used for per-request anti-fixation re-validation on
  // SUBSEQUENT requests so a correct repeat does not spawn a new DB session,
  // while a wrong password still throws (preserving anti-fixation).
  verifyCredentials: (
    creds: { email: string; password: string },
    workspaceId: string,
  ) => Promise<void>;
  // Bearer access-JWT verification. Verifies signature/exp/type AND (in the
  // McpService wiring) session-active + user-not-disabled, mirroring JwtStrategy
  // so a revoked/logged-out/disabled user with an unexpired token is rejected.
  verifyAccessJwt: (token: string) => Promise<{ sub?: string; email?: string }>;
  limiter: FailedLoginLimiter;
  clientIp: string;
  // True when this is the session-INIT request (no mcp-session-id header).
  // INIT mints a user session via login(); SUBSEQUENT requests only re-validate
  // credentials via verifyCredentials() (no side effects). See resolveMcp...
  isSessionInit: boolean;
}

/**
 * True when an error from login()/verifyCredentials() represents an actual
 * CREDENTIALS failure (unknown email, disabled user, or wrong password) — i.e.
 * a guessed-password signal that should count toward the brute-force limiter.
 *
 * It must NOT match business errors like "email not verified" (a
 * BadRequestException), which are a legitimate 401/400 surface but not a
 * password-guess signal — counting those would let an attacker burn a victim's
 * limiter budget (DoS) and would dilute the brute-force signal. AuthService
 * throws an UnauthorizedException with exactly this message for every
 * credentials-mismatch case (no user / disabled / wrong password), so we match
 * on that.
 *
 * The message is NOT hardcoded here: it matches against the shared
 * CREDENTIALS_MISMATCH_MESSAGE constant that AuthService.verifyUserCredentials
 * also throws, so a reworded auth error cannot silently stop counting toward the
 * limiter (single source of truth — see auth.constants.ts).
 */
export function isCredentialsFailure(err: unknown): boolean {
  return (
    err instanceof UnauthorizedException &&
    typeof err.message === 'string' &&
    err.message
      .toLowerCase()
      .includes(CREDENTIALS_MISMATCH_MESSAGE.toLowerCase())
  );
}

/**
 * Constant-time comparison of the optional shared X-MCP-Token guard. A header
 * value may arrive as string | string[] (multiple X-MCP-Token headers), so we
 * normalise to the first string. crypto.timingSafeEqual avoids leaking the
 * token's length via early-exit string comparison; it requires equal buffer
 * lengths, so a length mismatch is treated as a non-match WITHOUT calling
 * timingSafeEqual (which throws on unequal lengths). A non-string / undefined
 * value is never a match.
 *
 * Pure and framework-free so it is unit-testable; McpService.handle delegates to
 * it for the X-MCP-Token shared guard.
 */
export function sharedTokenMatches(
  expected: string,
  provided: string | string[] | undefined,
): boolean {
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  // Early-return before timingSafeEqual, which throws on unequal-length buffers.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Minimal structural shape of the bits of a Fastify request that `clientIp`
// needs. Kept structural so this module never imports the Fastify types.
export interface ClientIpRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Best-effort client IP for the failed-login limiter key. Precedence:
 *   1. req.ip          — Fastify's resolved IP (honours a configured trustProxy
 *                        chain); the trustworthy value when a proxy is set up.
 *   2. socket.remoteAddress — the raw TCP peer, used only when req.ip is absent.
 *   3. first X-Forwarded-For hop — LAST resort only, because XFF is
 *                        client-forgeable when no trusted proxy is configured.
 *   4. 'unknown'       — nothing usable.
 *
 * A forged IP can only dodge the per-IP limiter keys; the GLOBAL per-email key
 * in resolveMcpSessionConfig is the real account-brute backstop and does not
 * depend on this value. Pure/framework-free so it is unit-testable; McpService
 * delegates to it.
 */
export function clientIp(req: ClientIpRequest): string {
  if (req.ip) return req.ip;
  if (req.socket?.remoteAddress) return req.socket.remoteAddress;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return 'unknown';
}

// Minimal structural shape of the TokenService.verifyJwt method we depend on,
// so this module never imports the concrete TokenService (heavy graph).
export interface AccessJwtVerifier {
  verifyJwt: (
    token: string,
    type: JwtType,
  ) => Promise<{
    sub?: string;
    email?: string;
    workspaceId?: string;
    sessionId?: string;
  }>;
}

/**
 * Bind a TokenService-like verifier into a one-arg `verifyJwt(token)` that
 * ALWAYS enforces `JwtType.ACCESS`. This is the single place where the /mcp
 * Bearer path pins the token type: a Bearer access token must be verified AS an
 * access token (not refresh/exchange/collab/etc.), so the type literal is fixed
 * here rather than at the call site. McpService.verifyMcpBearer delegates to
 * this, keeping the `JwtType.ACCESS` choice testable without the heavy graph.
 */
export function bindAccessJwtVerifier(
  tokenService: AccessJwtVerifier,
): (token: string) => Promise<{
  sub?: string;
  email?: string;
  workspaceId?: string;
  sessionId?: string;
}> {
  return (token: string) => tokenService.verifyJwt(token, JwtType.ACCESS);
}

// Minimal shapes for the Bearer revocation/disabled check. Kept structural so
// this module never imports the concrete repos/JwtPayload (heavy graph).
export interface BearerVerifyDeps {
  // Verify signature/exp and that type === ACCESS; returns the decoded payload.
  verifyJwt: (
    token: string,
  ) => Promise<{
    sub?: string;
    email?: string;
    workspaceId?: string;
    sessionId?: string;
  }>;
  // The workspace id of THIS MCP instance, when the caller can resolve it (the
  // community build is single-workspace, so McpService passes its default
  // workspace's id). When provided, the token's `workspaceId` claim MUST equal
  // it, mirroring JwtStrategy's `req.raw.workspaceId !== payload.workspaceId`
  // guard so a valid ACCESS token from a DIFFERENT workspace cannot be replayed
  // against this instance in a multi-workspace deployment. Optional so callers /
  // tests that genuinely cannot resolve an instance workspace are unchanged.
  expectedWorkspaceId?: string;
  // Load the user (or undefined) for the disabled check.
  findUser: (
    sub: string,
    workspaceId: string,
  ) => Promise<{ deactivatedAt?: Date | null; deletedAt?: Date | null } | undefined>;
  // Load an ACTIVE (not revoked, not expired) session by id, or undefined.
  findActiveSession: (
    sessionId: string,
  ) => Promise<{ userId: string; workspaceId: string } | undefined>;
}

/**
 * Verify a /mcp Bearer access JWT to the SAME strength as JwtStrategy: not just
 * signature/exp/type (verifyJwt), but also that the user is not disabled and —
 * when the token carries a sessionId — that the session is still active and
 * belongs to that user+workspace. This rejects a logged-out/revoked or disabled
 * user who still holds an unexpired access token. Throws UnauthorizedException
 * on any failure; never leaks why (uniform "Invalid or expired token").
 */
export async function verifyBearerAccess(
  token: string,
  deps: BearerVerifyDeps,
): Promise<{ sub?: string; email?: string }> {
  const generic = 'Invalid or expired token';
  const payload = await deps.verifyJwt(token);

  if (!payload.sub || !payload.workspaceId) {
    throw new UnauthorizedException(generic);
  }

  // Bind the token to THIS instance's workspace (mirrors JwtStrategy). When the
  // caller resolved an instance workspace id, a token whose `workspaceId` claim
  // points at another workspace is rejected, so a valid ACCESS token minted in
  // workspace B cannot be replayed against an MCP instance serving workspace A.
  // In the single-workspace community build expectedWorkspaceId equals the only
  // workspace, so this is a no-op there; it only bites a multi-workspace deploy.
  if (
    deps.expectedWorkspaceId &&
    payload.workspaceId !== deps.expectedWorkspaceId
  ) {
    throw new UnauthorizedException(generic);
  }

  const user = await deps.findUser(payload.sub, payload.workspaceId);
  if (!user || user.deactivatedAt || user.deletedAt) {
    throw new UnauthorizedException(generic);
  }

  if (payload.sessionId) {
    const session = await deps.findActiveSession(payload.sessionId);
    if (
      !session ||
      session.userId !== payload.sub ||
      session.workspaceId !== payload.workspaceId
    ) {
      throw new UnauthorizedException(generic);
    }
  }

  return { sub: payload.sub, email: payload.email };
}

/**
 * Detect a genuine JSON-RPC `initialize` request from an already-parsed body.
 * Delegates to the @modelcontextprotocol/sdk `isInitializeRequest` predicate —
 * the SAME predicate packages/mcp/src/http.ts uses to decide whether to mint a
 * session — so the session-minting side (this server) and the session-creating
 * side (http.ts) agree EXACTLY on what counts as an initialize request. The SDK
 * predicate validates the full InitializeRequest shape (jsonrpc, id, method ===
 * 'initialize', params incl. protocolVersion); a bare `{ method: 'initialize' }`
 * with no params, a batch (array) body, etc. are NOT initialize requests.
 *
 * This is the second half of the session-INIT decision: `isSessionInit` is
 * (no `mcp-session-id` header) AND `isInitializeRequestBody(body)`. Matching the
 * SDK predicate exactly ensures the side-effecting login() (user_sessions insert
 * + USER_LOGIN audit + lastLoginAt) only runs for a request http.ts will also
 * accept as an initialize — never for an arbitrary header-less request that
 * http.ts would subsequently 400 (which would otherwise spam the audit log /
 * grow user_sessions without ever creating an MCP session).
 */
export function isInitializeRequestBody(body: unknown): boolean {
  return isInitializeRequest(body);
}

/**
 * The outcome of McpService.handle's pre-hijack gauntlet, as a pure value the
 * caller acts on. Either send a JSON error with a fixed status (`respond`), or
 * proceed to hijack the response and delegate to the MCP transport (`hijack`).
 * Keeping this a pure decision (no FastifyReply, no res.hijack) makes the
 * status/body mapping unit-testable, and guarantees no error path can leak the
 * password or Authorization header — the body is only ever a fixed string or the
 * UnauthorizedException's own message.
 */
export type McpHandleDecision =
  | { kind: 'respond'; status: number; body: { error: string } }
  | { kind: 'hijack' };

/**
 * Pure mapping of McpService.handle's auth/enablement gauntlet to a response
 * decision. Precedence mirrors handle():
 *   1. shared X-MCP-Token mismatch -> 401 {error:'Unauthorized'} (no hijack).
 *   2. workspace MCP disabled      -> 403 {error:'MCP is disabled ...'}.
 *   3. resolveSessionConfig threw:
 *        - an UnauthorizedException -> 401 with err.message (a SPECIFIC reason;
 *          never the password/header — the message is the only thing surfaced).
 *        - any other error          -> 500 generic 'Internal server error'.
 *   4. otherwise (auth resolved)   -> hijack and delegate to the transport.
 */
export function mapAuthResultToResponse(input: {
  sharedTokenOk: boolean;
  enabled: boolean;
  error?: unknown;
}): McpHandleDecision {
  if (!input.sharedTokenOk) {
    return { kind: 'respond', status: 401, body: { error: 'Unauthorized' } };
  }

  if (!input.enabled) {
    return {
      kind: 'respond',
      status: 403,
      body: { error: 'MCP is disabled for this workspace' },
    };
  }

  if (input.error !== undefined) {
    if (input.error instanceof UnauthorizedException) {
      return {
        kind: 'respond',
        status: 401,
        body: { error: input.error.message },
      };
    }
    return {
      kind: 'respond',
      status: 500,
      body: { error: 'Internal server error' },
    };
  }

  return { kind: 'hijack' };
}

// Result of the EE MFA module's requirement check for the Basic gate. Both
// flags absent/false means MFA does not block the password login.
export interface BasicGateMfaResult {
  userHasMfa?: boolean;
  requiresMfaSetup?: boolean;
}

/**
 * Pure decision logic for the /mcp HTTP-Basic pre-token gate, replicating EXACTLY
 * what AuthController.login enforces before issuing a token, so the Basic path is
 * not an SSO/MFA bypass. Framework-free (no ModuleRef, no on-disk EE MFA module)
 * so the SSO/MFA decision is unit-testable in isolation:
 *
 *   - `ssoEnforced` true  -> throw Unauthorized ("enforced SSO"); a password
 *      login is not allowed on an SSO-enforced workspace.
 *   - otherwise, `mfa` is the EE MFA module's requirement result (or undefined
 *      when no EE MFA module is bundled — a community/fork build). If MFA is
 *      present and the user has MFA enabled OR needs MFA setup, throw Unauthorized
 *      telling the caller to use a Bearer access token (Basic cannot complete MFA).
 *   - no SSO + no MFA gate -> resolve (the Basic login is allowed to proceed).
 *
 * McpService.enforceBasicLoginGate wires the concrete `validateSsoEnforcement`
 * result and the lazily-loaded MFA module result into this, so the gate decision
 * itself carries no framework dependencies. Throws UnauthorizedException on
 * rejection (surfaced as a clean 401); never logs the password.
 */
export function decideBasicGate(input: {
  ssoEnforced: boolean;
  mfa?: BasicGateMfaResult;
}): void {
  if (input.ssoEnforced) {
    throw new UnauthorizedException(
      'This workspace has enforced SSO login. Use SSO; MCP HTTP Basic is not allowed.',
    );
  }

  const mfa = input.mfa;
  if (mfa && (mfa.userHasMfa || mfa.requiresMfaSetup)) {
    throw new UnauthorizedException(
      'This account requires multi-factor authentication. MCP HTTP Basic ' +
        'cannot complete MFA — log in normally and use a Bearer access token ' +
        'instead.',
    );
  }
}

/** Extract a Bearer token from an Authorization header (case-insensitive). */
export function extractBearer(
  authHeader: string | undefined,
): string | undefined {
  const [type, token] = authHeader?.split(' ') ?? [];
  return type?.toLowerCase() === 'bearer' ? token : undefined;
}

/**
 * Pure decision logic for the /mcp per-session identity. Precedence:
 *   1. HTTP Basic (email:password) -> validate via `login`, issue the user's
 *      JWT, run as that user (chosen path). Throttle FAILED logins per IP/email.
 *   2. Authorization: Bearer <jwt> -> verify as an ACCESS JWT, run with it.
 *   3. Env service account         -> back-compat fallback.
 *   4. none                        -> meaningful 401.
 *
 * Throws UnauthorizedException with a SPECIFIC reason on failure (never a
 * generic "MCP error"); never returns/logs the password or the Authorization
 * header. The `JwtType.ACCESS` enforcement lives in `verifyAccessJwt`.
 */
export async function resolveMcpSessionConfig(
  authHeader: string | undefined,
  deps: McpAuthDeps,
): Promise<ResolvedMcpAuth> {
  const { apiUrl } = deps;

  // --- 1) chosen path: Basic login/password ---
  const basic = parseBasicAuth(authHeader);
  if (basic) {
    const emailLc = basic.email.toLowerCase();
    const ipKey = `ip:${deps.clientIp}`;
    const ipEmailKey = `ip-email:${deps.clientIp}:${emailLc}`;
    // GLOBAL per-email key (no IP). Without this an attacker who rotates IP /
    // X-Forwarded-For evades the per-IP and per-IP+email keys entirely and can
    // brute a single account unthrottled. Keying one extra bucket on the email
    // alone closes that account-brute hole regardless of source address.
    // XFF tradeoff: clientIp is derived from the first X-Forwarded-For hop when
    // present (see McpService.clientIp), which a client can forge when no
    // trusted proxy is configured; the per-email global key is the part that
    // does NOT depend on a trustworthy IP and is the real brute-force backstop.
    const emailKey = `email:${emailLc}`;
    // Atomic check-AND-reserve, synchronously and BEFORE any await. The old code
    // did a read-only isBlocked() pre-check here and only recordFailure()'d the
    // failure AFTER the awaited bcrypt login — so N concurrent requests for one
    // email all saw count=0, all ran bcrypt, all failed, and only then all
    // recorded, blowing far past the threshold. tryReserve() folds the check and
    // the increment into one synchronous, non-interleavable step: it counts this
    // in-flight attempt NOW, so the (threshold+1)-th concurrent attempt is
    // rejected before its bcrypt ever runs. The reservation IS the recorded
    // failure (no separate recordFailure on the failure path below); a successful
    // login clears it via reset(), and a non-credential business error releases
    // it via release(). Reserve ALL keys so each per-key budget is charged.
    const ipOk = deps.limiter.tryReserve(ipKey);
    const ipEmailOk = deps.limiter.tryReserve(ipEmailKey);
    const emailOk = deps.limiter.tryReserve(emailKey);
    if (!ipOk || !ipEmailOk || !emailOk) {
      // At least one key is at/over threshold: blocked. Release the keys we DID
      // manage to reserve in this same call so a rejected (already-throttled)
      // request does not over-charge the keys that were still under budget — the
      // same observable outcome as the old isBlocked() pre-check, which never
      // incremented on a blocked request.
      if (ipOk) deps.limiter.release(ipKey);
      if (ipEmailOk) deps.limiter.release(ipEmailKey);
      if (emailOk) deps.limiter.release(emailKey);
      throw new UnauthorizedException(
        'Too many failed MCP login attempts. Try again later.',
      );
    }

    // Everything from here through the credential evaluation runs UNDER one
    // try/catch so a SINGLE rule governs the reservation we took above:
    // "release the reserved keys unless the error is a genuine credential
    // failure." That covers all three early-throw paths uniformly —
    //   (a) findWorkspace() returning null (a CONFIG error),
    //   (b) the SSO/MFA enforceBasicGate throwing (a BUSINESS error),
    //   (c) login()/verifyCredentials() throwing a non-credential business error
    //       (e.g. "email not verified") —
    // none of which are password-guess signals, so none may burn a victim's
    // limiter budget. Only a genuine credential failure (isCredentialsFailure)
    // leaves the reservation in place, because the reservation IS its recorded
    // failure. Without this, an attacker could exhaust a victim's per-email
    // backstop with SSO/MFA-gated or misconfigured-workspace requests that never
    // even run bcrypt. The reservation stays at the TOP (before any await) so the
    // concurrency race the #83 fix closed is NOT re-introduced.
    try {
      const workspace = await deps.findWorkspace();
      if (!workspace) {
        throw new UnauthorizedException('No workspace is configured.');
      }

      // SSO/MFA pre-token gate (BLOCKER fix): replicate the AuthController.login
      // gates BEFORE any token is issued on the Basic path. If the workspace
      // enforces SSO, or the EE MFA module is bundled and this user/workspace
      // requires MFA, this throws and we never mint a token. The Bearer path is
      // intentionally NOT gated here (its JWT was already minted post-gate). This
      // runs on BOTH init and subsequent Basic requests, but it must run before
      // login()/verifyCredentials so an SSO/MFA user cannot authenticate at all.
      // We do NOT count a gate rejection toward the brute-force limiter: it is
      // not a password-guess signal (the catch below releases the reservation).
      if (deps.enforceBasicGate) {
        await deps.enforceBasicGate(workspace, {
          email: basic.email,
          password: basic.password,
        });
      }

      // Fix 1 (init vs subsequent):
      //   - SESSION INIT (no mcp-session-id): full login() mints the user JWT
      //     (the one allowed session creation + audit event for this MCP
      //     session). The DocmostClient caches that token, so later tool calls
      //     never re-login.
      //   - SUBSEQUENT request (has mcp-session-id): we only need to re-validate
      //     the caller's credentials for anti-fixation. verifyCredentials() does
      //     the SAME lookup/password/email-verified/disabled checks as login()
      //     but mints NO session, writes NO audit row and updates NO lastLoginAt,
      //     so a correct repeat does not spawn a DB session per request while a
      //     wrong password still 401s. The getToken here is never used to mint a
      //     new session: on a subsequent request the existing session already
      //     holds its token; this config is only consulted at init.
      if (deps.isSessionInit) {
        const authToken = await deps.login(
          { email: basic.email, password: basic.password },
          workspace.id,
        );
        deps.limiter.reset(ipKey);
        deps.limiter.reset(ipEmailKey);
        deps.limiter.reset(emailKey);
        return {
          config: { apiUrl, getToken: async () => authToken },
          identity: `basic:${emailLc}`,
        };
      }
      await deps.verifyCredentials(
        { email: basic.email, password: basic.password },
        workspace.id,
      );
    } catch (err) {
      // The in-flight reservation taken above already counted this attempt, so
      // an actual CREDENTIALS failure (wrong email/password) needs NO separate
      // recordFailure — the reservation IS the recorded failure (avoiding the
      // old double-count). But ANY other throw between the reservation and here
      // — a missing-workspace config error, an SSO/MFA gate rejection, or a
      // business error like "email not verified" — is a 401/400 surface, NOT a
      // guessed-password signal, so it must not burn a victim's limiter budget:
      // release the optimistic reservation (only the keys we actually reserved,
      // which on this non-blocked path is all three) in that case.
      if (!isCredentialsFailure(err)) {
        deps.limiter.release(ipKey);
        deps.limiter.release(ipEmailKey);
        deps.limiter.release(emailKey);
      }
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Email or password does not match';
      throw new UnauthorizedException(message);
    }
    // Subsequent request, credentials valid: clear the per-IP and per-IP+email
    // budget, but DELIBERATELY do NOT reset the GLOBAL per-email key here. That
    // email key is the only brute-force backstop that survives IP/XFF rotation;
    // resetting it on every periodic tool call of a victim's live MCP session
    // would repeatedly wipe a parallel attacker's failed-login budget for that
    // email. The global email key is reset ONLY on a session-INIT login()
    // success (above), which is a single deliberate authentication, not a
    // high-frequency re-validation.
    //
    // Under the reserve model we DID optimistically increment emailKey up front
    // (tryReserve), so a plain "leave it intact" would let every periodic tool
    // call of the victim's own live session permanently grow their email bucket
    // and throttle THEMSELVES. release() undoes exactly the one increment THIS
    // call took (count -= 1), restoring the pre-request budget — it does NOT
    // clear a parallel attacker's accumulated failures (that's reset()), so the
    // brute-force backstop survives while the victim's success is budget-neutral.
    deps.limiter.reset(ipKey);
    deps.limiter.reset(ipEmailKey);
    deps.limiter.release(emailKey);
    return {
      config: { apiUrl, getToken: async () => '' },
      identity: `basic:${emailLc}`,
    };
  }

  // --- 2) fallback A: Bearer access-JWT (user-supplied token) ---
  const bearer = extractBearer(authHeader);
  if (bearer) {
    let payload: { sub?: string; email?: string };
    try {
      payload = await deps.verifyAccessJwt(bearer);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Invalid or expired token';
      throw new UnauthorizedException(message);
    }
    return {
      config: { apiUrl, getToken: async () => bearer },
      identity: `bearer:${payload.sub ?? payload.email ?? 'unknown'}`,
    };
  }

  // --- 3) fallback B: env service account (existing behaviour, optional) ---
  if (deps.email && deps.password) {
    return {
      config: { apiUrl, email: deps.email, password: deps.password },
      identity: 'service-account',
    };
  }

  // --- 4) nothing usable ---
  throw new UnauthorizedException(
    'MCP requires HTTP Basic auth (email:password) or a Bearer access token, ' +
      'or a configured MCP_DOCMOST_EMAIL/MCP_DOCMOST_PASSWORD service account.',
  );
}

// Re-export JwtType so callers binding `verifyAccessJwt` know which type to
// enforce, without importing it separately.
export { JwtType };
