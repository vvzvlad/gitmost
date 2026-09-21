import { describe, expect, it } from "vitest";
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import { convertProseMirrorToMarkdown } from "../src/lib/markdown-converter.js";
import { markdownToProseMirror } from "../src/lib/markdown-to-prosemirror.js";

/**
 * #493 commit 1 — the paragraph serializer's leading-block-escape closes the
 * data-loss class where a paragraph whose text opens at column 0 with a markdown
 * block trigger (`#`/`-`/`*`/`+`/`>`, an ordered `N.`/`N)`, a code fence, a
 * table `|`, a callout opener, or a thematic break) silently re-parsed into a
 * heading / list / quote / code block / table / horizontalRule on the git-sync
 * doc -> markdown -> doc cycle. The thematic-break case was the worst: a
 * horizontalRule carries NO text, so the line's text was lost entirely.
 *
 * This is the deterministic PIN, one assertion per trigger, exercised through
 * the REAL converter round-trip (not a mock): each bare trigger line now
 * round-trips as a SINGLE paragraph with its text byte-preserved — proving the
 * class is closed WITHOUT the former client-side ZWSP workaround (removed) or
 * the generative suite's leading-word self-censorship (removed).
 */

const doc = (...nodes: any[]) => ({ type: "doc", content: nodes });
const para = (t: string) => ({
  type: "paragraph",
  content: [{ type: "text", text: t }],
});

const roundtrip = async (text: string) => {
  const md = convertProseMirrorToMarkdown(doc(para(text)));
  const back = await markdownToProseMirror(md);
  return back.content as any[];
};

describe("paragraph block-escape (git-sync round-trip)", () => {
  // Every line here, at column 0, WOULD (pre-fix) re-parse into a non-paragraph
  // block. Each is now block-escaped by the serializer and round-trips clean.
  const triggerLines = [
    "- dash",
    "* star",
    "+ plus",
    "> quote",
    "# hash",
    "## two hash",
    "###### six hash",
    "1. one",
    "1) one",
    "> [!info] note",
    "```js",
    "~~~",
    "| a | b |",
    // Solid + spaced thematic breaks — the text-LOSING case pre-fix.
    "---",
    "***",
    "___",
    "- - -",
    "_ _ _",
  ];

  it("every bare trigger line round-trips as a single paragraph, text byte-preserved", async () => {
    for (const line of triggerLines) {
      const blocks = await roundtrip(line);
      expect(blocks, `"${line}" should be one block`).toHaveLength(1);
      expect(blocks[0].type, `"${line}" should stay a paragraph`).toBe(
        "paragraph",
      );
      expect(
        blocks[0].content?.[0]?.text,
        `"${line}" text should survive byte-exact`,
      ).toBe(line);
    }
  });

  it("emphasis / inline-code paragraphs are NOT escaped (no backslash churn)", async () => {
    // These open with `*`/`` ` `` but are NOT block triggers; the serialized
    // markdown must not gain a stray leading backslash, and they round-trip.
    for (const [text, mark] of [
      ["bold", "bold"],
      ["italic", "italic"],
      ["code", "code"],
    ] as const) {
      const node = doc({
        type: "paragraph",
        content: [{ type: "text", text, marks: [{ type: mark }] }],
      });
      const md = convertProseMirrorToMarkdown(node);
      expect(md.startsWith("\\"), `${mark} must not be block-escaped`).toBe(
        false,
      );
      const back = await markdownToProseMirror(md);
      expect(back.content[0].type).toBe("paragraph");
      expect(back.content[0].content[0].text).toBe(text);
      expect(back.content[0].content[0].marks?.[0]?.type).toBe(mark);
    }
  });

  it("a block trigger on a CONTINUATION line (after a hardBreak) is escaped too", async () => {
    // A hardBreak serializes as `  \n`, so a trigger on the second line would,
    // without a per-line escape, re-parse into another block. The worst case is
    // `---`: a setext underline would turn the first line into a heading and LOSE
    // the `---` text entirely. Each pair round-trips as ONE paragraph with the
    // hardBreak and both texts preserved.
    for (const [first, second] of [
      ["a", "# b"],
      ["a", "- b"],
      ["a", "> b"],
      ["a", "1. b"],
      ["a", "| b |"],
      ["a", "---"], // setext / thematic (3 dashes) — the text-losing case
      ["a", "--"], // setext underline, EXACTLY two dashes (bullet/thematic miss it)
      ["a", "----"], // setext / thematic (4 dashes)
      ["a", "="], // setext H1 underline, a lone `=` (no other arm covers it)
      ["a", "===="], // setext H1 underline, run of `=`
    ]) {
      const d = doc({
        type: "paragraph",
        content: [
          { type: "text", text: first },
          { type: "hardBreak" },
          { type: "text", text: second },
        ],
      });
      const back = await markdownToProseMirror(convertProseMirrorToMarkdown(d));
      expect(back.content, `"${first}⏎${second}" should be one block`).toHaveLength(1);
      expect(back.content[0].type).toBe("paragraph");
      const texts = (back.content[0].content as any[])
        .filter((n) => n.type === "text")
        .map((n) => n.text);
      const hasBreak = (back.content[0].content as any[]).some(
        (n) => n.type === "hardBreak",
      );
      expect(hasBreak, `"${first}⏎${second}" should keep the hardBreak`).toBe(true);
      expect(texts, `"${first}⏎${second}" should preserve both line texts`).toEqual([
        first,
        second,
      ]);
    }
  });

  it("normal host-prefixed lines round-trip byte-exact (unaffected)", async () => {
    for (const line of [
      "You: hello there",
      "Speaker 1: - and then a dash mid-line",
      "Speaker 2: 1. not a list",
    ]) {
      const blocks = await roundtrip(line);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("paragraph");
      expect(blocks[0].content[0].text).toBe(line);
    }
  });
});
