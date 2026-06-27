import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "./turndown.utils";

/**
 * #206 mdrt-2 — Markdown export must never SILENTLY drop a block.
 *
 * `htmlToMarkdown` (turndown) only registers rules for a fixed set of custom
 * nodes (callout, taskItem, details, math, iframe, htmlEmbed, image, video,
 * footnote). Any other custom node — `transclusionReference`, `pageBreak`,
 * `mention`, `status` — falls through to turndown's default handling: an empty
 * wrapper is "blank" and removed, so the block disappears from the exported
 * Markdown with no trace. The invariant "never silently lose a block" is broken.
 *
 * The `it.fails` cases assert the DESIRED contract (the block survives export in
 * SOME form) and are RED today: they document the unfixed data loss and flip to
 * green the moment a turndown rule (real syntax or a lossless HTML-comment
 * placeholder) is added. A normal characterization `it` pins the exact current
 * lossy output so the regression is unambiguous.
 */
describe("htmlToMarkdown — custom nodes without a turndown rule (#206 mdrt-2)", () => {
  const wrap = (inner: string) =>
    `<p>before</p>${inner}<p>after</p>`;

  it("CURRENTLY drops a pageBreak entirely (data loss)", () => {
    const md = htmlToMarkdown(
      wrap('<div data-type="pageBreak" class="page-break"></div>'),
    );
    // The page break vanishes: only the two paragraphs remain, nothing between.
    expect(md).toContain("before");
    expect(md).toContain("after");
    expect(md).not.toMatch(/page-?break/i);
    expect(md).not.toContain("---"); // not even a horizontal-rule fallback
  });

  it("CURRENTLY drops a transclusionReference entirely (data loss)", () => {
    const md = htmlToMarkdown(
      wrap('<div data-type="transclusionReference" data-id="abc"></div>'),
    );
    expect(md).toContain("before");
    expect(md).toContain("after");
    // The data-id (the only thing that gives the reference identity) is gone.
    expect(md).not.toContain("abc");
  });

  it.fails(
    "should NOT lose a pageBreak block on Markdown export",
    () => {
      const md = htmlToMarkdown(
        wrap('<div data-type="pageBreak" class="page-break"></div>'),
      );
      // Desired: the break survives in some form (e.g. a `---` rule or marker).
      expect(md).toMatch(/(-{3,}|page-?break)/i);
    },
  );

  it.fails(
    "should NOT lose a transclusionReference's identity on Markdown export",
    () => {
      const md = htmlToMarkdown(
        wrap('<div data-type="transclusionReference" data-id="abc"></div>'),
      );
      // Desired: the referenced id survives so the block can be rebuilt.
      expect(md).toContain("abc");
    },
  );

  it.fails(
    "should NOT lose a mention's data-id on Markdown export",
    () => {
      const md = htmlToMarkdown(
        '<p>hi <span data-type="mention" data-id="u1" data-label="Bob">@Bob</span> there</p>',
      );
      // Desired: the mention keeps its stable identity (data-id), not just text.
      expect(md).toContain("u1");
    },
  );
});
