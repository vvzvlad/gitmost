import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IPage } from "@/features/page/types/page.types";

// A fresh QueryClient stands in for the app singleton (importing the real
// @/main.tsx would run ReactDOM.createRoot, which has no DOM root in jsdom). The
// factory constructs it (QueryClient can't be referenced in vi.hoisted — that
// runs before imports resolve); we import the SAME mocked instance back to seed
// and assert on it.
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

import { queryClient as h_qc } from "@/main.tsx";
import { invalidateOnUpdatePage } from "./page-query";

const h = { qc: h_qc };

// invalidateOnUpdatePage is the field-only (title/icon) tree path: instead of a
// blanket invalidate it patches the affected node IN PLACE in every cached embed
// subtree. The undefined-guard is LOAD-BEARING: a title-only socket event carries
// icon:undefined, and without the guard `{...p, icon: undefined}` would WIPE the
// icon in every cached subtree.
const page = (over: Partial<IPage>): IPage =>
  ({ id: "p1", title: "Old", icon: "📄", spaceId: "s1" }) as IPage &
    typeof over as IPage;

describe("invalidateOnUpdatePage — pointwise embed-cache patch", () => {
  beforeEach(() => {
    h.qc.clear();
  });

  it("title-only event updates title but PRESERVES the icon (undefined-guard)", () => {
    const key = ["page-tree", "parent-1"];
    h.qc.setQueryData<IPage[]>(key, [
      { id: "p1", title: "Old", icon: "📄", spaceId: "s1" } as IPage,
      { id: "p2", title: "Other", icon: "📁", spaceId: "s1" } as IPage,
    ]);

    // icon passed as undefined (a title-only update)
    invalidateOnUpdatePage(
      "s1",
      "parent-1",
      "p1",
      "New Title",
      undefined as unknown as string,
    );

    const patched = h.qc.getQueryData<IPage[]>(key)!;
    const p1 = patched.find((p) => p.id === "p1")!;
    const p2 = patched.find((p) => p.id === "p2")!;
    expect(p1.title).toBe("New Title");
    expect(p1.icon).toBe("📄"); // preserved, not wiped
    // Sibling node untouched.
    expect(p2.title).toBe("Other");
    expect(p2.icon).toBe("📁");
  });

  it("icon-only event updates icon but preserves the title", () => {
    const key = ["page-tree", "parent-1"];
    h.qc.setQueryData<IPage[]>(key, [
      { id: "p1", title: "Keep", icon: "📄", spaceId: "s1" } as IPage,
    ]);

    invalidateOnUpdatePage(
      "s1",
      "parent-1",
      "p1",
      undefined as unknown as string,
      "🚀",
    );

    const p1 = h.qc.getQueryData<IPage[]>(key)!.find((p) => p.id === "p1")!;
    expect(p1.icon).toBe("🚀");
    expect(p1.title).toBe("Keep");
  });

  // The sidebar-pages cache (InfiniteData) is patched on the same event. It must
  // carry the SAME undefined-guard as the embed path above — otherwise a
  // title-only event's icon:undefined would wipe the sidebar entry's icon.
  const sidebarKey = ["sidebar-pages", { pageId: "parent-1", spaceId: "s1" }];
  const seedSidebar = () =>
    h.qc.setQueryData(sidebarKey, {
      pageParams: [undefined],
      pages: [
        {
          items: [
            { id: "p1", title: "Old", icon: "📄", spaceId: "s1" } as IPage,
            { id: "p2", title: "Other", icon: "📁", spaceId: "s1" } as IPage,
          ],
        },
      ],
    });
  const sidebarItem = (id: string) => {
    const data = h.qc.getQueryData(sidebarKey) as {
      pages: { items: IPage[] }[];
    };
    return data.pages[0].items.find((p) => p.id === id)!;
  };

  it("sidebar cache: title-only event updates title but PRESERVES the icon", () => {
    seedSidebar();

    invalidateOnUpdatePage(
      "s1",
      "parent-1",
      "p1",
      "New Title",
      undefined as unknown as string,
    );

    const p1 = sidebarItem("p1");
    expect(p1.title).toBe("New Title");
    expect(p1.icon).toBe("📄"); // preserved, not wiped
    // Sibling untouched.
    const p2 = sidebarItem("p2");
    expect(p2.title).toBe("Other");
    expect(p2.icon).toBe("📁");
  });

  it("sidebar cache: icon-only event updates icon but PRESERVES the title", () => {
    seedSidebar();

    invalidateOnUpdatePage(
      "s1",
      "parent-1",
      "p1",
      undefined as unknown as string,
      "🚀",
    );

    const p1 = sidebarItem("p1");
    expect(p1.icon).toBe("🚀");
    expect(p1.title).toBe("Old"); // preserved, not wiped
  });

  it("does not touch a subtree that lacks the updated node", () => {
    const otherKey = ["page-tree", "unrelated"];
    const before = [
      { id: "x1", title: "X", icon: "❌", spaceId: "s1" } as IPage,
    ];
    h.qc.setQueryData<IPage[]>(otherKey, before);

    invalidateOnUpdatePage("s1", "parent-1", "p1", "New", "🚀");

    // Same reference back — the subtree without p1 is left as-is.
    expect(h.qc.getQueryData<IPage[]>(otherKey)).toBe(before);
  });
});
