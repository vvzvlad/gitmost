import { describe, it, expect } from "vitest";
// Markdown conversion now goes through the canonical package's BROWSER entry
// (issue #347): the same converter the server import/export uses, resolved via
// the `browser` exports condition so it runs on the native `DOMParser` (the
// client jsdom vitest env provides one) with jsdom never bundled.
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirrorSync,
} from "@docmost/prosemirror-markdown/browser";
import {
  normalizeTableColumnWidths,
  classifyClipboardSelection,
  stripHeaderSeparator,
} from "./markdown-clipboard";

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

describe("classifyClipboardSelection", () => {
  it("serializes a list of 2+ items as markdown", () => {
    expect(
      classifyClipboardSelection([{ name: "bulletList", childCount: 2 }]),
    ).toEqual({ asMarkdown: true, wrapBareRows: false });
  });

  it("leaves a single-item list as plain text", () => {
    expect(
      classifyClipboardSelection([{ name: "bulletList", childCount: 1 }]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });

  it("serializes a whole table without wrapping bare rows", () => {
    expect(
      classifyClipboardSelection([{ name: "table", childCount: 3 }]),
    ).toEqual({ asMarkdown: true, wrapBareRows: false });
  });

  it("serializes a partial cell selection (bare rows) and flags wrapping", () => {
    expect(
      classifyClipboardSelection([
        { name: "tableRow", childCount: 2 },
        { name: "tableRow", childCount: 2 },
      ]),
    ).toEqual({ asMarkdown: true, wrapBareRows: true });
  });

  it("leaves plain paragraphs as plain text", () => {
    expect(
      classifyClipboardSelection([{ name: "paragraph", childCount: 1 }]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });

  it("does not wrap when rows are mixed with other block types", () => {
    expect(
      classifyClipboardSelection([
        { name: "tableRow", childCount: 2 },
        { name: "paragraph", childCount: 1 },
      ]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });

  it("treats a single copied cell (one bare row, one cell) as plain text", () => {
    expect(
      classifyClipboardSelection([
        { name: "tableRow", childCount: 1, cellCount: 1 },
      ]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });

  it("treats a single-cell whole-table slice as plain text", () => {
    // A rowspan>1 single cell yields one `table` node whose cells sum to 1.
    expect(
      classifyClipboardSelection([
        { name: "table", childCount: 1, cellCount: 1 },
      ]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });

  it("serializes a multi-cell partial row (bare rows) without treating it as one cell", () => {
    expect(
      classifyClipboardSelection([
        { name: "tableRow", childCount: 3, cellCount: 3 },
      ]),
    ).toEqual({ asMarkdown: true, wrapBareRows: true });
  });

  it("serializes a 1×N single-row table as markdown (cellCount, not table.childCount)", () => {
    // A 1×3 table has childCount===1 (one ROW) but 3 cells: it must NOT be
    // mistaken for a single cell — the guard sums cells across rows.
    expect(
      classifyClipboardSelection([
        { name: "table", childCount: 1, cellCount: 3 },
      ]),
    ).toEqual({ asMarkdown: true, wrapBareRows: false });
  });
});

describe("stripHeaderSeparator", () => {
  it("drops the header separator line (line index 1) of a bare-rows pipe table", () => {
    expect(stripHeaderSeparator("| a | b |\n| --- | --- |")).toBe("| a | b |");
  });

  it("drops a center-aligned separator marker (:-:)", () => {
    expect(stripHeaderSeparator("| a |\n| :-: |\n| b |")).toBe("| a |\n| b |");
  });

  it("leaves a single-line input unchanged", () => {
    expect(stripHeaderSeparator("| a | b |")).toBe("| a | b |");
  });

  it("leaves the HTML fallback (starts with '<') untouched", () => {
    const html = "<table><tbody><tr><td>a</td></tr></tbody></table>";
    expect(stripHeaderSeparator(html)).toBe(html);
  });

  it("leaves a MULTI-LINE HTML fallback with a separator-shaped interior line untouched", () => {
    // A spanned / multi-block cell selection serializes to a raw <table> HTML
    // fallback, not a GFM pipe table. A code-block cell inlines its text VERBATIM
    // with its "\n"s, so the fallback is multi-line and line index 1 is arbitrary
    // cell content — here a code line that is literally "| --- |". It must NOT be
    // treated as a header separator and spliced out (the bail on non-"|" leading
    // input protects it).
    const html =
      "<table><tbody><tr><td><pre><code>x\n| --- |\ny</code></pre></td>" +
      "<td><p>plain</p></td></tr></tbody></table>";
    expect(stripHeaderSeparator(html)).toBe(html);
  });

  it("strips ONLY line index 1 even when the first cell's data is literally '---'", () => {
    // First data cell is the text "---"; only the true separator at index 1
    // (a full separator ROW) is removed, the data row above it is kept.
    expect(stripHeaderSeparator("| --- |\n| --- |\n| x |")).toBe(
      "| --- |\n| x |",
    );
  });
});

// Output-level tests for the table clipboard regression: copying a table must
// yield a real GFM pipe table, NOT one-value-per-line concatenated cells.
// These exercise the actual markdown produced by convertProseMirrorToMarkdown —
// the same serializer step the clipboardTextSerializer now runs (issue #347) —
// so they pin the OUTPUT shape that the classifier-flag tests above do not cover.
// Input is ProseMirror JSON (what the copied slice serializes to), matching the
// clipboardTextSerializer's new call: it wraps the slice content in a synthetic
// `doc` (and the bare-rows case in a `table`) and calls the converter.
describe("table clipboard markdown output (convertProseMirrorToMarkdown)", () => {
  // Trim each line and drop blanks so structural assertions are whitespace-robust.
  function lines(md: string): string[] {
    return md
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  // A GFM separator row like "| --- | --- |" (any number of columns), tolerant
  // of the padding the serializer emits.
  function isSeparatorRow(line: string): boolean {
    const compact = line.replace(/\s+/g, "");
    return /^\|(?::?-{2,}:?\|)+$/.test(compact);
  }

  // Split a pipe-delimited row into trimmed cell values.
  function cells(line: string): string[] {
    return line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  const cell = (t: string) => ({
    type: "tableCell",
    content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
  });
  const headerCell = (t: string) => ({
    type: "tableHeader",
    content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
  });
  const row = (nodes: any[]) => ({ type: "tableRow", content: nodes });

  it("CONVERTER: wrapping bare rows in a synthetic table yields a GFM table WITH a header separator (pre-strip)", () => {
    // This pins the CONVERTER output the serializer's `wrapBareRows` branch
    // starts from — BEFORE stripHeaderSeparator runs. The converter always
    // emits a header separator (line index 1); the serializer then strips it
    // for a header-less partial selection (see the clipboard-level test below).
    const rows = [
      row([cell("a"), cell("b")]),
      row([cell("c"), cell("d")]),
    ];
    const md = convertProseMirrorToMarkdown({
      type: "doc",
      content: [{ type: "table", content: rows }],
    });
    const ls = lines(md);

    // The converter DOES emit a separator row (which the serializer strips).
    expect(ls.some(isSeparatorRow)).toBe(true);
    // NOT the old broken "one value per line" shape: every line is pipe-delimited.
    expect(ls.every((l) => l.includes("|"))).toBe(true);
    expect(md).not.toMatch(/^\s*(a|b|c|d)\s*$/m);
    // The cell values land in real pipe-delimited data rows.
    const dataRows = ls.filter((l) => !isSeparatorRow(l)).map(cells);
    expect(dataRows).toContainEqual(["a", "b"]);
    expect(dataRows).toContainEqual(["c", "d"]);
  });

  it("CLIPBOARD: a header-less partial cell selection yields pipe rows WITHOUT the spurious separator", () => {
    // What actually lands in the plain-text clipboard for the `wrapBareRows`
    // branch: convertProseMirrorToMarkdown(...) THEN stripHeaderSeparator(...).
    // The `| --- |` header syntax must be gone (it is table structure, not the
    // copied data).
    const rows = [
      row([cell("a"), cell("b")]),
      row([cell("c"), cell("d")]),
    ];
    const md = stripHeaderSeparator(
      convertProseMirrorToMarkdown({
        type: "doc",
        content: [{ type: "table", content: rows }],
      }),
    );
    const ls = lines(md);

    // No separator row survives — the spurious GFM header syntax is stripped.
    expect(ls.some(isSeparatorRow)).toBe(false);
    // The real data rows remain, pipe-delimited.
    expect(ls.every((l) => l.includes("|"))).toBe(true);
    const dataRows = ls.map(cells);
    expect(dataRows).toContainEqual(["a", "b"]);
    expect(dataRows).toContainEqual(["c", "d"]);
  });

  it("serializes a whole table with a header row as a proper GFM table (headline regression)", () => {
    // Mirror the serializer's non-wrap branch: the full `table` node is the
    // slice content and convertProseMirrorToMarkdown runs on it.
    const md = convertProseMirrorToMarkdown({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            row([headerCell("Name"), headerCell("Age")]),
            row([cell("Alice"), cell("30")]),
            row([cell("Bob"), cell("25")]),
          ],
        },
      ],
    });
    const ls = lines(md);

    // Proper GFM structure: separator row + all rows pipe-delimited.
    expect(ls.some(isSeparatorRow)).toBe(true);
    expect(ls.every((l) => l.includes("|"))).toBe(true);

    const rows = ls.filter((l) => !isSeparatorRow(l)).map(cells);
    // Header row comes first, followed by both data rows.
    expect(rows[0]).toEqual(["Name", "Age"]);
    expect(rows).toContainEqual(["Alice", "30"]);
    expect(rows).toContainEqual(["Bob", "25"]);
    // Headline regression: the table is NOT concatenated one-value-per-line.
    expect(md).not.toMatch(/^\s*(Name|Age|Alice|Bob|30|25)\s*$/m);
  });
});

// #347 acceptance: pasting CANONICAL markdown yields the SAME nodes the server
// import produces for the same text. The paste path calls markdownToProseMirror
// (the package browser entry) — the identical converter the server import uses —
// so asserting the converter (via the browser entry, on the native DOMParser)
// recognizes each canon form pins the paste-parity guarantee. These forms were
// NOT recognized by the old editor-ext marked layer the paste used before.
describe("canonical markdown paste recognition (browser entry parity)", () => {
  // Collect every node type present in a doc (recursively).
  const collectTypes = (n: any, set = new Set<string>()): Set<string> => {
    if (!n || typeof n !== "object") return set;
    if (n.type) set.add(n.type);
    if (Array.isArray(n.content)) n.content.forEach((c) => collectTypes(c, set));
    return set;
  };
  const findNode = (n: any, type: string): any => {
    if (!n || typeof n !== "object") return undefined;
    if (n.type === type) return n;
    if (Array.isArray(n.content)) {
      for (const c of n.content) {
        const hit = findNode(c, type);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const allText = (n: any): string => {
    if (!n || typeof n !== "object") return "";
    if (typeof n.text === "string") return n.text;
    if (Array.isArray(n.content)) return n.content.map(allText).join("");
    return "";
  };

  it("^[…] inline footnote -> footnoteReference + footnotesList", () => {
    const doc = markdownToProseMirrorSync("Body^[a note here].");
    const types = collectTypes(doc);
    expect(types.has("footnoteReference")).toBe(true);
    expect(types.has("footnotesList")).toBe(true);
    expect(types.has("footnoteDefinition")).toBe(true);
  });

  it('<!--img {…}--> attached image comment -> image with align', () => {
    const doc = markdownToProseMirrorSync(
      '![alt](/files/x.png) <!--img {"align":"left"}-->',
    );
    const img = findNode(doc, "image");
    expect(img).toBeTruthy();
    expect(img.attrs?.align).toBe("left");
    expect(img.attrs?.src).toBe("/files/x.png");
  });

  it("> [!type] Obsidian callout -> callout node with type", () => {
    const doc = markdownToProseMirrorSync("> [!warning]\n> be careful");
    const callout = findNode(doc, "callout");
    expect(callout).toBeTruthy();
    expect(callout.attrs?.type).toBe("warning");
    expect(allText(callout)).toContain("be careful");
  });

  it("$…$ inline math -> mathInline node", () => {
    const doc = markdownToProseMirrorSync("Euler: $e^{i\\pi}+1=0$ done");
    const math = findNode(doc, "mathInline");
    expect(math).toBeTruthy();
    expect(math.attrs?.text).toContain("e^{i\\pi}");
  });

  it("==…== highlight -> highlight mark", () => {
    const doc = markdownToProseMirrorSync("A ==marked== word");
    const marked = findNode(doc, "text");
    // The highlighted run carries a `highlight` mark somewhere in the doc.
    const hasHighlight = (n: any): boolean => {
      if (!n || typeof n !== "object") return false;
      if (
        n.type === "text" &&
        (n.marks || []).some((m: any) => m.type === "highlight")
      )
        return true;
      return Array.isArray(n.content) ? n.content.some(hasHighlight) : false;
    };
    expect(marked).toBeTruthy();
    expect(hasHighlight(doc)).toBe(true);
  });

  it("<!--subpages--> standalone comment -> subpages node", () => {
    const doc = markdownToProseMirrorSync("intro\n\n<!--subpages-->\n\nafter");
    expect(collectTypes(doc).has("subpages")).toBe(true);
  });
});

// #347 negatives: plain text carrying markdown-LIKE punctuation must NOT be
// silently converted/mangled (currency, bare `==`, a `[^1]` reference form).
describe("plain-text paste negatives (no phantom conversion)", () => {
  const findNode = (n: any, type: string): any => {
    if (!n || typeof n !== "object") return undefined;
    if (n.type === type) return n;
    if (Array.isArray(n.content)) {
      for (const c of n.content) {
        const hit = findNode(c, type);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const collectTypes = (n: any, set = new Set<string>()): Set<string> => {
    if (!n || typeof n !== "object") return set;
    if (n.type) set.add(n.type);
    if (Array.isArray(n.content)) n.content.forEach((c) => collectTypes(c, set));
    return set;
  };
  const allText = (n: any): string => {
    if (!n || typeof n !== "object") return "";
    if (typeof n.text === "string") return n.text;
    if (Array.isArray(n.content)) return n.content.map(allText).join("");
    return "";
  };

  it("currency `$5 and $10` is NOT turned into math", () => {
    const doc = markdownToProseMirrorSync("It costs $5 and $10 total");
    expect(findNode(doc, "mathInline")).toBeFalsy();
    expect(allText(doc)).toContain("$5 and $10");
  });

  it("a lone `==` is NOT turned into a highlight", () => {
    const doc = markdownToProseMirrorSync("compare a == b in code");
    const hasHighlight = (n: any): boolean => {
      if (!n || typeof n !== "object") return false;
      if (
        n.type === "text" &&
        (n.marks || []).some((m: any) => m.type === "highlight")
      )
        return true;
      return Array.isArray(n.content) ? n.content.some(hasHighlight) : false;
    };
    expect(hasHighlight(doc)).toBe(false);
    expect(allText(doc)).toContain("== b");
  });

  it("a `[^1]` reference form (no `^[`) is NOT turned into a footnote", () => {
    const doc = markdownToProseMirrorSync("see note [^1] for details");
    expect(collectTypes(doc).has("footnoteReference")).toBe(false);
    expect(allText(doc)).toContain("[^1]");
  });
});
