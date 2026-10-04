// Framework-free auth helpers for the git-sync smart-HTTP (/git) host.
//
// The /git host authenticates `git clone/fetch/push` over HTTP **Basic** auth
// (username/password), so it needs Basic-header parsing, a brute-force limiter,
// a client-IP extractor and a credentials-failure classifier. These used to live
// in `mcp-auth.helpers.ts`, but develop's #558 made /mcp accept Bearer api_key
// ONLY and removed the Basic-auth surface from that module. git-sync still needs
// them for git-over-HTTP, so the exact same helpers live here, owned by the /git
// host. Kept deliberately framework-free (no Nest DI, no concrete services).
import { UnauthorizedException } from '@nestjs/common';
import { CREDENTIALS_MISMATCH_MESSAGE } from '../../../core/auth/auth.constants';

/**
 * Parse an HTTP `Authorization: Basic <base64(email:password)>` header into its
 * email/password parts. Returns null for a missing/non-Basic/malformed header or
 * an empty email (never valid credentials). The password may be empty (only the
 * email is required to be present) so a blank-password guess is still classified
 * as a credential attempt by the caller rather than dropped here.
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
 * Fixed-window per-key failed-login limiter with an atomic optimistic reserve, so
 * concurrent guesses for one key cannot all slip past the threshold before their
 * (async) credential checks run.
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
   * This is the brute-force fix for the Basic path: the increment happens
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

// Minimal structural shape of the bits of a Fastify request that `clientIp`
// needs. Kept structural so this module never imports the Fastify types.
export interface ClientIpRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Best-effort client IP for the per-IP limiter key: prefer the framework-parsed
 * `req.ip`, then the socket peer, then the first `x-forwarded-for` hop, else
 * 'unknown'. Only used as a rate-limit bucket key, so an imperfect value is safe.
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

/**
 * True when `err` is the generic credentials-mismatch UnauthorizedException that
 * AuthService.verifyUserCredentials throws for a wrong email/password (the
 * CREDENTIALS_MISMATCH_MESSAGE constant). Lets the caller distinguish a genuine
 * password-guess signal (keep the limiter reservation) from a non-credential
 * business error (release it).
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
