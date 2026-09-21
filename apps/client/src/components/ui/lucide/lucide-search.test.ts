import { describe, it, expect } from "vitest";
import catalog from "./lucide-catalog.generated";
import { CURATED_ICON_NAMES } from "./curated-icons";
import {
  buildBrowseRows,
  buildResultRows,
  canonicalOf,
  catalogIconCount,
  expandRu,
  searchIcons,
  ICONS_PER_ROW,
} from "./lucide-search";

// Exercised against the REAL committed catalog so these assertions ARE the
// issue's acceptance criteria for search (criterion 4), not a hand-built fake.
describe("canonicalOf", () => {
  it("resolves an alias to its canonical icon and leaves canonical names alone", () => {
    expect(canonicalOf(catalog, "home")).toBe("house");
    expect(canonicalOf(catalog, "house")).toBe("house");
    expect(canonicalOf(catalog, "definitely-not-an-icon")).toBe(
      "definitely-not-an-icon",
    );
  });
});

describe("expandRu", () => {
  it("maps a Russian word to English terms with rough stemming", () => {
    expect(expandRu("дом")).toEqual(expect.arrayContaining(["house", "home"]));
    expect(expandRu("огонь")).toEqual(expect.arrayContaining(["flame", "fire"]));
  });
  it("keeps a Latin word as its own term (so 'wifi' survives a RU query)", () => {
    expect(expandRu("wifi")).toEqual(["wifi"]);
  });
  it("contributes nothing for an unknown Russian word", () => {
    expect(expandRu("абракадабра")).toEqual([]);
  });
});

describe("searchIcons", () => {
  it("empty query yields no results", () => {
    expect(searchIcons(catalog, "")).toEqual([]);
    expect(searchIcons(catalog, "   ")).toEqual([]);
  });

  it("'fire' finds flame via its tag", () => {
    expect(searchIcons(catalog, "fire")).toContain("flame");
  });

  it("'home' finds house via alias, exactly once, and never the alias key", () => {
    const res = searchIcons(catalog, "home");
    expect(res).toContain("house");
    expect(res.filter((n) => n === "house")).toHaveLength(1);
    expect(res).not.toContain("home");
  });

  it("'огонь' finds flame via the RU synonym map", () => {
    expect(searchIcons(catalog, "огонь")).toContain("flame");
  });

  it("'дом wifi' intersects to exactly house-wifi", () => {
    expect(searchIcons(catalog, "дом wifi")).toEqual(["house-wifi"]);
  });

  it("'папка замок' returns folder-lock and folder-clock", () => {
    expect(searchIcons(catalog, "папка замок").sort()).toEqual([
      "folder-clock",
      "folder-lock",
    ]);
  });

  it("'дом папка' is an empty intersection (a normal outcome, not a bug)", () => {
    expect(searchIcons(catalog, "дом папка")).toEqual([]);
  });

  it("'zzzz' finds nothing", () => {
    expect(searchIcons(catalog, "zzzz")).toEqual([]);
  });

  it("results are deduped by canonical name", () => {
    const res = searchIcons(catalog, "house");
    expect(new Set(res).size).toBe(res.length);
  });
});

describe("buildResultRows", () => {
  it("chunks names into rows of at most ICONS_PER_ROW", () => {
    const names = Array.from({ length: 19 }, (_, i) => `n${i}`);
    const rows = buildResultRows(names);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "icons")).toBe(true);
    expect(rows[0].kind === "icons" && rows[0].names).toHaveLength(ICONS_PER_ROW);
    expect(rows[2].kind === "icons" && rows[2].names).toHaveLength(3);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe("buildBrowseRows", () => {
  const rows = buildBrowseRows(catalog, CURATED_ICON_NAMES);

  it("opens with a Popular section header", () => {
    expect(rows[0]).toEqual({ kind: "header", id: "h:popular", title: "Popular" });
  });

  it("has unique row ids across the whole model", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("category section headers are sorted by slug (weather is the last section)", () => {
    const headerSlugs = rows
      .filter((r) => r.kind === "header" && r.id.startsWith("h:") && r.id !== "h:popular")
      .map((r) => r.id.slice(2));
    const sorted = [...headerSlugs].sort();
    expect(headerSlugs).toEqual(sorted);
    expect(headerSlugs[headerSlugs.length - 1]).toBe("weather");
  });

  it("has no 'other' section when the catalog is fully built (degraded empty)", () => {
    expect(rows.some((r) => r.id === "h:other")).toBe(false);
  });

  it("Popular carries canonical curated names (funnel, not the alias filter)", () => {
    const popularNames = rows
      .filter((r) => r.kind === "icons" && r.id.startsWith("r:popular:"))
      .flatMap((r) => (r.kind === "icons" ? r.names : []));
    expect(popularNames).toContain("funnel");
    expect(popularNames).not.toContain("filter");
  });
});

describe("catalogIconCount", () => {
  it("counts unique canonical icons", () => {
    expect(catalogIconCount(catalog)).toBe(Object.keys(catalog.icons).length);
  });
});
