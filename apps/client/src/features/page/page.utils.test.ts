import { describe, it, expect } from "vitest";
import { buildPageUrl, buildSharedPageUrl } from "@/features/page/page.utils.ts";

/**
 * URL builders. A page URL is `${titleSlug}-${slugId}` where the title is
 * slugified (lowercase, dashed) after truncating to the first 70 chars, and an
 * empty title becomes "untitled". `buildPageUrl` prefixes `/p/` when no space
 * name is given and `/s/{space}/p/` otherwise. `buildSharedPageUrl` prefixes
 * `/share/p/` when no shareId and `/share/{shareId}/p/` otherwise. An anchorId
 * is appended as `#...`.
 */
describe("buildPageUrl", () => {
  it("uses /p/{slug} when spaceName is undefined", () => {
    expect(buildPageUrl(undefined as unknown as string, "abc123", "Hello World")).toBe(
      "/p/hello-world-abc123",
    );
  });

  it("uses /s/{space}/p/{slug} when spaceName is provided", () => {
    expect(buildPageUrl("eng", "abc123", "Hello World")).toBe(
      "/s/eng/p/hello-world-abc123",
    );
  });

  it("slugifies (lowercases + dashes) the title", () => {
    expect(buildPageUrl("eng", "id1", "My Cool PAGE!")).toBe(
      "/s/eng/p/my-cool-page-id1",
    );
  });

  it("uses 'untitled' for an empty title", () => {
    expect(buildPageUrl("eng", "id1", "")).toBe("/s/eng/p/untitled-id1");
  });

  it("uses 'untitled' when no title is passed at all", () => {
    expect(buildPageUrl("eng", "id1")).toBe("/s/eng/p/untitled-id1");
  });

  it("truncates the title to the first 70 chars before slugifying", () => {
    // 80 'a' then a space then "tail". Only the first 70 chars feed slugify, so
    // the slug is 70 a's (the space and "tail" past char 70 are dropped).
    const longTitle = "a".repeat(80) + " tail";
    const url = buildPageUrl("eng", "id1", longTitle);
    expect(url).toBe(`/s/eng/p/${"a".repeat(70)}-id1`);
    expect(url).not.toContain("tail");
  });

  it("appends the anchorId as a #fragment", () => {
    expect(buildPageUrl("eng", "id1", "Page", "section-2")).toBe(
      "/s/eng/p/page-id1#section-2",
    );
  });

  it("omits the fragment when no anchorId is given", () => {
    expect(buildPageUrl("eng", "id1", "Page")).not.toContain("#");
  });
});

describe("buildSharedPageUrl", () => {
  it("uses /share/p/{slug} when shareId is absent", () => {
    expect(
      buildSharedPageUrl({ shareId: "", pageSlugId: "id1", pageTitle: "Doc" }),
    ).toBe("/share/p/doc-id1");
  });

  it("uses /share/{shareId}/p/{slug} when shareId is present", () => {
    expect(
      buildSharedPageUrl({ shareId: "s9", pageSlugId: "id1", pageTitle: "Doc" }),
    ).toBe("/share/s9/p/doc-id1");
  });

  it("falls back to 'untitled' for an empty title", () => {
    expect(
      buildSharedPageUrl({ shareId: "s9", pageSlugId: "id1", pageTitle: "" }),
    ).toBe("/share/s9/p/untitled-id1");
  });

  it("appends the anchorId as a #fragment", () => {
    expect(
      buildSharedPageUrl({
        shareId: "s9",
        pageSlugId: "id1",
        pageTitle: "Doc",
        anchorId: "h1",
      }),
    ).toBe("/share/s9/p/doc-id1#h1");
  });

  it("truncates the title to the first 70 chars before slugifying", () => {
    const longTitle = "b".repeat(80) + " tail";
    const url = buildSharedPageUrl({
      shareId: "s9",
      pageSlugId: "id1",
      pageTitle: longTitle,
    });
    expect(url).toBe(`/share/s9/p/${"b".repeat(70)}-id1`);
    expect(url).not.toContain("tail");
  });
});
