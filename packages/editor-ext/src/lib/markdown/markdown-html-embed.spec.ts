import { describe, it, expect } from "vitest";
import { markdownToHtml, htmlToMarkdown } from "./index";
import {
  encodeHtmlEmbedSource,
  decodeHtmlEmbedSource,
} from "../html-embed/html-embed";

// SECURITY (Variant C admin gate, import attack surface).
//
// The markdown import path is the only write path where an htmlEmbed reaches
// the server purely from file bytes (no editor / collab socket). The marked
// tokenizer in `html-embed.marked.ts` and the turndown rule in
// `turndown.utils.ts` are what materialize the `<!--html-embed:BASE64-->`
// marker into the `<div data-type="htmlEmbed" data-source="BASE64">` element
// that the server then parses into an htmlEmbed node and the admin gate strips.
//
// If either the tokenizer regex or the turndown rule shape drifts, the marker
// would either (a) stop becoming an htmlEmbed node (silently dropping admin
// content) or (b) become some OTHER tag the server's `hasHtmlEmbedNode` no
// longer recognizes (a strip bypass). These tests pin the marker <-> embed-div
// contract that the server-side strip relies on. editor-ext had ZERO tests
// before this file; this adds the runner + the round-trip coverage.

// The server parses the embed div by matching `data-type="htmlEmbed"` and
// decoding `data-source`; mirror that here so the assertion is exactly what the
// real `htmlToJson` -> htmlEmbed node parse depends on (the node's parseHTML in
// html-embed.ts uses the same selector + decodeHtmlEmbedSource).
const EMBED_DIV_RE = /<div[^>]*\bdata-type="htmlEmbed"[^>]*>/;
function extractEmbedSource(html: string): string | undefined {
  const div = EMBED_DIV_RE.exec(html);
  if (!div) return undefined;
  const enc = /data-source="([^"]*)"/.exec(div[0]);
  if (!enc) return undefined;
  return decodeHtmlEmbedSource(enc[1]);
}

// Replicates the server's `hasHtmlEmbedNode` decision against the embed *div*
// (the HTML form the server immediately converts to JSON). If this matches, the
// server's JSON-level `hasHtmlEmbedNode` will too, because htmlToJson maps this
// exact div to an htmlEmbed node.
function htmlHasHtmlEmbed(html: string): boolean {
  return EMBED_DIV_RE.test(html);
}

describe("markdown <!--html-embed--> import round-trip", () => {
  const source = "<script>x</script>";

  it("markdownToHtml turns the marker into an htmlEmbed div carrying the source", async () => {
    const md = "<!--html-embed:" + encodeHtmlEmbedSource(source) + "-->";
    const html = await markdownToHtml(md);

    // The marker became the embed div the server recognizes as an htmlEmbed
    // node (so the server's hasHtmlEmbedNode would match it after htmlToJson).
    expect(htmlHasHtmlEmbed(html)).toBe(true);
    // The decoded source is the original script, intact.
    expect(extractEmbedSource(html)).toBe(source);
    // The raw script is NOT inlined into the HTML — it stays base64 in the
    // attribute (the marker itself must not be a direct injection vector).
    expect(html).not.toContain("<script>x</script>");
  });

  it("preserves UTF-8 / special chars in the embedded source", async () => {
    const utf8 = '<script>console.log("héllo → 世界")</script>';
    const md = "<!--html-embed:" + encodeHtmlEmbedSource(utf8) + "-->";
    const html = await markdownToHtml(md);
    expect(htmlHasHtmlEmbed(html)).toBe(true);
    expect(extractEmbedSource(html)).toBe(utf8);
  });

  it("an empty marker still produces an htmlEmbed div (empty source)", async () => {
    const html = await markdownToHtml("<!--html-embed:-->");
    expect(htmlHasHtmlEmbed(html)).toBe(true);
    expect(extractEmbedSource(html)).toBe("");
  });

  it("round-trips htmlToMarkdown -> markdownToHtml preserving the embed marker", async () => {
    const encoded = encodeHtmlEmbedSource(source);
    // NOTE: turndown drops a *blank* (childless) element before any custom rule
    // runs, and the htmlEmbed div is normally childless. The export pipeline
    // therefore must give the rule a non-blank div to fire on; we add an inert
    // text child here to exercise the real turndown htmlEmbed rule. (A blank
    // embed div serializing to "" is asserted separately below as a documented
    // edge so this contract drift is visible.)
    const startHtml = `<div data-type="htmlEmbed" data-source="${encoded}">x</div>`;

    // Export to markdown: the turndown rule emits the <!--html-embed:..-->
    // marker (lossless, inert in plain markdown viewers).
    const md = htmlToMarkdown(startHtml);
    expect(md).toContain("<!--html-embed:" + encoded + "-->");

    // Re-import: the marker round-trips back into an embed div with the same
    // decoded source — this is the marker <-> embed-div contract the server's
    // import strip depends on.
    const html = await markdownToHtml(md);
    expect(htmlHasHtmlEmbed(html)).toBe(true);
    expect(extractEmbedSource(html)).toBe(source);
  });

  it("documents that a BLANK embed div serializes to empty markdown (turndown drops childless blocks)", () => {
    const encoded = encodeHtmlEmbedSource(source);
    const blank = `<div data-type="htmlEmbed" data-source="${encoded}"></div>`;
    // This pins current behavior so a future change to the turndown rule (e.g.
    // making it fire on blank nodes) is caught rather than silently shipping.
    expect(htmlToMarkdown(blank)).toBe("");
  });

  it("the base64 codec itself round-trips (no '<' leaks into the attribute)", () => {
    const encoded = encodeHtmlEmbedSource(source);
    expect(encoded).not.toContain("<");
    expect(decodeHtmlEmbedSource(encoded)).toBe(source);
  });
});
