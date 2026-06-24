import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Node as PMNode, Fragment, Slice } from "@tiptap/pm/model";
import { FootnoteReference } from "./footnote-reference";
import { FootnotesList } from "./footnotes-list";
import { FootnoteDefinition } from "./footnote-definition";
import { footnotePastePlugin } from "./footnote-sync";
import {
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTES_LIST_NAME,
} from "./footnote-util";

// transformPasted reuse semantics (#166): a pasted reference to an id that
// already exists must KEEP the id (reuse → resolves to the existing footnote);
// only a pasted DEFINITION that collides is re-id'd (it would otherwise clobber
// the existing definition's text), and its paired references follow it.

const extensions = [
  Document,
  Paragraph,
  Text,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
];

/** An editor whose doc already contains footnote "a" (ref + definition). */
function makeEditorWithFootnoteA() {
  return new Editor({
    extensions,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "x" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "a" } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "a" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "note A" }] },
              ],
            },
          ],
        },
      ],
    },
  });
}

/** Run footnotePastePlugin's transformPasted against the editor's current doc. */
function paste(editor: Editor, slice: Slice): Slice {
  const plugin = footnotePastePlugin();
  return plugin.props!.transformPasted!(slice, editor.view);
}

/** Collect the ids of footnote refs/defs in a slice, in order (single DFS). */
function sliceFootnoteIds(slice: Slice): Array<{ kind: string; id: string }> {
  const out: Array<{ kind: string; id: string }> = [];
  const walk = (frag: Fragment) => {
    frag.forEach((node: PMNode) => {
      if (node.type.name === FOOTNOTE_REFERENCE_NAME)
        out.push({ kind: "ref", id: node.attrs.id });
      if (node.type.name === FOOTNOTE_DEFINITION_NAME)
        out.push({ kind: "def", id: node.attrs.id });
      walk(node.content);
    });
  };
  walk(slice.content);
  return out;
}

describe("footnotePastePlugin — reuse-aware id remap", () => {
  it("keeps a pasted lone reference to an existing id (reuse, no remap)", () => {
    const editor = makeEditorWithFootnoteA();
    const { schema } = editor;
    // Paste: a paragraph containing only a reference to the existing id "a".
    const slice = new Slice(
      Fragment.from(
        schema.nodes.paragraph.create(null, [
          schema.text("see "),
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "a" }),
        ]),
      ),
      0,
      0,
    );
    const out = paste(editor, slice);
    // The reference keeps id "a" so it reuses the existing footnote.
    expect(sliceFootnoteIds(out)).toEqual([{ kind: "ref", id: "a" }]);
    editor.destroy();
  });

  it("re-ids a pasted DEFINITION (and its paired reference) that collides", () => {
    const editor = makeEditorWithFootnoteA();
    const { schema } = editor;
    // Paste: a reference AND a definition both carrying the existing id "a". The
    // definition would clobber the existing one, so both are remapped together.
    const slice = new Slice(
      Fragment.fromArray([
        schema.nodes.paragraph.create(null, [
          schema.text("dup "),
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "a" }),
        ]),
        schema.nodes[FOOTNOTES_LIST_NAME].create(null, [
          schema.nodes[FOOTNOTE_DEFINITION_NAME].create({ id: "a" }, [
            schema.nodes.paragraph.create(null, [schema.text("pasted note")]),
          ]),
        ]),
      ]),
      0,
      0,
    );
    const out = paste(editor, slice);
    const ids = sliceFootnoteIds(out);
    // Both the pasted ref and def were remapped to the SAME fresh id (paired),
    // and it is the deterministic derived id (not "a").
    const remappedIds = new Set(ids.map((x) => x.id));
    expect(remappedIds.size).toBe(1);
    expect(remappedIds.has("a")).toBe(false);
    expect([...remappedIds][0]).toBe("a__2");
    editor.destroy();
  });

  it("leaves the slice untouched when no pasted definition collides", () => {
    const editor = makeEditorWithFootnoteA();
    const { schema } = editor;
    // A pasted reference+definition for a BRAND-NEW id "b" — no collision.
    const slice = new Slice(
      Fragment.fromArray([
        schema.nodes.paragraph.create(null, [
          schema.text("new "),
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "b" }),
        ]),
        schema.nodes[FOOTNOTES_LIST_NAME].create(null, [
          schema.nodes[FOOTNOTE_DEFINITION_NAME].create({ id: "b" }, [
            schema.nodes.paragraph.create(null, [schema.text("note B")]),
          ]),
        ]),
      ]),
      0,
      0,
    );
    const out = paste(editor, slice);
    expect(sliceFootnoteIds(out)).toEqual([
      { kind: "ref", id: "b" },
      { kind: "def", id: "b" },
    ]);
    editor.destroy();
  });
});
