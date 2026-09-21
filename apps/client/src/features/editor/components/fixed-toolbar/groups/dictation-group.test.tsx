import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { dictationAvailabilityAtom } from "@/features/editor/atoms/editor-atoms.ts";

// Regression test for the byline mic staying stuck disabled (#311 / #309): on a
// page the user can edit, the mic must un-grey once the body becomes editable.
// #311 first fixed this by reading `editor.isEditable` via `useEditorState`; #309
// superseded that with a reactive `dictationAvailabilityAtom` that page-editor
// publishes (carrying both the editable gate AND the unavailable reason). The mic
// now gates on `dictationAvailability.isEditable`, so a change to that atom must
// re-render the group and flip the disabled state (jotai drives the subscription).

// Detectable stand-in that surfaces the `disabled` prop the component computes.
vi.mock("@/features/dictation/components/mic-button", () => ({
  MicButton: ({ disabled }: any) => (
    <button data-testid="mic" disabled={disabled} />
  ),
}));

import { DictationGroup } from "./dictation-group";

// Minimal editor stand-in matching the surface DictationGroup uses (handleStart /
// handleText). The disabled gate no longer reads this — it reads the atom.
function makeFakeEditor() {
  return {
    isEditable: false,
    isDestroyed: false,
    state: { selection: { from: 0, to: 0 }, doc: { content: { size: 0 } } },
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
