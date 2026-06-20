import { describe, it, expect } from "vitest";
import { excludeHost, buildPickerQuery } from "./page-embed-picker.utils";
import type { IPage } from "@/features/page/types/page.types";

function page(id: string): IPage {
  return { id, title: id, slugId: `slug-${id}` } as IPage;
}

describe("excludeHost", () => {
  it("drops the host page from the results (self-embed guard)", () => {
    const result = excludeHost([page("a"), page("host"), page("b")], "host");
    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("returns all pages when hostPageId is undefined", () => {
    const result = excludeHost([page("a"), page("b")], undefined);
    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("drops null/blank entries", () => {
    const result = excludeHost(
      [page("a"), null as unknown as IPage, page("b")],
      "host",
    );
    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("buildPickerQuery", () => {
  it("passes onlyTemplates:true with the query and page inclusion", () => {
    expect(buildPickerQuery("foo")).toEqual({
      query: "foo",
      includePages: true,
      onlyTemplates: true,
      limit: 20,
    });
  });

  it("preserves an empty query", () => {
    expect(buildPickerQuery("").query).toBe("");
    expect(buildPickerQuery("").onlyTemplates).toBe(true);
  });
});
