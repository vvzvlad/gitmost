import { describe, expect, it } from "vitest";
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
} from "docmost-client";

// Round-trip coverage for the two editor features git-sync's converter
// predated and must now preserve losslessly:
//   - the `spoiler` inline mark (issue #259), emitted as raw inline HTML
//     `<span data-spoiler="true">…</span>` (Markdown has no native syntax);
//   - the image `caption` attribute (issue #221). A top-level image now emits
//     it in an attached `<!--img {…}-->` comment (#293 canon #4); a raw <img>
//     with `data-caption` in incoming Markdown still parses it back too.
// We exercise the real export -> import -> export cycle: a PM doc must survive
// PM -> MD -> PM unchanged, and the raw-HTML forms in incoming Markdown must
// parse back to the mark/attribute.

const doc = (...nodes: any[]) => ({ type: "doc", content: nodes });
const text = (t: string, marks?: any[]) =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };
const para = (...inline: any[]) => ({ type: "paragraph", content: inline });

// Count text nodes carrying a `spoiler` mark anywhere in a PM JSON doc.
function countSpoilerMarks(node: any): number {
  let count = 0;
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n.marks)) {
      for (const mark of n.marks) if (mark?.type === "spoiler") count++;
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(node);
  return count;
}

// Find the first image node anywhere in a PM JSON doc.
function findImage(node: any): any | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "image") return node;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const hit = findImage(child);
      if (hit) return hit;
    }
  }
  return null;
}

describe("spoiler mark round-trip (#259)", () => {
  it("survives export -> import -> export unchanged", async () => {
    const source = doc(
      para(
        text("before "),
        text("hidden", [{ type: "spoiler" }]),
        text(" after"),
      ),
    );

    const md1 = convertProseMirrorToMarkdown(source);
    // Lossless raw inline HTML form.
    expect(md1).toContain('<span data-spoiler="true">hidden</span>');

    const doc2 = await markdownToProseMirror(md1);
    // The spoiler mark was recovered on import.
    expect(countSpoilerMarks(doc2)).toBe(1);
    expect(JSON.stringify(doc2)).toContain("hidden");

    // Byte-stable: a second export reproduces the first exactly.
    const md2 = convertProseMirrorToMarkdown(doc2);
    expect(md2).toBe(md1);
  });

  it("keeps the spoiler intact when it intersects a bold mark", async () => {
    const source = doc(
      para(text("secret", [{ type: "bold" }, { type: "spoiler" }])),
    );

    const md1 = convertProseMirrorToMarkdown(source);
    expect(md1).toContain('data-spoiler="true"');

    const doc2 = await markdownToProseMirror(md1);
    expect(countSpoilerMarks(doc2)).toBe(1);
    // Bold survives alongside the spoiler.
    expect(JSON.stringify(doc2)).toContain('"bold"');
  });

  it("parses a raw <span data-spoiler> in incoming Markdown back to the mark", async () => {
    const incoming = 'before <span data-spoiler="true">hidden</span> after';
    const parsed = await markdownToProseMirror(incoming);
    expect(countSpoilerMarks(parsed)).toBe(1);
  });
});

describe("image caption round-trip (#221)", () => {
  it("survives export -> import -> export with the caption preserved", async () => {
    const source = doc({
      type: "image",
      attrs: { src: "/files/a.png", alt: "cat", caption: "A grey cat" },
    });

    const md1 = convertProseMirrorToMarkdown(source);
    // #293 canon #4: a top-level captioned image now serializes as the clean
    // `![alt](src)` plus an attached `<!--img {…}-->` comment carrying caption.
    expect(md1).toBe('![cat](/files/a.png) <!--img {"caption":"A grey cat"}-->');

    const doc2 = await markdownToProseMirror(md1);
    const img = findImage(doc2);
    expect(img).toBeTruthy();
    expect(img.attrs?.caption).toBe("A grey cat");

    // Byte-stable: a second export reproduces the first exactly.
    const md2 = convertProseMirrorToMarkdown(doc2);
    expect(md2).toBe(md1);
  });

  it("parses a raw <img data-caption> in incoming Markdown back to the caption", async () => {
    const incoming = '<img src="/files/a.png" alt="cat" data-caption="A grey cat">';
    const parsed = await markdownToProseMirror(incoming);
    const img = findImage(parsed);
    expect(img).toBeTruthy();
    expect(img.attrs?.caption).toBe("A grey cat");
  });

  it("leaves a caption-less image on the lighter markdown form", () => {
    const md = convertProseMirrorToMarkdown(
      doc({ type: "image", attrs: { src: "/files/a.png", alt: "cat" } }),
    );
    expect(md).toBe("![cat](/files/a.png)");
  });
});
