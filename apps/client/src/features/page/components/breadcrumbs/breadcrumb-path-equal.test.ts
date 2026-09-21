import { describe, it, expect, vi } from "vitest";
import { SpaceTreeNode } from "@/features/page/tree/types";

// breadcrumb.tsx transitively imports @/main.tsx (via usePageMetaQuery ->
// queryClient), whose module body calls ReactDOM.createRoot on a null root in
// jsdom. Stub it so importing the pure helper under test doesn't run that
// (breadcrumbPathEqual does not use queryClient, so a dummy is enough).
vi.mock("@/main.tsx", () => ({ queryClient: {} }));

import { breadcrumbPathEqual } from "./breadcrumb";

// breadcrumbPathEqual is the ONLY point where a false-positive equality would
// leave a stale/incorrect breadcrumb trail on screen: it decides whether the
// selectAtom hands back the same reference (no re-render) for the ancestor chain.
// Pin both directions — a too-loose equality goes stale on a rename; a too-tight
// one loses the perf win.
const node = (over: Partial<SpaceTreeNode>): SpaceTreeNode =>
  ({ id: "a", slugId: "sa", name: "A", icon: "📄", ...over }) as SpaceTreeNode;

describe("breadcrumbPathEqual", () => {
  it("both null → true", () => {
    expect(breadcrumbPathEqual(null, null)).toBe(true);
  });

  it("same reference → true", () => {
    const p = [node({})];
    expect(breadcrumbPathEqual(p, p)).toBe(true);
  });

  it("equal by id/slugId/name/icon (different arrays) → true", () => {
    expect(breadcrumbPathEqual([node({})], [node({})])).toBe(true);
  });

  it("one side null → false", () => {
    expect(breadcrumbPathEqual([node({})], null)).toBe(false);
    expect(breadcrumbPathEqual(null, [node({})])).toBe(false);
  });

  it("different length → false", () => {
    expect(
      breadcrumbPathEqual([node({})], [node({}), node({ id: "b" })]),
    ).toBe(false);
  });

  it.each(["name", "icon", "slugId", "id"] as const)(
    "a changed %s → false (breadcrumb must re-render)",
    (field) => {
      expect(
        breadcrumbPathEqual([node({})], [node({ [field]: "CHANGED" })]),
      ).toBe(false);
    },
  );
});
