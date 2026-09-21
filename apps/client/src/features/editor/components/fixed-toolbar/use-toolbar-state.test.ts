import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { yHistoryAvailability } from "./use-toolbar-state.ts";

// Undo/redo availability is derived from the Yjs UndoManager's PRIVATE
// `undoStack` / `redoStack` fields (see use-toolbar-state.ts for why we read the
// stack lengths directly instead of the expensive `editor.can().undo()` dry-run).
// These tests lock in the behavior AND pin the library shape so a yjs / y-undo
// upgrade that renames/restructures those internals fails loudly here rather than
// silently enabling/disabling the toolbar buttons in production.
describe("yHistoryAvailability", () => {
  it("reports availability from the stack lengths", () => {
    expect(yHistoryAvailability({ undoStack: [], redoStack: [] })).toEqual({
      canUndo: false,
      canRedo: false,
    });
    expect(
      yHistoryAvailability({ undoStack: [{}], redoStack: [] }),
    ).toEqual({ canUndo: true, canRedo: false });
    expect(
      yHistoryAvailability({ undoStack: [{}], redoStack: [{}, {}] }),
    ).toEqual({ canUndo: true, canRedo: true });
  });

  it("returns null when the private stack shape is unrecognized (upgrade guard)", () => {
    // Simulates a yjs / y-undo upgrade that renames or restructures the private
    // fields: the caller then falls back to the safe prosemirror-history default
    // instead of throwing on `.length` of undefined or reading garbage.
    expect(yHistoryAvailability(undefined)).toBeNull();
    expect(yHistoryAvailability(null)).toBeNull();
    expect(yHistoryAvailability({})).toBeNull();
    expect(yHistoryAvailability({ undoStack: 5, redoStack: 5 })).toBeNull();
    // Only one stack present (partial rename) is still not trusted.
    expect(yHistoryAvailability({ undoStack: [] })).toBeNull();
  });

  it("pin-test: a real yjs UndoManager still exposes undoStack/redoStack arrays", () => {
    const doc = new Y.Doc();
    const text = doc.getText("prosemirror");
    const undoManager = new Y.UndoManager(text);

    // Fresh manager: both stacks empty -> nothing to undo/redo.
    expect(yHistoryAvailability(undoManager)).toEqual({
      canUndo: false,
      canRedo: false,
    });

    // A tracked edit must push onto the private undoStack. If a future yjs
    // renames these fields, yHistoryAvailability(undoManager) returns null and
    // the expectation below fails loudly.
    text.insert(0, "hello");
    undoManager.stopCapturing();
    expect(yHistoryAvailability(undoManager)).toEqual({
      canUndo: true,
      canRedo: false,
    });

    // Undoing moves the item to the redoStack -> redo becomes available.
    undoManager.undo();
    expect(yHistoryAvailability(undoManager)).toEqual({
      canUndo: false,
      canRedo: true,
    });
  });
});
