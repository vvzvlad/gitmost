import { describe, it, expect } from "vitest";
import { collapseBlankLines } from "@/features/ai-chat/utils/collapse-blank-lines.ts";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";

describe("collapseBlankLines", () => {
  it("collapses a run of 2+ newlines to a single newline", () => {
    expect(collapseBlankLines("a\n\nb")).toBe("a\nb");
    expect(collapseBlankLines("a\n\n\n\nb")).toBe("a\nb");
  });

  it("keeps single newlines untouched", () => {
    expect(collapseBlankLines("a\nb\nc")).toBe("a\nb\nc");
  });

  it("preserves blank lines INSIDE a fenced code block", () => {
    const src = "a\n\n\nb\n\n```\nx\n\n\ny\n```\n\nc";
    // Prose blanks collapse; the blank lines between the ``` fences survive.
    expect(collapseBlankLines(src)).toBe("a\nb\n```\nx\n\n\ny\n```\nc");
  });

  it("handles a tilde fence and preserves its interior blanks", () => {
    const src = "p\n\n~~~\ncode\n\nmore\n~~~\n\nq";
    expect(collapseBlankLines(src)).toBe("p\n~~~\ncode\n\nmore\n~~~\nq");
  });

  it("leaves an unclosed fence's remaining lines verbatim", () => {
    const src = "intro\n\n```\nstill\n\nopen";
    expect(collapseBlankLines(src)).toBe("intro\n```\nstill\n\nopen");
  });

  it("is a no-op for text with no blank lines", () => {
    expect(collapseBlankLines("just one line")).toBe("just one line");
  });
});

describe("collapseBlankLines + renderChatMarkdown (canonical converter)", () => {
  // Chat markdown now renders through @docmost/prosemirror-markdown (issue #347):
  // the SAME converter the editor/import use. Its list items are schema-shaped —
  // each <li>'s content is wrapped in a <p> (listItem content is `paragraph+`) —
  // so the HTML always carries `<li><p>…</p></li>` regardless of blank-line
  // looseness in the source (the converter has no tight/loose distinction). The
  // visual tightness that `collapseBlankLines` used to buy is now provided by
  // CSS (`.markdown li p { margin: 0 }`), not the HTML shape.
  it("renders a blank-line-separated bullet list as a real <ul> list", () => {
    const loose =
      "Intro paragraph.\n\n- item one\n\n- item two\n\n- item three";
    const html = renderChatMarkdown(collapseBlankLines(loose), {});
    // Clean, un-namespaced HTML (DOMSerializer, not XMLSerializer) — no xmlns.
    expect(html).toContain("<ul>");
    expect(html).not.toMatch(/<ul[^>]*xmlns/);
    // The item text is present (inside the schema's <li><p> wrapper).
    expect(html).toContain("item one");
    // The intro paragraph renders as its own paragraph before the list.
    expect(html).toContain("<p>Intro paragraph.</p>");
  });

  it("renders an ordered list (1. 2.) as a real <ol> list", () => {
    const loose = "Intro.\n\n1. first\n\n2. second";
    const html = renderChatMarkdown(collapseBlankLines(loose), {});
    expect(html).toContain("<ol>");
    expect(html).not.toMatch(/<ol[^>]*xmlns/);
    expect(html).toContain("first");
    expect(html).toContain("second");
  });

  it("wraps list-item content in <p> (schema shape; tightness is CSS)", () => {
    // The canonical converter always wraps a list item's content in a paragraph,
    // whether or not the source had blank lines between items.
    const loose = "- a\n\n- b";
    expect(renderChatMarkdown(loose, {})).toContain("<li><p>");
    // And a "tight" source produces the identical wrapping (no distinction).
    expect(renderChatMarkdown(collapseBlankLines(loose), {})).toContain(
      "<li><p>",
    );
  });
});
