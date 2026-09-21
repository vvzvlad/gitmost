import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { UniqueID } from "@docmost/editor-ext";
import { getEditorSelectionContext } from "./get-editor-selection";

/**
 * Unit tests for getEditorSelectionContext (#388). Built on a headless
 * ProseMirror schema (Document + Paragraph + Text + the block-id UniqueID
 * extension), mirroring the editor-ext test style. We assemble docs with
 * explicit block ids so the covered-blockIds assertions are deterministic.
 */

// A schema that carries the `id` block attribute (UniqueID) on paragraphs, just
// like the real editor.
const { schema } = new Editor({
  extensions: [
    Document,
    Paragraph,
    Text,
    UniqueID.configure({ types: ["paragraph"] }),
  ],
  content: "",
});

function docOf(blocks: { id: string; text: string }[]): PMNode {
  return schema.node(
    "doc",
    null,
    blocks.map((b) =>
      schema.node("paragraph", { id: b.id }, b.text ? schema.text(b.text) : []),
    ),
  );
}

function stateWith(doc: PMNode, from: number, to: number): EditorState {
  const base = EditorState.create({ schema, doc });
  return base.apply(base.tr.setSelection(TextSelection.create(doc, from, to)));
}

// Select every text position of the doc (pos 1 .. content.size - 1).
function selectAll(doc: PMNode): EditorState {
  return stateWith(doc, 1, doc.content.size - 1);
}

describe("getEditorSelectionContext", () => {
  it("returns null for an empty (collapsed) selection", () => {
    const doc = docOf([{ id: "b1", text: "Hello world" }]);
    const state = stateWith(doc, 3, 3); // caret, from === to
    expect(getEditorSelectionContext(state)).toBeNull();
  });

  it("returns null for the default caret-at-start of a fresh editor", () => {
    const editor = new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        UniqueID.configure({ types: ["paragraph"] }),
      ],
      content: "<p>fresh</p>",
    });
    expect(getEditorSelectionContext(editor.state)).toBeNull();
    editor.destroy();
  });

  it("reads a single-paragraph selection with no block-separator artifacts", () => {
    const doc = docOf([{ id: "b1", text: "Hello world" }]);
    const sel = getEditorSelectionContext(selectAll(doc))!;
    expect(sel.text).toBe("Hello world");
    expect(sel.blockIds).toEqual(["b1"]);
    expect(sel.truncated).toBeUndefined();
  });

  it("joins multiple blocks with a newline and collects all covered blockIds", () => {
    const doc = docOf([
      { id: "b1", text: "First" },
      { id: "b2", text: "Second" },
    ]);
    const sel = getEditorSelectionContext(selectAll(doc))!;
    expect(sel.text).toBe("First\nSecond");
    expect(sel.blockIds).toEqual(["b1", "b2"]);
  });

  it("caps the text at 2000 chars and flags truncated", () => {
    const doc = docOf([{ id: "b1", text: "x".repeat(2500) }]);
    const sel = getEditorSelectionContext(selectAll(doc))!;
    expect(sel.text).toHaveLength(2000);
    expect(sel.truncated).toBe(true);
  });

  it("computes before/after context and clamps it to the doc bounds", () => {
    // One paragraph "0123456789abcdefghij"; select the middle "56789".
    const doc = docOf([{ id: "b1", text: "0123456789abcdefghij" }]);
    // text char i lives at pos (1 + i); select chars index 5..9 -> pos 6..11.
    const sel = getEditorSelectionContext(stateWith(doc, 6, 11))!;
    expect(sel.text).toBe("56789");
    expect(sel.before).toBe("01234");
    expect(sel.after).toBe("abcdefghij");
  });

  it("omits before/after at the document boundaries (never reads past 0/size)", () => {
    const doc = docOf([{ id: "b1", text: "Edge" }]);
    const sel = getEditorSelectionContext(selectAll(doc))!;
    // Selection spans the whole single block: nothing before or after it.
    expect(sel.before).toBeUndefined();
    expect(sel.after).toBeUndefined();
  });
});
