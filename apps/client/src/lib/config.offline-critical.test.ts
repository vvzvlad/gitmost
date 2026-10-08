import { describe, it, expect } from "vitest";
import {
  offlineCriticalRequestConfig,
  OFFLINE_CRITICAL_TIMEOUT_MS,
} from "./config";

// #641, part 5 — the offline-critical GETs (/me, /pages/info, /spaces/*) get a
// PER-REQUEST timeout so a hung connection settles instead of an eternal
// skeleton. The instance-wide timeout is deliberately NOT touched
// (uploads/imports/exports share the instance).

describe("offlineCriticalRequestConfig (#641 part 5)", () => {
  it("a finite per-request timeout (acceptance 5: a hang settles)", () => {
    expect(offlineCriticalRequestConfig()).toEqual({
      timeout: OFFLINE_CRITICAL_TIMEOUT_MS,
    });
    expect(OFFLINE_CRITICAL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(OFFLINE_CRITICAL_TIMEOUT_MS)).toBe(true);
  });
});
