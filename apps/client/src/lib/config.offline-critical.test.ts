import { describe, it, expect, afterEach } from "vitest";
import {
  offlineCriticalRequestConfig,
  OFFLINE_CRITICAL_TIMEOUT_MS,
} from "./config";

// #641, part 5 — the offline-critical GETs (/me, /pages/info, /spaces/*) get a
// PER-REQUEST timeout so a hung connection settles instead of an eternal
// skeleton, and ONLY when local-first is on (flag OFF must be unchanged: axios
// default, no timeout). The instance-wide timeout is deliberately NOT touched
// (uploads/imports/exports share the instance).

afterEach(() => {
  delete process.env.LOCAL_FIRST_ENABLED;
});

describe("offlineCriticalRequestConfig (#641 part 5)", () => {
  it("flag ON → a finite per-request timeout (acceptance 5: a hang settles)", () => {
    process.env.LOCAL_FIRST_ENABLED = "true";
    expect(offlineCriticalRequestConfig()).toEqual({
      timeout: OFFLINE_CRITICAL_TIMEOUT_MS,
    });
    expect(OFFLINE_CRITICAL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(OFFLINE_CRITICAL_TIMEOUT_MS)).toBe(true);
  });

  it("flag OFF → no timeout override (byte-for-behavior unchanged, acceptance 8)", () => {
    delete process.env.LOCAL_FIRST_ENABLED;
    expect(offlineCriticalRequestConfig()).toEqual({});
  });
});
