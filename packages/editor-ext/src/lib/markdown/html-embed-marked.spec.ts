import { describe, expect, it } from "vitest";
import { htmlEmbedExtension } from "./utils/html-embed.marked";
import { markdownToHtml } from "./index";
import { encodeHtmlEmbedSource } from "../html-embed/html-embed";

// CONTRACT tests for the marked block tokenizer that rebuilds an htmlEmbed node
// from the `<!--html-embed:BASE64-->` marker (html-embed.marked.ts), plus the
// observable round-trip through markdownToHtml.
//
// These pin the REAL tokenizer behaviour the import path depends on:
//   - the tokenizer rule is anchored (^) and only accepts the base64 alphabet
//     [A-Za-z0-9+/=], so a marker with non-base64 chars is NOT tokenized and
//     survives as a literal HTML comment (not silently turned into something the
//     server's strip no longer recognizes);
//   - start() reports the correct index of the next marker so marked invokes the
//     tokenizer at the right offset when a marker sits mid-document / after text;
//   - a marker with surrounding text on the SAME line is split out into its own
//     embed div while the surrounding text becomes ordinary paragraphs.
//
// The contract is asserted against the actual exported extension and pipeline —
// no behaviour is invented; the expectations were read off the real tokenizer.

const SAMPLE = "<b>x</b>";
const ENC = encodeHtmlEmbedSource(SAMPLE);

describe("htmlEmbed marked tokenizer — start()", () => {
  it("returns the index of a marker that sits mid-document", () => {
    const src = `hello world <!--html-embed:${ENC}-->`;
    expect(htmlEmbedExtension.start(src)).toBe(src.indexOf("<!--html-embed:"));
  });

  it("returns 0 when the marker is at the very start", () => {
    expect(htmlEmbedExtension.start(`<!--html-embed:${ENC}-->`)).toBe(0);
  });

  it("returns -1 when there is no marker", () => {
    expect(htmlEmbedExtension.start("no marker here")).toBe(-1);
  });
});

describe("htmlEmbed marked tokenizer — tokenizer()", () => {
  it("tokenizes a marker at the start of the input, capturing the base64 payload", () => {
    const token = htmlEmbedExtension.tokenizer(`<!--html-embed:${ENC}-->`);
    expect(token).toBeTruthy();
    expect(token!.type).toBe("htmlEmbed");
    expect(token!.raw).toBe(`<!--html-embed:${ENC}-->`);
    expect(token!.encoded).toBe(ENC);
  });

  it("tokenizes an EMPTY marker (the [A-Za-z0-9+/=]* class allows zero chars)", () => {
    const token = htmlEmbedExtension.tokenizer("<!--html-embed:-->");
    expect(token).toBeTruthy();
    expect(token!.encoded).toBe("");
    expect(token!.raw).toBe("<!--html-embed:-->");
  });

  it("does NOT tokenize when text precedes the marker (rule is anchored ^)", () => {
    // marked relies on start() to advance to the marker; the tokenizer itself
    // only matches at offset 0, so a non-anchored call returns undefined.
    expect(
      htmlEmbedExtension.tokenizer(`hello <!--html-embed:${ENC}-->`),
    ).toBeUndefined();
  });

  it("does NOT tokenize a marker containing a non-base64 char ('$')", () => {
    expect(
      htmlEmbedExtension.tokenizer("<!--html-embed:ab$cd-->"),
    ).toBeUndefined();
  });

  it("does NOT tokenize a marker containing a space", () => {
    expect(
      htmlEmbedExtension.tokenizer("<!--html-embed:ab cd-->"),
    ).toBeUndefined();
  });

  it("renderer emits the embed div the node's parseHTML recognizes", () => {
    const token = htmlEmbedExtension.tokenizer(`<!--html-embed:${ENC}-->`)!;
    const html = htmlEmbedExtension.renderer(token as any);
    expect(html).toBe(
      `<div data-type="htmlEmbed" data-source="${ENC}"></div>`,
    );
  });
});

describe("htmlEmbed marked tokenizer — markdownToHtml round-trip", () => {
  it("splits a marker out of surrounding same-line text into its own embed div", async () => {
    const html = await markdownToHtml(`before <!--html-embed:${ENC}--> after`);
    // The marker became the embed div...
    expect(html).toContain(
      `<div data-type="htmlEmbed" data-source="${ENC}"></div>`,
    );
    // ...and the surrounding text survived as ordinary paragraph content.
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("leaves a marker with non-base64 chars as a literal comment (NOT an embed div)", async () => {
    const html = await markdownToHtml("<!--html-embed:ab$cd-->");
    // It is NOT tokenized into an embed div the server would strip...
    expect(html).not.toContain('data-type="htmlEmbed"');
    // ...it passes through unchanged as a literal HTML comment.
    expect(html).toContain("<!--html-embed:ab$cd-->");
  });
});
