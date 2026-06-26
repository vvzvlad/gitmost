import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { generateHTML, generateJSON } from "@tiptap/html";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { PageEmbed } from "./page-embed";

// CONTRACT tests for the PageEmbed node's parse/render round-trip
// (page-embed.ts). The whole-page live embed stores ONLY a `sourcePageId`
// reference; renderHTML must serialize it as `data-source-page-id` and parseHTML
// must recover it. If this attribute mapping drifts, an embed saved to HTML loses
// its target page on reload (the node view would have nothing to fetch).
//
// We assert at the editor-ext schema level using the same Tiptap utilities the
// other editor-ext tests use (getSchema + @tiptap/html generateHTML/generateJSON
// over a jsdom DOM), driving a real HTML -> node JSON -> HTML round-trip through
// the node's actual addAttributes()/parseHTML()/renderHTML().

// Minimal schema: a doc of blocks, plus the PageEmbed block node under test.
const extensions = [Document, Paragraph, Text, PageEmbed];

describe("PageEmbed schema", () => {
  it("registers the pageEmbed node in the schema", () => {
    const schema = getSchema(extensions);
    expect(schema.nodes.pageEmbed).toBeTruthy();
  });
});

describe("PageEmbed parse/render round-trip", () => {
  it("recovers sourcePageId from data-source-page-id on parse (HTML -> JSON)", () => {
    const html = `<div data-type="pageEmbed" data-source-page-id="pg-123"></div>`;
    const json = generateJSON(html, extensions);

    const node = json.content?.[0];
    expect(node?.type).toBe("pageEmbed");
    expect(node?.attrs?.sourcePageId).toBe("pg-123");
  });

  it("emits data-source-page-id on render (JSON -> HTML)", () => {
    const json = {
      type: "doc",
      content: [{ type: "pageEmbed", attrs: { sourcePageId: "pg-456" } }],
    };
    const html = generateHTML(json, extensions);

    expect(html).toContain('data-type="pageEmbed"');
    expect(html).toContain('data-source-page-id="pg-456"');
  });

  it("survives a full HTML -> node -> HTML round-trip (attribute preserved)", () => {
    const start = `<div data-type="pageEmbed" data-source-page-id="pg-789"></div>`;

    // HTML -> node JSON -> HTML.
    const json = generateJSON(start, extensions);
    const html = generateHTML(json, extensions);

    // The id survived the round-trip in the serialized HTML...
    expect(html).toContain('data-source-page-id="pg-789"');

    // ...and re-parsing the round-tripped HTML yields the same id (stable across
    // an extra pass — no loss, no duplication).
    const json2 = generateJSON(html, extensions);
    expect(json2.content?.[0]?.attrs?.sourcePageId).toBe("pg-789");
  });

  it("omits data-source-page-id entirely when sourcePageId is null (renderHTML guard)", () => {
    // The renderHTML maps a null/empty id to {} (no attribute), so an embed
    // without a target page does not emit a stray empty attribute.
    const json = {
      type: "doc",
      content: [{ type: "pageEmbed", attrs: { sourcePageId: null } }],
    };
    const html = generateHTML(json, extensions);

    expect(html).toContain('data-type="pageEmbed"');
    expect(html).not.toContain("data-source-page-id");
  });

  it("parses a div without the attribute to a null sourcePageId (default)", () => {
    const html = `<div data-type="pageEmbed"></div>`;
    const json = generateJSON(html, extensions);

    expect(json.content?.[0]?.type).toBe("pageEmbed");
    // getAttribute returns null when absent; parseHTML returns it verbatim.
    expect(json.content?.[0]?.attrs?.sourcePageId).toBeNull();
  });
});
