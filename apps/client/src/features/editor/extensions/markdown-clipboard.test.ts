import { describe, it, expect } from "vitest";
import { normalizeTableColumnWidths } from "./markdown-clipboard";

// normalizeTableColumnWidths mutates a DOM subtree (jsdom provides document).
function root(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

function firstRowColWidths(container: HTMLElement): (string | null)[] {
  const row = container.querySelector("tr");
  return Array.from(row?.children ?? []).map((c) =>
    c.getAttribute("colwidth"),
  );
}

describe("normalizeTableColumnWidths", () => {
  // The core "squash столбцов вставленной таблицы" concern: markdown has no
  // widths, so every pasted table would otherwise render at table-layout:fixed
  // / 100% and squash columns. This stamps an explicit per-column px width.
  it("stamps the default px width on every column when no widths are present", () => {
    const container = root(
      "<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>",
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["150", "150", "150"]);
  });

  it("derives column widths from a colgroup", () => {
    const container = root(
      "<table>" +
        '<colgroup><col style="width:200px"><col style="width:80px"></colgroup>' +
        "<tbody><tr><td>a</td><td>b</td></tr></tbody>" +
        "</table>",
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["200", "80"]);
  });

  it("derives column widths from per-cell width attributes", () => {
    const container = root(
      '<table><tbody><tr><td width="120">a</td><td width="90">b</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["120", "90"]);
  });

  it("derives column widths from a cell style:width:px", () => {
    const container = root(
      '<table><tbody><tr><td style="width:140px">a</td><td>b</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    // First cell width parsed; a fully-unmeasured column is left untouched
    // (the 100 fallback only fills in NULL gaps inside an otherwise-measured
    // multi-column slice, e.g. a colspan).
    expect(firstRowColWidths(container)).toEqual(["140", null]);
  });

  it("fills a null gap inside a measured colspanned slice with 100", () => {
    // colgroup gives [200, null]; the single colspan=2 cell spans both, so its
    // slice is [200, null] -> the null is backfilled to 100 => "200,100".
    const container = root(
      "<table>" +
        '<colgroup><col style="width:200px"><col></colgroup>' +
        '<tbody><tr><td colspan="2">merged</td></tr></tbody>' +
        "</table>",
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["200,100"]);
  });

  it("splits a measured width across a colspanned cell", () => {
    const container = root(
      '<table><tbody><tr><td colspan="2" width="300">merged</td><td width="100">x</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    // 300 / colspan(2) = 150 per underlying column => "150,150" on the merged cell.
    expect(firstRowColWidths(container)).toEqual(["150,150", "100"]);
  });

  it("falls back to the default width per spanned column when nothing is measurable", () => {
    const container = root(
      '<table><tbody><tr><td colspan="2">merged</td><td>x</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["150,150", "150"]);
  });

  it("leaves cells that already have a colwidth untouched", () => {
    const container = root(
      '<table><tbody><tr><td colwidth="42">a</td><td>b</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["42", "150"]);
  });

  it("normalizes every table in the subtree", () => {
    const container = root(
      "<table><tbody><tr><td>a</td></tr></tbody></table>" +
        "<table><tbody><tr><td>b</td><td>c</td></tr></tbody></table>",
    );
    normalizeTableColumnWidths(container);
    const tables = container.querySelectorAll("table");
    const widths = Array.from(tables).map((t) =>
      Array.from(t.querySelector("tr")!.children).map((c) =>
        c.getAttribute("colwidth"),
      ),
    );
    expect(widths).toEqual([["150"], ["150", "150"]]);
  });

  it("only annotates the first row (column widths are defined once)", () => {
    const container = root(
      "<table><tbody>" +
        "<tr><td>a</td><td>b</td></tr>" +
        "<tr><td>c</td><td>d</td></tr>" +
        "</tbody></table>",
    );
    normalizeTableColumnWidths(container);
    const rows = container.querySelectorAll("tr");
    expect(
      Array.from(rows[1].children).map((c) => c.getAttribute("colwidth")),
    ).toEqual([null, null]);
  });
});
