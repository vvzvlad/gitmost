import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import { generateHTML, generateJSON } from "@tiptap/html";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { htmlToMarkdown } from "./turndown.utils";
import { markdownToHtml } from "./marked.utils";
import { Spoiler } from "../../spoiler/spoiler";

// The spoiler mark has no native Markdown syntax, so it is preserved losslessly
// as raw inline HTML (`<span data-spoiler="true">…</span>`), the same approach
// htmlEmbed uses. This test drives the full editor round-trip:
//   JSON -> HTML -> Markdown -> HTML -> JSON
// and asserts the `spoiler` mark survives end to end. We use the same
// getSchema + @tiptap/html generateHTML/generateJSON utilities the other
// editor-ext schema tests use.

const extensions = [Document, Paragraph, Text, Bold, Spoiler];

function html(md: string): string {
  const out = markdownToHtml(md);
  if (typeof out !== "string") throw new Error("expected sync string output");
  return out;
}

// Count text nodes carrying a `spoiler` mark anywhere in a ProseMirror JSON doc.
function countSpoilerMarks(doc: any): number {
  let count = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark?.type === "spoiler") count++;
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return count;
}

describe("Spoiler mark schema", () => {
  it("registers the spoiler mark in the schema", () => {
    const schema = getSchema(extensions);
    expect(schema.marks.spoiler).toBeTruthy();
  });

  it("recovers the spoiler mark from span[data-spoiler] (HTML -> JSON)", () => {
    const json = generateJSON(
      '<p>before <span data-spoiler="true">hidden</span> after</p>',
      extensions,
    );
    expect(countSpoilerMarks(json)).toBe(1);
  });

  it("emits data-spoiler + class on render (JSON -> HTML)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "hidden",
              marks: [{ type: "spoiler" }],
            },
          ],
        },
      ],
    };
    const out = generateHTML(doc, extensions);
    expect(out).toContain('data-spoiler="true"');
    expect(out).toContain('class="spoiler"');
  });
});

describe("Spoiler Markdown round-trip is lossless", () => {
  const docWith = (textNode: any) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "before " }, textNode, { type: "text", text: " after" }],
      },
    ],
  });

  it("preserves the spoiler mark through JSON -> MD -> HTML -> JSON", () => {
    const startDoc = docWith({
      type: "text",
      text: "hidden",
      marks: [{ type: "spoiler" }],
    });

    // JSON -> HTML
    const html1 = generateHTML(startDoc, extensions);
    expect(html1).toContain('data-spoiler="true"');

    // HTML -> Markdown (raw inline HTML, lossless)
    const md = htmlToMarkdown(html1);
    expect(md).toContain('<span data-spoiler="true">hidden</span>');

    // MD -> HTML -> JSON (mark restored via parseHTML)
    const endJson = generateJSON(html(md), extensions);
    expect(countSpoilerMarks(endJson)).toBe(1);
    // The visible text survives.
    expect(JSON.stringify(endJson)).toContain("hidden");
  });

  it("keeps the spoiler intact when it intersects a bold mark", () => {
    const startDoc = docWith({
      type: "text",
      text: "secret",
      marks: [{ type: "bold" }, { type: "spoiler" }],
    });

    const md = htmlToMarkdown(generateHTML(startDoc, extensions));
    expect(md).toContain("data-spoiler=\"true\"");

    const endJson = generateJSON(html(md), extensions);
    expect(countSpoilerMarks(endJson)).toBe(1);
    // Bold survives alongside the spoiler.
    expect(JSON.stringify(endJson)).toContain('"bold"');
  });
});
