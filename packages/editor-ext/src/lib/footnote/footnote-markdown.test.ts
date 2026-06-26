import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "../markdown/utils/turndown.utils";
import { markdownToHtml } from "../markdown/utils/marked.utils";
import { extractFootnoteDefinitions } from "../markdown/utils/footnote.marked";

// HTML the editor-ext nodes render (sup[data-footnote-ref], section/div).
const HTML =
  `<p>Water<sup data-footnote-ref data-id="fn1"></sup> and clay<sup data-footnote-ref data-id="fn2"></sup>.</p>` +
  `<section data-footnotes>` +
  `<div data-footnote-def data-id="fn1"><p>First note.</p></div>` +
  `<div data-footnote-def data-id="fn2"><p>Second note.</p></div>` +
  `</section>`;

describe("footnote markdown round-trip", () => {
  it("HTML -> Markdown produces pandoc footnote syntax", () => {
    const md = htmlToMarkdown(HTML);
    expect(md).toContain("[^fn1]");
    expect(md).toContain("[^fn2]");
    expect(md).toContain("[^fn1]: First note.");
    expect(md).toContain("[^fn2]: Second note.");
  });

  it("Markdown -> HTML rebuilds the footnote nodes' HTML", async () => {
    const md = htmlToMarkdown(HTML);
    const html = await markdownToHtml(md);
    expect(html).toContain('data-footnote-ref data-id="fn1"');
    expect(html).toContain('data-footnote-ref data-id="fn2"');
    expect(html).toContain("data-footnotes");
    expect(html).toContain('data-footnote-def data-id="fn1"');
    expect(html).toContain("First note.");
    expect(html).toContain("Second note.");
  });

  it("preserves a [^id]: line shown inside a fenced code block (not a definition)", async () => {
    // A document that DOCUMENTS footnote syntax inside a code fence. The
    // `[^demo]: ...` line is example text, not a real definition, and must
    // survive the Markdown -> HTML conversion verbatim.
    const md = [
      "Here is how footnotes look:",
      "",
      "```markdown",
      "Some text[^demo]",
      "",
      "[^demo]: this is the definition",
      "```",
      "",
      "End of doc.",
    ].join("\n");

    const html = await markdownToHtml(md);
    // The example definition line is kept inside the rendered code block.
    expect(html).toContain("[^demo]: this is the definition");
    // It did NOT get pulled out into a real footnotes section.
    expect(html).not.toContain("data-footnotes");
    expect(html).not.toContain("data-footnote-def");
  });

  it("extractFootnoteDefinitions keeps the FIRST duplicate definition and reuses markers", () => {
    // Two definitions share id `d`, and the body has two `[^d]` markers. Under
    // the import model (#166) duplicate definition ids are FIRST-WINS: only the
    // first definition is kept; markers are NEVER rewritten, so the two `[^d]`
    // references reuse the single footnote.
    const md = [
      "See here[^d] and there[^d].",
      "",
      "[^d]: first",
      "[^d]: second",
    ].join("\n");

    const { body, section } = extractFootnoteDefinitions(md);

    const defIds = Array.from(
      section.matchAll(/data-footnote-def data-id="([^"]+)"/g),
    ).map((m) => m[1]);
    expect(defIds).toEqual(["d"]); // first-wins: one definition
    expect(section).toContain("first");
    expect(section).not.toContain("second"); // duplicate dropped

    // Both markers stay `[^d]` (reuse) — no `d__2` minting.
    const refIds = Array.from(body.matchAll(/\[\^([^\]\s]+)\]/g)).map(
      (m) => m[1],
    );
    expect(refIds).toEqual(["d", "d"]);
  });

  it("extractFootnoteDefinitions is DETERMINISTIC and stable (same input -> same output)", () => {
    // The output must be a pure function of the input markdown so importing the
    // same source twice (or via the editor and the MCP mirror) is identical.
    const md = [
      "See[^d] one[^d] two[^d].",
      "",
      "[^d]: first",
      "[^d]: second",
      "[^d]: third",
    ].join("\n");

    const run = () => {
      const { body, section } = extractFootnoteDefinitions(md);
      const defIds = Array.from(
        section.matchAll(/data-footnote-def data-id="([^"]+)"/g),
      ).map((m) => m[1]);
      const refIds = Array.from(body.matchAll(/\[\^([^\]\s]+)\]/g)).map(
        (m) => m[1],
      );
      return { defIds, refIds };
    };

    const a = run();
    const b = run();
    expect(a).toEqual(b);
    // First-wins: one kept definition `d`; all three reuse markers stay `d`.
    expect(a.defIds).toEqual(["d"]);
    expect(a.refIds).toEqual(["d", "d", "d"]);
  });

  it("markdownToHtml with a reused id renders ONE shared footnote def", async () => {
    const md = [
      "See here[^d] and there[^d].",
      "",
      "[^d]: first",
      "[^d]: second",
    ].join("\n");
    const html = await markdownToHtml(md);
    const defIds = Array.from(
      html.matchAll(/data-footnote-def data-id="([^"]+)"/g),
    ).map((m) => m[1]);
    expect(defIds).toEqual(["d"]); // one shared definition
    expect(html).toContain("first");
    expect(html).not.toContain("second");
  });
});
