import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { dictationAvailabilityAtom } from "@/features/editor/atoms/editor-atoms.ts";

// On a page the user can edit, the byline mic must un-grey once the body
// becomes editable. The mic gates on `dictationAvailability.isEditable` from the
// reactive `dictationAvailabilityAtom` that page-editor publishes (carrying both
// the editable gate AND the unavailable reason), so a change to that atom must
// re-render the group and flip the disabled state (jotai drives the subscription).

// The callbacks DictationGroup hands to the mic, captured on every render.
const mic = vi.hoisted(() => ({
  onStart: null as null | (() => void),
  onText: null as null | ((text: string) => void),
}));

// Detectable stand-in that surfaces the `disabled` prop the component computes.
vi.mock("@/features/dictation/components/mic-button", () => ({
  MicButton: ({ disabled, onStart, onText }: any) => {
    mic.onStart = onStart;
    mic.onText = onText;
    return <button data-testid="mic" disabled={disabled} />;
  },
}));

import { DictationGroup } from "./dictation-group";

// Minimal editor stand-in matching the surface DictationGroup uses (handleStart /
// handleText and the transaction subscription). The disabled gate does not read
// this — it reads the atom.
function makeFakeEditor() {
  return {
    isEditable: false,
    isDestroyed: false,
    state: { selection: { from: 0, to: 0 }, doc: { content: { size: 0 } } },
    on: () => {},
    off: () => {},
  } as any;
}

describe("DictationGroup editable reactivity (#309 atom / #311)", () => {
  it("re-enables the mic when dictationAvailability flips isEditable false -> true", () => {
    const editor = makeFakeEditor();
    const store = createStore();
    // Pre-sync: page editor publishes not-editable (with a reason).
    store.set(dictationAvailabilityAtom, {
      isEditable: false,
      reason: "connecting",
    });

    const { getByTestId } = render(
      <Provider store={store}>
        <DictationGroup editor={editor} />
      </Provider>,
    );

    // Not editable yet -> disabled (preserves the #218 pre-sync intent).
    expect(getByTestId("mic").hasAttribute("disabled")).toBe(true);

    // Collab sync -> page editor republishes editable; the atom change must
    // re-render the group and enable the mic.
    act(() => {
      store.set(dictationAvailabilityAtom, { isEditable: true, reason: null });
    });

    expect(getByTestId("mic").hasAttribute("disabled")).toBe(false);
  });
});

describe("DictationGroup insertion point", () => {
  it("lands the text where dictation started after an edit above it", () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text],
      content: "<p>one two</p>",
    });
    render(
      <Provider store={createStore()}>
        <DictationGroup editor={editor as any} />
      </Provider>,
    );

    // Caret right after "one" (the paragraph's text starts at position 1).
    editor.commands.setTextSelection(4);
    act(() => mic.onStart!());
    // Text typed above the caret before the (retried) transcription arrives.
    editor.commands.insertContentAt(1, "zero ");
    act(() => mic.onText!("dictated"));

    expect(editor.getText()).toBe("zero onedictated  two");
    editor.destroy();
  });

  it("keeps the insertion point when Yjs replaces the whole document", () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text],
      content: "<p>one two</p>",
    });
    render(
      <Provider store={createStore()}>
        <DictationGroup editor={editor as any} />
      </Provider>,
    );

    editor.commands.setTextSelection(4);
    act(() => mic.onStart!());
    // y-tiptap applies a remote change (or a Yjs undo) as one replacement of
    // the whole document, tagged with its plugin key.
    const { state } = editor;
    const tr = state.tr.replaceWith(
      0,
      state.doc.content.size,
      state.schema.nodeFromJSON({
        type: "paragraph",
        content: [{ type: "text", text: "one two three" }],
      }),
    );
    tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(tr);
    act(() => mic.onText!("dictated"));

    expect(editor.getText()).toBe("onedictated  two three");
    editor.destroy();
  });
});
