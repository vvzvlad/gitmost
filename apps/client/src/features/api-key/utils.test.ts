import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIFETIME,
  EXPIRY_WARNING_DAYS,
  isExpired,
  isExpiringSoon,
  lastUsedBucket,
  lifetimeToExpiresAt,
} from "./utils";

const NOW = new Date("2026-07-11T12:00:00.000Z");
const daysFromNow = (n: number) =>
  new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000).toISOString();

describe("lifetimeToExpiresAt", () => {
  it("default lifetime is 1 year (acceptance #7)", () => {
    expect(DEFAULT_LIFETIME).toBe("1y");
    const iso = lifetimeToExpiresAt("1y", NOW);
    expect(iso).toBe("2027-07-11T12:00:00.000Z");
  });

  it('"never" sends null (acceptance #7)', () => {
    expect(lifetimeToExpiresAt("never", NOW)).toBeNull();
  });

  it("30d / 90d map to the exact future instant", () => {
    expect(lifetimeToExpiresAt("30d", NOW)).toBe(daysFromNow(30));
    expect(lifetimeToExpiresAt("90d", NOW)).toBe(daysFromNow(90));
  });
});

describe("isExpiringSoon (acceptance #3 highlight)", () => {
  it("an unlimited key is never 'soon'", () => {
    expect(isExpiringSoon(null, NOW)).toBe(false);
  });

  it("highlights a key expiring within the 30-day window", () => {
    expect(isExpiringSoon(daysFromNow(EXPIRY_WARNING_DAYS - 1), NOW)).toBe(true);
    expect(isExpiringSoon(daysFromNow(10), NOW)).toBe(true);
  });

  it("does not highlight a key well outside the window", () => {
    expect(isExpiringSoon(daysFromNow(EXPIRY_WARNING_DAYS + 1), NOW)).toBe(
      false,
    );
    expect(isExpiringSoon(daysFromNow(200), NOW)).toBe(false);
  });

  it("an already-expired key is highlighted", () => {
    expect(isExpiringSoon(daysFromNow(-3), NOW)).toBe(true);
  });
});

describe("isExpired (past vs future expiry)", () => {
  it("an unlimited key is never expired", () => {
    expect(isExpired(null, NOW)).toBe(false);
  });

  it("a past expiry is expired", () => {
    expect(isExpired(daysFromNow(-3), NOW)).toBe(true);
    expect(isExpired(daysFromNow(-1), NOW)).toBe(true);
  });

  it("a future expiry is not expired (even within the warning window)", () => {
    expect(isExpired(daysFromNow(1), NOW)).toBe(false);
    expect(isExpired(daysFromNow(EXPIRY_WARNING_DAYS - 1), NOW)).toBe(false);
    expect(isExpired(daysFromNow(200), NOW)).toBe(false);
  });

  it("an expiry exactly at 'now' counts as expired (boundary is inclusive)", () => {
    expect(isExpired(NOW.toISOString(), NOW)).toBe(true);
  });

  it("is mutually distinguishable from isExpiringSoon: expired vs soon-but-future", () => {
    // A key 3 days in the past: expired, and (by design) also matches
    // isExpiringSoon — the UI resolves this by checking isExpired first.
    expect(isExpired(daysFromNow(-3), NOW)).toBe(true);
    // A key 10 days in the future: NOT expired, but expiring soon.
    expect(isExpired(daysFromNow(10), NOW)).toBe(false);
    expect(isExpiringSoon(daysFromNow(10), NOW)).toBe(true);
  });
});

describe("lastUsedBucket (within-the-last-hour semantics)", () => {
  const minutesAgo = (n: number) =>
    new Date(NOW.getTime() - n * 60 * 1000).toISOString();

  it("null last-used is 'never'", () => {
    expect(lastUsedBucket(null, NOW)).toBe("never");
  });

  it("under an hour is 'recent' (no sub-hour precision promised)", () => {
    expect(lastUsedBucket(minutesAgo(5), NOW)).toBe("recent");
    expect(lastUsedBucket(minutesAgo(59), NOW)).toBe("recent");
  });

  it("over an hour is 'stale'", () => {
    expect(lastUsedBucket(minutesAgo(90), NOW)).toBe("stale");
  });
});
