import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Details } from "./details";
import { DetailsSummary } from "./details-summary";
import { DetailsContent } from "./details-content";

// The `details` node's `open` attribute must parse to a strict BOOLEAN. The old
// `getAttribute("open")` returned "" (falsy) for `<details open>` and `null`
// when absent, so a parsed-open details rendered without `open` and collapsed.
// `hasAttribute` yields a real boolean, so open state survives parse → render.

const extensions = [
  Document,
  Paragraph,
  Text,
  Details,
  DetailsSummary,
  DetailsContent,
];

/** Parse an HTML string through the schema and return the first details node. */
function parseDetails(html: string): any {
  const editor = new Editor({ extensions, content: html });
  const json = editor.getJSON();
  const find = (n: any): any => {
    if (!n || typeof n !== "object") return undefined;
    if (n.type === "details") return n;
    if (Array.isArray(n.content)) {
      for (const c of n.content) {
        const hit = find(c);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const details = find(json);
  editor.destroy();
  return details;
}

describe("details node: open attribute parses as a strict boolean", () => {
  const body =
    '<summary>S</summary><div data-type="detailsContent"><p>b</p></div>';

  it("parses <details open> to open === true", () => {
    const details = parseDetails(`<details open>${body}</details>`);
    expect(details).toBeDefined();
    expect(details.attrs.open).toBe(true);
  });

  it("parses <details> (no open) to open === false", () => {
    const details = parseDetails(`<details>${body}</details>`);
    expect(details).toBeDefined();
    expect(details.attrs.open).toBe(false);
  });
});
