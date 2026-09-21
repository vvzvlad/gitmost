import { describe, it, expect, beforeEach } from "vitest";
import {
  markReconciled,
  getReconciledAt,
  resetReconciledForTests,
} from "./page-ydoc-reconciled";

const DB = "page.w1:u1.pageA";

beforeEach(() => {
  localStorage.clear();
  resetReconciledForTests();
});

describe("reconciledAt reservation (#640 R1)", () => {
  it("is undefined until written, then durable (persisted in localStorage)", () => {
    expect(getReconciledAt(DB)).toBeUndefined();
    const now = Date.now();
    markReconciled(DB, now);
    expect(getReconciledAt(DB)).toBe(now);
    // Durable: the value lives in localStorage, not just in memory.
    expect(localStorage.getItem("pageYdoc.reconciled.v1")).toContain(DB);
  });

  it("keeps a per-database stamp; a second page does not clobber the first", () => {
    markReconciled(DB, 1000);
    markReconciled("page.w1:u1.pageB", 2000);
    expect(getReconciledAt(DB)).toBe(1000);
    expect(getReconciledAt("page.w1:u1.pageB")).toBe(2000);
  });
});
