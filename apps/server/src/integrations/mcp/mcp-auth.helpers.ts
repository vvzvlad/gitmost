// Pure, self-contained helpers for the embedded /mcp per-user auth flow. They
// are deliberately framework-free (no Nest, no DI, no concrete service imports)
// so they can be unit-tested in isolation WITHOUT loading the heavy auth/space
// dependency graph, and reused by McpService. Nothing here logs the password or
// the Authorization header.
import { UnauthorizedException } from '@nestjs/common';
import { JwtType } from '../../core/auth/dto/jwt-payload';

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
 */
export function isCredentialsFailure(err: unknown): boolean {
  return (
    err instanceof UnauthorizedException &&
    typeof err.message === 'string' &&
    err.message.toLowerCase().includes('email or password does not match')
  );
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
    if (
      deps.limiter.isBlocked(ipKey) ||
      deps.limiter.isBlocked(ipEmailKey) ||
      deps.limiter.isBlocked(emailKey)
    ) {
      throw new UnauthorizedException(
        'Too many failed MCP login attempts. Try again later.',
      );
    }

    const workspace = await deps.findWorkspace();
    if (!workspace) {
      throw new UnauthorizedException('No workspace is configured.');
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
    try {
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
      // Only count an actual CREDENTIALS failure (wrong email/password) toward
      // the brute-force limiter. Business errors like "email not verified" are
      // a 401/400 surface but are NOT a guessed-password signal, so they must
      // not let an attacker burn a victim's limiter budget or mask brute-force.
      if (isCredentialsFailure(err)) {
        deps.limiter.recordFailure(ipKey);
        deps.limiter.recordFailure(ipEmailKey);
        deps.limiter.recordFailure(emailKey);
      }
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Email or password does not match';
      throw new UnauthorizedException(message);
    }
    // Subsequent request, credentials valid: clear any prior failure budget.
    deps.limiter.reset(ipKey);
    deps.limiter.reset(ipEmailKey);
    deps.limiter.reset(emailKey);
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
