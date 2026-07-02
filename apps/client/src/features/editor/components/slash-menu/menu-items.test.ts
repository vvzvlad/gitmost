import { describe, it, expect } from "vitest";
import {
  buildLayoutCandidates,
  getSuggestionItems,
} from "@/features/editor/components/slash-menu/menu-items.ts";

/**
 * `buildLayoutCandidates` maps a slash query across physical keyboard layouts
 * (RU ЙЦУКЕН <-> US QWERTY) so the menu matches Latin item titles/terms even
 * when typed with the wrong layout active, while keeping the original query so
 * genuine Cyrillic search terms still match. See bug #283.
 */
describe("buildLayoutCandidates", () => {
  it("remaps a RU-layout query to its US-QWERTY equivalent (сщву -> code)", () => {
    expect(buildLayoutCandidates("сщву")).toContain("code");
  });

  it("remaps a US-layout query to its RU-ЙЦУКЕН equivalent (cyjcrf -> сноска)", () => {
    expect(buildLayoutCandidates("cyjcrf")).toContain("сноска");
  });

  it("always includes the original query", () => {
    expect(buildLayoutCandidates("сщву")).toContain("сщву");
    expect(buildLayoutCandidates("cyjcrf")).toContain("cyjcrf");
    expect(buildLayoutCandidates("сноска")).toContain("сноска");
  });

  it("leaves a query with no mappable keys as a single-element set", () => {
    // Digits are on neither layout map, so both remaps are no-ops and de-dup
    // back to one entry.
    expect(buildLayoutCandidates("123")).toEqual(["123"]);
  });
});

/** Helper: flatten grouped suggestion items to a flat list of titles. */
const titles = (groups: ReturnType<typeof getSuggestionItems>): string[] =>
  Object.values(groups).flatMap((items) => items.map((i) => i.title));

describe("getSuggestionItems layout-aware matching", () => {
  it("finds Code when 'code' is typed in RU layout (/сщву)", () => {
    expect(titles(getSuggestionItems({ query: "сщву" }))).toContain("Code");
  });

  it("still finds Code for the plain /code query", () => {
    expect(titles(getSuggestionItems({ query: "code" }))).toContain("Code");
  });

  it("still matches genuine Cyrillic search terms (/сноска -> Footnote)", () => {
    expect(titles(getSuggestionItems({ query: "сноска" }))).toContain(
      "Footnote",
    );
  });

  it("finds Footnote when 'сноска' is typed in EN layout (/cyjcrf)", () => {
    expect(titles(getSuggestionItems({ query: "cyjcrf" }))).toContain(
      "Footnote",
    );
  });
});
