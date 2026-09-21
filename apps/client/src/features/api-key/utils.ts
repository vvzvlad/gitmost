import { addDays, addYears, differenceInMinutes } from "date-fns";

// The single early-warning window (#501/#506): keys whose expiry is closer than
// this are visually highlighted in the list. Also used to classify a key as
// already-expired (a negative "days until" is < 30 too).
export const EXPIRY_WARNING_DAYS = 30;

// last_used_at is throttled to ~1h server-side, so anything under an hour is
// shown as the coarse "within the last hour" rather than a false-precise
// "5 minutes ago".
export const LAST_USED_THROTTLE_MINUTES = 60;

export type ApiKeyLifetime = "30d" | "90d" | "1y" | "never";

export const DEFAULT_LIFETIME: ApiKeyLifetime = "1y";

// Maps a lifetime choice to the `expiresAt` payload sent to the server: an ISO
// string for a bounded lifetime, or null for an explicit unlimited key.
export function lifetimeToExpiresAt(
  lifetime: ApiKeyLifetime,
  now: Date = new Date(),
): string | null {
  switch (lifetime) {
    case "30d":
      return addDays(now, 30).toISOString();
    case "90d":
      return addDays(now, 90).toISOString();
    case "1y":
      return addYears(now, 1).toISOString();
    case "never":
      return null;
  }
}

// True when a bounded key's expiry is already in the past (or exactly now). An
// unlimited key (null) is never expired. This is distinct from "expiring soon":
// the two states are mutually exclusive at the call site (see api-keys-manager),
// so an already-expired key is labelled "Expired", not "Expiring soon".
export function isExpired(
  expiresAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return false;
  return expiry <= now.getTime();
}

// True when a bounded key expires within the warning window (or is already
// expired). An unlimited key (null) is never "expiring soon". Callers that need
// to distinguish an already-past expiry should check isExpired() first, as this
// predicate deliberately also covers the already-expired case.
export function isExpiringSoon(
  expiresAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return false;
  const msLeft = expiry - now.getTime();
  return msLeft < EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
}

// Classifies last-used recency so the caller can pick the honest label without
// promising sub-hour precision. Returns "never", "recent" (< 1h) or "stale".
export function lastUsedBucket(
  lastUsedAt: string | null,
  now: Date = new Date(),
): "never" | "recent" | "stale" {
  if (!lastUsedAt) return "never";
  const used = new Date(lastUsedAt);
  if (Number.isNaN(used.getTime())) return "never";
  return differenceInMinutes(now, used) < LAST_USED_THROTTLE_MINUTES
    ? "recent"
    : "stale";
}
