import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import {
  STRESS_ACCENT,
  hasStressAfterSelection,
  toggleStressAccent,
} from "./stress-accent";

// Minimal ProseMirror schema: paragraph of text with a single `bold` mark.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "text*",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
  marks: {
    bold: { toDOM: () => ["strong", 0] },
  },
});

function makeState(
  text: string,
  from: number,
  to: number,
  marked = false,
): EditorState {
  const marks = marked ? [schema.marks.bold.create()] : [];
  const textNode = schema.text(text, marks);
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [textNode]),
  ]);
  const state = EditorState.create({ schema, doc });
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, from, to)),
  );
}

describe("stress-accent", () => {
  it("uses U+0301 as the combining accent", () => {
    expect(STRESS_ACCENT).toHaveLength(1);
    expect(STRESS_ACCENT.codePointAt(0)).toBe(0x0301);
  });

  it("inserts the accent right after the selected vowel", () => {
    // "кот", select "о" (positions 2..3).
    const state = makeState("кот", 2, 3);
    expect(hasStressAfterSelection(state)).toBe(false);

    const next = state.apply(toggleStressAccent(state));
    expect(next.doc.textContent).toBe(`ко${STRESS_ACCENT}т`);
    // Selection is preserved on the letter, so the button reads active.
    expect(next.selection.from).toBe(2);
    expect(next.selection.to).toBe(3);
    expect(hasStressAfterSelection(next)).toBe(true);
  });

  it("removes the accent on a second toggle (round-trips to original)", () => {
    const state = makeState("кот", 2, 3);
    const inserted = state.apply(toggleStressAccent(state));
    const removed = inserted.apply(toggleStressAccent(inserted));

    expect(removed.doc.textContent).toBe("кот");
    expect(hasStressAfterSelection(removed)).toBe(false);
    expect(removed.selection.from).toBe(2);
    expect(removed.selection.to).toBe(3);
  });

  it("inherits the letter's marks so the accent stays bold", () => {
    // Whole word is bold; select "о".
    const state = makeState("кот", 2, 3, true);
    const next = state.apply(toggleStressAccent(state));

    // The accent lands at positions 3..4 (right after "о")...
    expect(next.doc.textBetween(3, 4)).toBe(STRESS_ACCENT);
    // ...inside a bold text node, so it inherits the letter's bold mark.
    const accentNode = next.doc.nodeAt(3);
    expect(accentNode?.marks.some((m) => m.type.name === "bold")).toBe(true);
  });

  it("handles a selection at the end of the doc without throwing", () => {
    // "а" is the whole paragraph; select it (1..2), end of content.
    const state = makeState("а", 1, 2);
    expect(hasStressAfterSelection(state)).toBe(false);

    const next = state.apply(toggleStressAccent(state));
    expect(next.doc.textContent).toBe(`а${STRESS_ACCENT}`);
    expect(hasStressAfterSelection(next)).toBe(true);
  });
});
