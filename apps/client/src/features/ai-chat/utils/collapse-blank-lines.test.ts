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

describe("collapseBlankLines + renderChatMarkdown (tight reasoning rendering)", () => {
  it("renders a blank-line-separated list as a TIGHT list (no <li><p>)", () => {
    const loose =
      "Intro paragraph.\n\n- item one\n\n- item two\n\n- item three";
    const html = renderChatMarkdown(collapseBlankLines(loose), {});
    // Tight list: each <li> holds the text directly, not wrapped in a <p>.
    expect(html).toContain("<li>item one</li>");
    expect(html).not.toContain("<li><p>");
    // The list still parses as a list after the paragraph (not a paragraph+<br>).
    expect(html).toContain("<ul>");
    expect(html).toContain("<p>Intro paragraph.</p>");
  });

  it("renders an ordered list (1. 2.) as tight after collapsing", () => {
    const loose = "Intro.\n\n1. first\n\n2. second";
    const html = renderChatMarkdown(collapseBlankLines(loose), {});
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
    expect(html).not.toContain("<li><p>");
  });

  it("the loose source WOULD render <li><p> without collapsing (control)", () => {
    const loose = "- a\n\n- b";
    expect(renderChatMarkdown(loose, {})).toContain("<li><p>");
  });
});
