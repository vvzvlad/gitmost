import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./marked.utils";

/**
 * Regression for issue #192: pasting a GitHub-style `> [!type]` alert produced a
 * literal `<blockquote>` containing `[!info]` instead of a callout node, because
 * only the `:::type` form was tokenized. The editor paste path runs the same
 * `markdownToHtml`, so these assertions pin the conversion at the source.
 */
function html(md: string): string {
  const out = markdownToHtml(md);
  if (typeof out !== "string") throw new Error("expected sync string output");
  return out;
}

describe("markdownToHtml: GitHub `> [!type]` callouts", () => {
  it("converts `> [!info]` to a callout node, not a literal blockquote", () => {
    const out = html("> [!info]\n> Callout body text here");
    expect(out).toContain('data-type="callout"');
    expect(out).toContain('data-callout-type="info"');
    expect(out).toContain("Callout body text here");
    expect(out).not.toContain("[!info]");
    expect(out).not.toContain("<blockquote");
  });

  it("maps GitHub alert aliases onto the supported banner types", () => {
    expect(html("> [!NOTE]\n> x")).toContain('data-callout-type="info"');
    expect(html("> [!TIP]\n> x")).toContain('data-callout-type="success"');
    expect(html("> [!WARNING]\n> x")).toContain('data-callout-type="warning"');
    expect(html("> [!CAUTION]\n> x")).toContain('data-callout-type="danger"');
  });

  it("accepts the editor's own type names directly", () => {
    expect(html("> [!success]\n> x")).toContain('data-callout-type="success"');
    expect(html("> [!danger]\n> x")).toContain('data-callout-type="danger"');
  });

  it("falls back to info for an unknown type", () => {
    expect(html("> [!bogus]\n> x")).toContain('data-callout-type="info"');
  });

  it("preserves multi-line callout bodies", () => {
    const out = html("> [!warning]\n> line one\n> line two");
    expect(out).toContain('data-callout-type="warning"');
    expect(out).toContain("line one");
    expect(out).toContain("line two");
  });

  it("still converts the `:::type` form", () => {
    const out = html(":::info\nbody\n:::");
    expect(out).toContain('data-type="callout"');
    expect(out).toContain('data-callout-type="info"');
  });
});
