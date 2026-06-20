/**
 * IP-INDEPENDENT per-workspace cap on anonymous public-share AI calls.
 *
 * The route is also IP-throttled (@Throttle, ~5/min), but the app runs with
 * `trustProxy: true`, so an attacker who rotates the `X-Forwarded-For` header
 * can present a fresh "client IP" on every request and evade the per-IP limit.
 * Each evaded call still spends REAL tokens on the workspace owner's paid AI
 * provider (stepCountIs(5), up to ~240KB of transcript), so a spoofing attacker
 * could run up the owner's bill without bound.
 *
 * This is the SECOND limiter contour: it is keyed by WORKSPACE id (server-
 * resolved from the request host, never attacker-controllable) and therefore
 * caps the owner's bill even when the per-IP limit is fully evaded via XFF
 * spoofing. It is defense-in-depth, NOT a replacement for the per-IP throttle.
 *
 * NOTE: in production this endpoint should ALSO sit behind a trusted reverse
 * proxy that overwrites (not appends) `X-Forwarded-For` with the real client
 * IP, so the per-IP throttle remains meaningful; this per-workspace cap is the
 * backstop for deployments where that is not guaranteed.
 *
 * State is in-process (a Map of fixed windows). That is intentional and matches
 * the existing in-memory limiter spirit in the repo: it needs no Redis, and a
 * per-instance cap is an acceptable backstop (N instances => N x cap, still
 * bounded). The window is fixed (not sliding) for O(1) checks and trivial
 * memory: one counter + one window-start timestamp per active workspace.
 */

/** Default cap: anonymous share-AI calls allowed per workspace per window. */
export const SHARE_AI_WORKSPACE_MAX_PER_WINDOW = 300;
/** Default window length: one rolling hour. */
export const SHARE_AI_WORKSPACE_WINDOW_MS = 60 * 60 * 1000;

interface WindowState {
  /** Epoch ms at which the current fixed window began. */
  windowStart: number;
  /** Calls counted in the current window. */
  count: number;
}

/**
 * Fixed-window, in-memory per-key counter. `tryConsume(key)` returns false once
 * the key has reached `max` within the current `windowMs`, and resets the count
 * when the window rolls over. Not coupled to NestJS so it is trivially testable.
 */
export class PublicShareWorkspaceLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly max: number = SHARE_AI_WORKSPACE_MAX_PER_WINDOW,
    private readonly windowMs: number = SHARE_AI_WORKSPACE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Account one call for `key`. Returns true if it is within the cap (allowed),
   * false if the cap for the current window is exceeded (caller must 429).
   */
  tryConsume(key: string): boolean {
    const t = this.now();
    const state = this.windows.get(key);
    if (!state || t - state.windowStart >= this.windowMs) {
      // First call, or the previous window elapsed: open a fresh window.
      this.windows.set(key, { windowStart: t, count: 1 });
      return true;
    }
    if (state.count >= this.max) {
      // Cap reached for this window; reject without incrementing further.
      return false;
    }
    state.count += 1;
    return true;
  }
}

/**
 * Read the per-workspace cap from the environment (overridable seam), falling
 * back to the sane default. A non-positive / unparseable value uses the default.
 */
export function resolveShareAiWorkspaceMax(): number {
  const raw = Number(process.env.SHARE_AI_WORKSPACE_MAX_PER_HOUR);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : SHARE_AI_WORKSPACE_MAX_PER_WINDOW;
}
