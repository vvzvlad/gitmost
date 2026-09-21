import { describe, it, expect } from "vitest";
import { templateRoute, KNOWN_ROUTE_TEMPLATES } from "./route-template";

describe("templateRoute", () => {
  it("templates a space page path (never leaks slugs)", () => {
    const t = templateRoute("/s/engineering/p/design-doc-abc123");
    expect(t).toBe("/s/:space/p/:slug");
    expect(t).not.toContain("engineering");
    expect(t).not.toContain("design-doc");
  });

  it("templates share, redirect and space paths", () => {
    expect(templateRoute("/share/abc/p/xyz")).toBe("/share/:shareId/p/:slug");
    expect(templateRoute("/share/p/xyz")).toBe("/share/p/:slug");
    expect(templateRoute("/p/some-slug")).toBe("/p/:slug");
    expect(templateRoute("/s/team")).toBe("/s/:space");
    expect(templateRoute("/s/team/trash")).toBe("/s/:space/trash");
    expect(templateRoute("/labels/urgent")).toBe("/labels/:label");
  });

  it("keeps known static routes verbatim", () => {
    expect(templateRoute("/home")).toBe("/home");
    expect(templateRoute("/settings/members")).toBe("/settings/members");
    expect(templateRoute("/")).toBe("/");
  });

  it("normalises a trailing slash", () => {
    expect(templateRoute("/s/team/p/slug/")).toBe("/s/:space/p/:slug");
  });

  it("collapses unknown paths to 'other' (bounded cardinality)", () => {
    expect(templateRoute("/weird/unknown/thing")).toBe("other");
    expect(templateRoute("/s/team/p/slug/extra/segments")).toBe("other");
  });

  // The server's /api/telemetry/vitals mirror (ALLOWED_ROUTE_TEMPLATES) drops any
  // route outside KNOWN_ROUTE_TEMPLATES, so templateRoute must NEVER emit a label
  // that is not in that dictionary — otherwise legit client metrics get dropped.
  it("only ever emits labels contained in KNOWN_ROUTE_TEMPLATES (#495)", () => {
    const samples = [
      "/",
      "/home",
      "/settings/members",
      "/settings/groups/g-1",
      "/s/team",
      "/s/team/trash",
      "/s/team/p/slug",
      "/p/slug",
      "/share/abc",
      "/share/abc/p/slug",
      "/share/p/slug",
      "/labels/urgent",
      "/invites/inv-1",
      "/weird/unknown/thing", // -> "other"
      "/deep/unmatched/x/y/z", // -> "other"
    ];
    for (const path of samples) {
      expect(KNOWN_ROUTE_TEMPLATES.has(templateRoute(path))).toBe(true);
    }
  });
});
