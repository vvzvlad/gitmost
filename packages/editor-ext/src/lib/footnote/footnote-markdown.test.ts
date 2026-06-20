import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "../markdown/utils/turndown.utils";
import { markdownToHtml } from "../markdown/utils/marked.utils";

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
});
