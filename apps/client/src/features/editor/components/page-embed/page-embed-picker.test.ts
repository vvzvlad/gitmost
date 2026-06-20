import { describe, it, expect } from "vitest";
import { filterPageEmbedOptions } from "./page-embed-picker";

type Page = { id: string; title?: string };

describe("filterPageEmbedOptions", () => {
  const pages: Page[] = [
    { id: "p1", title: "One" },
    { id: "host", title: "Host" },
    { id: "p2", title: "Two" },
  ];

  it("excludes the host page from the options (self-embed guard)", () => {
    const result = filterPageEmbedOptions(pages, "host");
    expect(result.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("keeps all pages when the host id matches nothing", () => {
    const result = filterPageEmbedOptions(pages, "other");
    expect(result.map((p) => p.id)).toEqual(["p1", "host", "p2"]);
  });

  it("keeps all pages when no host id is provided", () => {
    const result = filterPageEmbedOptions(pages, undefined);
    expect(result.map((p) => p.id)).toEqual(["p1", "host", "p2"]);
  });

  it("drops nullish entries defensively", () => {
    const dirty = [
      { id: "p1" },
      null as unknown as Page,
      undefined as unknown as Page,
      { id: "p2" },
    ];
    const result = filterPageEmbedOptions(dirty, "host");
    expect(result.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("returns an empty array for nullish input", () => {
    expect(
      filterPageEmbedOptions(null as unknown as Page[], "host"),
    ).toEqual([]);
  });
});
