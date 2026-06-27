import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "../markdown/utils/turndown.utils";
import { markdownToHtml } from "../markdown/utils/marked.utils";

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
    const html = `<p><img src="/files/a.png" data-caption='Tom &amp; &quot;Jerry&quot;'></p>`;
    const md = htmlToMarkdown(html);
    const back = await markdownToHtml(md);
    // parse5 keeps the entity-encoded form inside the attribute value.
    expect(back).toContain("data-caption=");
    expect(back).toContain("Jerry");
    expect(back).toContain("Tom");
  });

  it("caption-less images stay a clean ![alt](src) with no raw HTML", () => {
    const html = `<p><img src="/files/a.png" alt="cat"></p>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("![cat](/files/a.png)");
    expect(md).not.toContain("data-caption");
    expect(md).not.toContain("<img");
  });
});
