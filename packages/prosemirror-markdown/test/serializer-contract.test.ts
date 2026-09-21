import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";

import { docmostExtensions } from "../src/lib/docmost-schema.js";
import { convertProseMirrorToMarkdown } from "../src/lib/markdown-converter.js";
import { markdownToProseMirror } from "../src/lib/markdown-to-prosemirror.js";

/**
 * SERIALIZER-CONTRACT GUARD (#293 canon #inventory, bug 3).
 *
 * The markdown serializer (`convertProseMirrorToMarkdown`) dispatches on
 * `node.type` in a big `switch`. Any node type that reaches the `default` arm
 * is NOT serialized as itself — it silently collapses to its children's text
 * (or, for an ATOM node with no children, to the empty string). The canon
 * inventory flagged exactly this class: had the editor schema declared inline
 * atoms like `emoji`/`date`/`toc`, a document could carry one and the converter
 * would drop it with no case and no error (a git-sync data-loss on the data
 * path).
 *
 * INVARIANT: every node type declared in the package schema
 * (`docmostExtensions`) has an EXPLICIT serializer case. This test derives the
 * node-type set from the live schema and asserts a `case "<name>":` exists in
 * the serializer source for each. A future node added to the schema WITHOUT a
 * serializer case (the emoji/date/toc failure mode) fails here loudly.
 *
 * We scan the SOURCE (not behavioral output) because it is the only formulation
 * that reliably catches a missing case for EVERY node kind: a missing case on a
 * *container* node still emits its children via `default` (non-empty output, so
 * a behavioral non-empty check would pass while structure was lost), whereas the
 * source scan catches the drop regardless of whether the node is an atom or a
 * container. A complementary behavioral check for the atom case follows.
 */

const SERIALIZER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/markdown-converter.ts", import.meta.url)),
  "utf8",
);

function schemaNodeNames(): string[] {
  const schema = getSchema(docmostExtensions as never);
  return Object.keys(schema.nodes).sort();
}

describe("serializer contract: every schema node type has a serializer case", () => {
  const nodeNames = schemaNodeNames();

  it("covers a known, non-trivial set of node types", () => {
    // Sanity: the schema really does expose the full Docmost node surface, so
    // this test is not vacuously iterating an empty/tiny list.
    expect(nodeNames.length).toBeGreaterThanOrEqual(40);
    // A representative atom that would silently drop without a case.
    expect(nodeNames).toContain("status");
    expect(nodeNames).toContain("mention");
  });

  for (const name of schemaNodeNames()) {
    it(`serializer has an explicit case for node type "${name}"`, () => {
      // Node names and mark names never collide, so a `case "<node>"` anywhere
      // in the serializer is that node's case (marks have distinct names).
      const pattern = new RegExp(`case "${name}"\\s*:`);
      expect(
        pattern.test(SERIALIZER_SOURCE),
        `Node type "${name}" is declared in the package schema but has no ` +
          `case "${name}": in convertProseMirrorToMarkdown — it would fall ` +
          `through to the default arm and be silently dropped on git-sync ` +
          `export. Add a lossless serializer case (see mention/status).`,
      ).toBe(true);
    });
  }
});

/**
 * Behavioral complement: an INLINE ATOM with no serializer case collapses to
 * "" via the default arm (exactly the emoji/date/toc risk). Prove that the two
 * inline atoms the schema actually declares (mention, status) do NOT vanish —
 * i.e. the default-drop path is not reached for them. This is the runtime shape
 * the source-scan invariant protects.
 */
describe("serializer contract: inline atoms are not dropped to empty", () => {
  const P = (...c: any[]) => ({ type: "paragraph", content: c });
  const doc = (...c: any[]) => ({ type: "doc", content: c });

  it("mention serializes to non-empty output", () => {
    const md = convertProseMirrorToMarkdown(
      doc(P({ type: "mention", attrs: { id: "u1", label: "Bob" } })),
    );
    expect(md.trim()).not.toBe("");
    expect(md).toContain('data-type="mention"');
  });

  it("status serializes to non-empty output", () => {
    const md = convertProseMirrorToMarkdown(
      doc(P({ type: "status", attrs: { text: "Done", color: "green" } })),
    );
    expect(md.trim()).not.toBe("");
    expect(md).toContain('data-type="status"');
  });
});

/**
 * Raw-HTML path (columns) round-trips for the two marks fixed alongside the
 * contract test. A column renders its inline content via `inlineToHtml`, whose
 * mark switch previously lacked a `spoiler` case (bug 1) and dropped a link's
 * `title` (bug 2).
 */

// Walk a ProseMirror tree and return the first text run whose marks include the
// given mark type, or undefined.
function findMarkedText(n: any, markType: string): any {
  if (!n || typeof n !== "object") return undefined;
  if (
    n.type === "text" &&
    Array.isArray(n.marks) &&
    n.marks.some((m: any) => m?.type === markType)
  ) {
    return n;
  }
  if (Array.isArray(n.content)) {
    for (const c of n.content) {
      const hit = findMarkedText(c, markType);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("raw-HTML path (columns): spoiler + link title round-trip", () => {
  const P = (...c: any[]) => ({ type: "paragraph", content: c });
  const doc = (...c: any[]) => ({ type: "doc", content: c });
  const column = (...c: any[]) => ({
    type: "column",
    attrs: { width: "50%" },
    content: c,
  });

  it("bug 1: a spoiler mark inside a column survives the round trip", async () => {
    const original = doc({
      type: "columns",
      content: [
        column(P({ type: "text", text: "hidden", marks: [{ type: "spoiler" }] })),
        column(P({ type: "text", text: "plain" })),
      ],
    });
    const md = convertProseMirrorToMarkdown(original);
    // The raw-HTML path must emit the schema's spoiler span (RED before bug 1
    // fix: inlineToHtml had no spoiler case, so the mark was dropped and the
    // text emitted bare).
    expect(md).toContain('data-spoiler="true"');
    expect(md).toContain("<span data-spoiler=\"true\">hidden</span>");

    const back = await markdownToProseMirror(md);
    const spoilered = findMarkedText(back, "spoiler");
    expect(spoilered).toBeDefined();
    expect(spoilered.text).toBe("hidden");
  });

  it("bug 2: a link with a title inside a column keeps its title", async () => {
    const original = doc({
      type: "columns",
      content: [
        column(
          P({
            type: "text",
            text: "site",
            marks: [
              {
                type: "link",
                attrs: { href: "https://example.com", title: "Example Title" },
              },
            ],
          }),
        ),
        column(P({ type: "text", text: "plain" })),
      ],
    });
    const md = convertProseMirrorToMarkdown(original);
    // The raw-HTML anchor must carry the title (RED before bug 2 fix:
    // inlineToHtml emitted <a href> with no title).
    expect(md).toContain('title="Example Title"');
    expect(md).toContain('href="https://example.com"');

    const back = await markdownToProseMirror(md);
    const linked = findMarkedText(back, "link");
    expect(linked).toBeDefined();
    const linkMark = linked.marks.find((m: any) => m.type === "link");
    expect(linkMark.attrs?.href).toBe("https://example.com");
    // The schema's link mark carries `title`; it must round-trip through the
    // raw-HTML column path.
    expect(linkMark.attrs?.title).toBe("Example Title");
  });
});
