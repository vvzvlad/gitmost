import { describe, it, expect } from "vitest";
import { generateJSON } from "@tiptap/html";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { htmlToMarkdown } from "../markdown/utils/turndown.utils";
import { markdownToHtml } from "../markdown/utils/marked.utils";
import { TiptapImage } from "./image";

// Minimal schema for parsing markdownToHtml output back to JSON (mirrors
// image.spec.ts), so we can assert the recovered caption EXACTLY.
const parseExtensions = [Document, Paragraph, Text, TiptapImage];

// Lossless markdown round-trip for image captions (issue #221). An image WITH a
// caption can't be expressed as `![alt](src)`, so it is emitted as a raw <img>
// (carrying data-caption) wrapped in a block <div>, the same trick the <video>
// rule uses. marked passes the raw HTML through, so markdownToHtml keeps the
// data-caption, and the image extension's parseHTML restores the attribute.
describe("image caption markdown round-trip", () => {
  it("HTML -> Markdown emits a raw <img data-caption> for captioned images", () => {
    const html = `<p><img src="/files/a.png" alt="cat" data-caption="A grey cat"></p>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("data-caption=\"A grey cat\"");
    expect(md).toContain('src="/files/a.png"');
    expect(md).toContain('alt="cat"');
    // It must NOT degrade to the lossy ![]() form.
    expect(md).not.toContain("![cat]");
  });

  it("Markdown -> HTML restores data-caption on the <img>", async () => {
    const html = `<p><img src="/files/a.png" alt="cat" data-caption="A grey cat"></p>`;
    const md = htmlToMarkdown(html);
    const back = await markdownToHtml(md);
    expect(back).toContain('data-caption="A grey cat"');
    expect(back).toContain('src="/files/a.png"');
  });

  it("special characters in the caption survive the round-trip (escaped)", async () => {
    // The source caption is the decoded string `Tom & "Jerry"` (both an `&` and
    // a `"`). escapeHtmlAttr must encode `&` -> `&amp;` and `"` -> `&quot;`.
    const html = `<p><img src="/files/a.png" data-caption='Tom &amp; &quot;Jerry&quot;'></p>`;
    const md = htmlToMarkdown(html);

    // (a) The intermediate Markdown must carry the EXACT escaped attribute. This
    // fails if escapeHtmlAttr stopped escaping `"` (attribute break-out:
    // data-caption="Tom & "Jerry"") or double-encoded `&` (`&amp;amp;`).
    expect(md).toContain('data-caption="Tom &amp; &quot;Jerry&quot;"');

    const back = await markdownToHtml(md);
    expect(back).toContain("data-caption=");
    expect(back).toContain("Jerry");
    expect(back).toContain("Tom");

    // (b) Re-parse the rendered HTML through the image extension's parseHTML and
    // assert the recovered caption is EXACTLY the original (no corruption, loss,
    // or double-encoding).
    const json = generateJSON(back, parseExtensions);
    expect(json.content?.[0]?.attrs?.caption).toBe('Tom & "Jerry"');
  });

  it("caption-less images stay a clean ![alt](src) with no raw HTML", () => {
    const html = `<p><img src="/files/a.png" alt="cat"></p>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("![cat](/files/a.png)");
    expect(md).not.toContain("data-caption");
    expect(md).not.toContain("<img");
  });
});
