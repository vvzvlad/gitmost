import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";

import { markdownToProseMirror } from "@docmost/prosemirror-markdown";
import { docmostExtensions } from "@docmost/prosemirror-markdown";

// REGRESSION LOCK for the stripEmptyParagraphs schema-validity guard.
//
// markdownToProseMirror removes empty `paragraph` nodes that the import leaves
// behind when a block atom (e.g. a block image) is hoisted out of marked's
// wrapping <p> — they cause phantom blank-gap diffs on every sync. But several
// schema nodes REQUIRE non-empty block content (`content: "block+"`): tableCell,
// tableHeader, blockquote, column, callout, and the doc root. For an empty one of
// those, generateJSON materializes a single empty paragraph as its OBLIGATORY
// content. Stripping that would produce a schema-INVALID doc (`content: []`),
// which crashes any consumer that validates the public markdownToProseMirror
// output via ProseMirror's Node.check() / nodeFromJSON. The guard keeps one empty
// paragraph when removal would empty such a container; these tests pin that.

const schema = getSchema(docmostExtensions as any);

/** Throws if the JSON doc is not valid against the Docmost schema. */
function assertSchemaValid(doc: unknown): void {
  schema.nodeFromJSON(doc).check();
}

describe("stripEmptyParagraphs keeps the import schema-valid", () => {
  it("an empty GFM table cell round-trips to a schema-valid doc", async () => {
    const doc = await markdownToProseMirror(
      "| a |   |\n|---|---|\n| x | y |\n",
    );
    expect(() => assertSchemaValid(doc)).not.toThrow();
  });

  it("an empty blockquote stays schema-valid", async () => {
    const doc = await markdownToProseMirror("> \n");
    expect(() => assertSchemaValid(doc)).not.toThrow();
  });

  it("an empty document stays schema-valid", async () => {
    const doc = await markdownToProseMirror("\n\n");
    expect(() => assertSchemaValid(doc)).not.toThrow();
  });

  it("still removes the empty hoist-artifact paragraph beside a block image", async () => {
    const doc = await markdownToProseMirror("p\n\n![x](http://a.aa)\n\nq\n");
    const emptyParas = ((doc as { content?: any[] }).content ?? []).filter(
      (n: any) =>
        n.type === "paragraph" &&
        (!Array.isArray(n.content) || n.content.length === 0),
    );
    // The artifact paragraph must be gone (no phantom blank-gap on re-export)...
    expect(emptyParas).toHaveLength(0);
    // ...and the result is still a valid doc.
    expect(() => assertSchemaValid(doc)).not.toThrow();
  });
});
