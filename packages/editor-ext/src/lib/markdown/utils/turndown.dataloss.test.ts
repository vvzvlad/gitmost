import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "./turndown.utils";
import { markdownToHtml } from "./marked.utils";

/**
 * #206 mdrt-2 — Markdown export must never SILENTLY drop a block. (FIXED)
 *
 * `htmlToMarkdown` (turndown) historically only registered rules for a fixed
 * set of custom nodes (callout, taskItem, details, math, iframe, htmlEmbed,
 * image, video, footnote). Any other custom node — `transclusionReference`,
 * `pageBreak`, `mention`, `status` — fell through to turndown's default
 * handling: an empty wrapper is "blank" and removed, so the block disappeared
 * from the exported Markdown with no trace, and `mention`/`status` collapsed to
 * bare text, losing their identity (data-id / data-color). The invariant
 * "never silently lose a block" was broken.
 *
 * The fix adds lossless turndown rules that re-emit each of these nodes as raw
 * HTML carrying every `data-*` attribute. Plain-Markdown viewers ignore the
 * inert tag; the import path round-trips it (`markdownToHtml` passes the raw
 * HTML through and each node's `parseHTML` rebuilds the ProseMirror node). These
 * tests assert the surviving contract (the block is preserved AND its identity
 * round-trips back through import).
 */
describe("htmlToMarkdown — custom nodes are preserved losslessly (#206 mdrt-2)", () => {
  const wrap = (inner: string) => `<p>before</p>${inner}<p>after</p>`;

  it("preserves a pageBreak block on Markdown export", () => {
    const md = htmlToMarkdown(
      wrap('<div data-type="pageBreak" class="page-break"></div>'),
    );
    expect(md).toContain("before");
    expect(md).toContain("after");
    // The break survives as an inert raw-HTML tag, not silently dropped.
    expect(md).toMatch(/data-type="pageBreak"/);
    expect(md).toMatch(/page-?break/i);
  });

  it("preserves a transclusionReference's identity on Markdown export", () => {
    const md = htmlToMarkdown(
      wrap('<div data-type="transclusionReference" data-id="abc"></div>'),
    );
    expect(md).toContain("before");
    expect(md).toContain("after");
    // The data-id (the only thing that gives the reference identity) survives.
    expect(md).toContain("abc");
    expect(md).toMatch(/data-type="transclusionReference"/);
  });

  it("preserves a mention's data-id (stable identity) on Markdown export", () => {
    const md = htmlToMarkdown(
      '<p>hi <span data-type="mention" data-id="u1" data-label="Bob">@Bob</span> there</p>',
    );
    // The mention keeps its stable identity (data-id), not just the text.
    expect(md).toContain("u1");
    expect(md).toContain("Bob");
    expect(md).toMatch(/data-type="mention"/);
  });

  it("preserves a status chip's color on Markdown export", () => {
    const md = htmlToMarkdown(
      '<p>s <span data-type="status" data-color="green">Done</span></p>',
    );
    // The chip's color (its identity) survives, not just the visible text.
    expect(md).toContain("green");
    expect(md).toContain("Done");
    expect(md).toMatch(/data-type="status"/);
  });

  // The export form is only lossless if the import path can rebuild it. These
  // assert the full MD -> HTML round-trip restores the node + its attributes,
  // which is the marker <-> node contract each `parseHTML` relies on.
  describe("import round-trip (markdownToHtml restores the node)", () => {
    it("round-trips a pageBreak through export + import", async () => {
      const md = htmlToMarkdown(
        wrap('<div data-type="pageBreak" class="page-break"></div>'),
      );
      const html = await markdownToHtml(md);
      expect(html).toMatch(/<div[^>]*data-type="pageBreak"[^>]*>/);
      expect(html).toContain("before");
      expect(html).toContain("after");
    });

    it("round-trips a transclusionReference (keeps data-id)", async () => {
      const md = htmlToMarkdown(
        wrap('<div data-type="transclusionReference" data-id="abc"></div>'),
      );
      const html = await markdownToHtml(md);
      expect(html).toMatch(/<div[^>]*data-type="transclusionReference"[^>]*>/);
      expect(html).toContain("abc");
    });

    it("round-trips a mention (keeps data-id + data-label)", async () => {
      const md = htmlToMarkdown(
        '<p>hi <span data-type="mention" data-id="u1" data-label="Bob">@Bob</span> there</p>',
      );
      const html = await markdownToHtml(md);
      expect(html).toMatch(/<span[^>]*data-type="mention"[^>]*>/);
      expect(html).toContain("u1");
      expect(html).toContain("Bob");
    });

    it("round-trips a status chip (keeps data-color)", async () => {
      const md = htmlToMarkdown(
        '<p>s <span data-type="status" data-color="green">Done</span></p>',
      );
      const html = await markdownToHtml(md);
      expect(html).toMatch(/<span[^>]*data-type="status"[^>]*>/);
      expect(html).toContain("green");
    });
  });
});
