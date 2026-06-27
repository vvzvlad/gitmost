import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Node as PMNode, Fragment, Slice } from "@tiptap/pm/model";
import {
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTE_DEFINITION_NAME,
  FOOTNOTES_LIST_NAME,
} from "@docmost/editor-ext";
import { canonicalizePastedFootnotes } from "./markdown-clipboard";

/**
 * A markdown paste builds its ProseMirror fragment via DOM -> parseSlice and is
 * applied with a manual transaction (handlePaste returns true), so it bypasses
 * the editor's footnoteSyncPlugin — which never reorders an existing list. These
 * tests pin canonicalizePastedFootnotes, the focused hook that makes a pasted
 * out-of-order markdown footnote block come out canonical (issue #228).
 */

const extensions = [
  Document,
  Paragraph,
  Text,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
];

function makeSchema() {
  const editor = new Editor({ extensions, content: { type: "doc", content: [] } });
  const { schema } = editor;
  return { editor, schema };
}

/** List footnote def ids of the (single) footnotesList in a slice, in order. */
function listIds(slice: Slice): string[] {
  const out: string[] = [];
  slice.content.forEach((node: PMNode) => {
    if (node.type.name === FOOTNOTES_LIST_NAME) {
      node.content.forEach((def: PMNode) => {
        if (def.type.name === FOOTNOTE_DEFINITION_NAME) out.push(def.attrs.id);
      });
    }
  });
  return out;
}

function hasList(slice: Slice): boolean {
  let found = false;
  slice.content.forEach((n: PMNode) => {
    if (n.type.name === FOOTNOTES_LIST_NAME) found = true;
  });
  return found;
}

describe("canonicalizePastedFootnotes", () => {
  it("reorders a pasted block to reference order, dedups reuse, drops orphans", () => {
    const { editor, schema } = makeSchema();
    // Body references c, a, b (and again a => reuse); definitions a, b, c, z
    // (z is an orphan) — the exact shape a markdown paste produces.
    const slice = new Slice(
      Fragment.fromArray([
        schema.nodes.paragraph.create(null, [
          schema.text("body "),
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "c" }),
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "a" }),
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "b" }),
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "a" }),
        ]),
        schema.nodes[FOOTNOTES_LIST_NAME].create(null, [
          schema.nodes[FOOTNOTE_DEFINITION_NAME].create({ id: "a" }, [
            schema.nodes.paragraph.create(null, [schema.text("note A")]),
          ]),
          schema.nodes[FOOTNOTE_DEFINITION_NAME].create({ id: "b" }, [
            schema.nodes.paragraph.create(null, [schema.text("note B")]),
          ]),
          schema.nodes[FOOTNOTE_DEFINITION_NAME].create({ id: "c" }, [
            schema.nodes.paragraph.create(null, [schema.text("note C")]),
          ]),
          schema.nodes[FOOTNOTE_DEFINITION_NAME].create({ id: "z" }, [
            schema.nodes.paragraph.create(null, [schema.text("orphan")]),
          ]),
        ]),
      ]),
      0,
      0,
    );

    const out = canonicalizePastedFootnotes(slice, schema);
    // Reference order, orphan z dropped, reused a appears once.
    expect(listIds(out)).toEqual(["c", "a", "b"]);
    editor.destroy();
  });

  it("leaves a reference-ONLY paste untouched (no synthesized definitions)", () => {
    // A paste that reuses an id defined in the TARGET doc must NOT gain a
    // synthesized empty definition here — it carries no footnotesList of its own.
    const { editor, schema } = makeSchema();
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
    const out = canonicalizePastedFootnotes(slice, schema);
    expect(hasList(out)).toBe(false);
    expect(out).toBe(slice); // returned unchanged (same reference)
    editor.destroy();
  });

  it("leaves an open (partial) slice untouched even if it carries a list", () => {
    // An open slice (openStart/openEnd > 0) is a partial selection, not a
    // standalone block, so it is returned as-is BEFORE any footnote handling.
    const { editor, schema } = makeSchema();
    const slice = new Slice(
      Fragment.fromArray([
        schema.nodes.paragraph.create(null, [
          schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: "a" }),
        ]),
        schema.nodes[FOOTNOTES_LIST_NAME].create(null, [
          schema.nodes[FOOTNOTE_DEFINITION_NAME].create({ id: "a" }, [
            schema.nodes.paragraph.create(null, [schema.text("A")]),
          ]),
        ]),
      ]),
      1,
      1,
    );
    const out = canonicalizePastedFootnotes(slice, schema);
    expect(out).toBe(slice);
    editor.destroy();
  });
});
