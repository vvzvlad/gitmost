import { describe, it, expect } from "vitest";
import { resolvePrevSnapshotId } from "./resolve-prev-snapshot";

// #370 F4 — the risky client path: with the "only versions" filter active, diff
// and restore must still baseline against the TRUE previous snapshot in the FULL
// list, never the previous VISIBLE version (which would skip the autosnapshots
// between two versions). These pin that the resolution is by FULL-list order.
describe("resolvePrevSnapshotId", () => {
  // Newest-first, as the history list stores it: a version, then two autosaves,
  // then an older version.
  const full = [
    { id: "v2", kind: "manual" },
    { id: "a2", kind: "idle" },
    { id: "a1", kind: "boundary" },
    { id: "v1", kind: "manual" },
    { id: "a0", kind: null },
  ];

  it("returns the immediate FULL-list successor, not the previous visible version", () => {
    // Selecting v2 while filtered to versions-only must baseline against a2 (the
    // real chronological predecessor), NOT v1 (the previous visible version).
    expect(resolvePrevSnapshotId(full, "v2")).toBe("a2");
  });

  it("resolves an autosnapshot's predecessor by full-list order", () => {
    expect(resolvePrevSnapshotId(full, "a1")).toBe("v1");
  });

  it("returns '' for the oldest item (no predecessor)", () => {
    expect(resolvePrevSnapshotId(full, "a0")).toBe("");
  });

  it("returns '' for an id not in the list", () => {
    expect(resolvePrevSnapshotId(full, "missing")).toBe("");
  });

  it("does not depend on a filtered subset — same result whatever is visible", () => {
    // The helper only ever sees the full list; a filtered view cannot change the
    // baseline it computes.
    expect(resolvePrevSnapshotId(full, "v1")).toBe("a0");
  });
});
