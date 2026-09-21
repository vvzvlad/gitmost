import { getOfflineGraceMs } from "@/lib/config";

/**
 * Network-independent session liveness (#640, part 6) — the PURE half.
 *
 * `sessionVerifiedAt` is stamped on EVERY successful `/me`. If more than
 * OFFLINE_GRACE (=30d = JWT_TOKEN_EXPIRES_IN) has elapsed since, the client must
 * refuse to draw ANY local content (chrome, tree, ydoc body) and purge it — even
 * offline, where a 401 never arrives. This is the ONLY safeguard that requires
 * no network event; it is what makes Ф5 safe ("offline forever" must not mean
 * "logged in forever").
 *
 * This module is a LEAF (imports only config) so the boot-cache gates
 * (page-meta-cache-atom `isCacheUsable`, the ydoc-open gate in page-editor) can
 * consult it without pulling in the purge/clear machinery — that lives in
 * `session-boundary.ts`, which is imported only by main.tsx.
 */

const VERIFIED_AT_KEY = "session.verifiedAt.v1";

/** Stamp the last successful `/me`. Called from UserProvider on fresh data. */
export function recordSessionVerified(now: number = Date.now()): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(VERIFIED_AT_KEY, String(now));
    }
  } catch {
    // best-effort — a missed stamp only shortens the grace, never extends it
  }
}

export function getSessionVerifiedAt(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(VERIFIED_AT_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Has the session exceeded OFFLINE_GRACE since the last verified `/me`?
 *
 * A NEVER-verified browser (no stamp) is NOT expired: there is no proven session
 * whose life to bound (fresh install / pre-feature content), and the first `/me`
 * stamps it. The dangerous case this guards — a stamp set to T, then >30d
 * offline — always has a stamp.
 */
export function isSessionExpired(now: number = Date.now()): boolean {
  const verifiedAt = getSessionVerifiedAt();
  if (verifiedAt === null) return false;
  return now - verifiedAt > getOfflineGraceMs();
}

/** Test-only: clear the verified-at stamp. */
export function clearSessionVerifiedForTests(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(VERIFIED_AT_KEY);
    }
  } catch {
    // ignore
  }
}
