// Payload of the per-connect `app-version` socket.io event announced by the
// server (ws.gateway.ts) after a successful auth. A dedicated event — NOT a
// member of the room-scoped `WebSocketEvent` union (which is discriminated by
// `operation`), so it never touches use-query-subscription.
export type AppVersionSocketPayload = { version: string };

/**
 * Pure decision for the version-coherence guard.
 *
 * All inputs are injected (no globals, no side effects) so it is unit-testable
 * without a DOM or the build-time `APP_VERSION` global (undefined under vitest).
 *
 * - `autoReloadUsed` = an automatic reload has already happened within the
 *   current ~5-min window, so we must not auto-reload again (loop safety,
 *   shared window budget with the reactive chunk-load boundary).
 *
 * Returns:
 * - "noop"   — do nothing (unknown version on either side, or already in sync).
 * - "banner" — show the manual "update available" banner only (no auto-reload).
 * - "reload" — real first-time mismatch: eligible for a guarded auto-reload.
 */
export function decideVersionAction(args: {
  serverVersion: string;
  clientVersion: string;
  autoReloadUsed: boolean;
}): "reload" | "banner" | "noop" {
  const { serverVersion, clientVersion, autoReloadUsed } = args;
  if (!serverVersion || !clientVersion) return "noop"; // fail-safe: unknown version → never act
  if (serverVersion === clientVersion) return "noop"; // in sync
  if (autoReloadUsed) return "banner"; // one auto-reload per RELOAD_WINDOW_MS window already spent
  return "reload"; // real mismatch, window budget available
}
