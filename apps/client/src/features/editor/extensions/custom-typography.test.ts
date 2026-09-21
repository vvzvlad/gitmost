import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  CustomTypography,
  undoGuardKey,
  findChangedRange,
  mapRangeThroughChange,
} from "./custom-typography";

/**
 * PR #296 — the collab-safe typography undo-guard is exercised through the REAL
 * editor path: a fresh Editor with the CustomTypography extension, transactions
 * tagged exactly the way prosemirror-history / y-tiptap tag undo & remote
 * changes (`setMeta("history$", …)` and `setMeta(ySyncPluginKey, …)`), plus
 * direct unit tests of the two pure diff helpers. No hand-poke of plugin state.
 *
 * ARMING MECHANISM (verified against custom-typography.ts source):
 *   - A transaction arms the guard only when it is BOTH history/remote
 *     (`getMeta("history$")` truthy, or `isChangeOrigin` via the ySync meta)
 *     AND an undo/redo (`getMeta("history$")` truthy, or ySync
 *     `isUndoRedoOperation`), AND its whole-doc diff is a REPLACE
 *     (change.oldTo > change.from && change.newTo > change.from).
 *   - `history$` is the stringified PluginKey of the single prosemirror-history
 *     plugin; ProseMirror stores meta under `key.key`, so setMeta("history$")
 *     in a test is read identically by the extension's getMeta("history$").
 */

const singlePara = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const makeEditor = (text: string) =>
  new Editor({
    extensions: [Document, Paragraph, Text, CustomTypography],
    content: singlePara(text),
  });

// Build a before/after EditorState pair by applying one plain transaction.
const mutate = (text: string, apply: (tr: any, schema: any) => void) => {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text],
    content: singlePara(text),
  });
  const before = editor.state;
  const tr = before.tr;
  apply(tr, before.schema);
  editor.view.dispatch(tr);
  const after = editor.state;
  return { before, after, editor };
};

describe("findChangedRange", () => {
  it("returns null for identical docs", () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text],
      content: singlePara("hello"),
    });
    expect(findChangedRange(editor.state, editor.state)).toBeNull();
    editor.destroy();
  });

  it("returns the minimal range for a normal middle insertion", () => {
    // "hello world" (text at 1..12); insert "there " at pos 6.
    const { before, after, editor } = mutate("hello world", (tr) =>
      tr.insertText("there ", 6),
    );
    expect(findChangedRange(before, after)).toEqual({
      from: 6,
      oldTo: 6,
      newTo: 12,
    });
    editor.destroy();
  });

  it("normalizes the INSERTION overlapping-bounds branch (repeated content)", () => {
    // Insert one more 'a' into "aaaaa" at pos 3. findDiffStart lands at the end
    // (6) while findDiffEnd reports an end BEFORE it ({a:1,b:2}); both ends must
    // be pushed forward by the same delta -> a non-degenerate range.
    const { before, after, editor } = mutate("aaaaa", (tr) =>
      tr.insertText("a", 3),
    );
    const change = findChangedRange(before, after)!;
    expect(change).toEqual({ from: 6, oldTo: 6, newTo: 7 });
    // Invariant the guard logic relies on: never degenerate.
    expect(change.from).toBeLessThanOrEqual(change.oldTo);
    expect(change.from).toBeLessThanOrEqual(change.newTo);
    editor.destroy();
  });

  it("normalizes the DELETION overlapping-bounds branch (F2 fix)", () => {
    // Delete one repeated 'a' from the middle of "aaaaa" ([3,4)). Here
    // findDiffEnd reports newTo < start, the symmetric case the old one-sided
    // normalization missed -> it used to yield a degenerate range (newTo < from).
    const { before, after, editor } = mutate("aaaaa", (tr) => tr.delete(3, 4));
    const change = findChangedRange(before, after)!;
    expect(change).toEqual({ from: 5, oldTo: 6, newTo: 5 });
    // The whole point of F2: from <= newTo (and from <= oldTo) still holds.
    expect(change.from).toBeLessThanOrEqual(change.newTo);
    expect(change.from).toBeLessThanOrEqual(change.oldTo);
    editor.destroy();
  });

  it("normalizes a multi-char repeated deletion (F2 fix)", () => {
    const { before, after, editor } = mutate("aaaaa", (tr) => tr.delete(2, 4));
    const change = findChangedRange(before, after)!;
    expect(change).toEqual({ from: 4, oldTo: 6, newTo: 4 });
    expect(change.from).toBeLessThanOrEqual(change.newTo);
    editor.destroy();
  });
});

describe("mapRangeThroughChange", () => {
  const range = { from: 5, to: 10 };

  it("RELEASES on a strict intersection (edit inside the guarded range)", () => {
    // change straddles the interior of the guard.
    expect(
      mapRangeThroughChange(range, { from: 6, oldTo: 8, newTo: 7 }),
    ).toBeNull();
  });

  it("does NOT release on a boundary touch at the guard END", () => {
    // Edit begins exactly at range.to (10): from < to is false -> no intersect.
    expect(
      mapRangeThroughChange(range, { from: 10, oldTo: 10, newTo: 12 }),
    ).toEqual(range);
  });

  it("does NOT release on a boundary touch at the guard START", () => {
    // Edit ends exactly at range.from (5): oldTo > from is false -> no intersect;
    // it is treated as a change fully before, shifting the guard.
    expect(
      mapRangeThroughChange(range, { from: 3, oldTo: 5, newTo: 8 }),
    ).toEqual({ from: 8, to: 13 });
  });

  it("SHIFTS the guard for a change fully before it", () => {
    // Insert 2 chars entirely before the range (oldTo 3 <= from 5): +2 delta.
    expect(
      mapRangeThroughChange(range, { from: 2, oldTo: 3, newTo: 5 }),
    ).toEqual({ from: 7, to: 12 });
  });

  it("leaves the guard untouched for a change fully after it", () => {
    expect(
      mapRangeThroughChange(range, { from: 12, oldTo: 14, newTo: 16 }),
    ).toBe(range);
  });
});

describe("undo-guard arming (integration)", () => {
  it("arms {from, to:newTo} on a LOCAL undo-replace (history meta)", () => {
    // Undo of an em-dash substitution: "a—b" restored to "a--b" — the em-dash
    // (pos 2..3) is REPLACED by "--", tagged with the history plugin's meta.
    const editor = makeEditor("a—b");
    const { state } = editor;
    const tr = state.tr
      .replaceWith(2, 3, state.schema.text("--"))
      .setMeta("history$", { redo: false });
    editor.view.dispatch(tr);

    expect(editor.state.doc.textContent).toBe("a--b");
    // from = diff start (2), to = newTo = end of the inserted "--" (4).
    expect(undoGuardKey.getState(editor.state)).toEqual({ from: 2, to: 4 });
    editor.destroy();
  });

  it("does NOT arm on a REMOTE change-origin replace (no undo meta)", () => {
    // Same replace, but tagged only as a y-sync remote change: history/remote
    // yes, undo/redo NO -> must not arm.
    const editor = makeEditor("a—b");
    const { state } = editor;
    const tr = state.tr
      .replaceWith(2, 3, state.schema.text("--"))
      .setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(tr);

    expect(editor.state.doc.textContent).toBe("a--b");
    expect(undoGuardKey.getState(editor.state)).toBeNull();
    editor.destroy();
  });

  it("does NOT arm on an ordinary local edit", () => {
    const editor = makeEditor("a—b");
    editor.view.dispatch(
      editor.state.tr.replaceWith(2, 3, editor.state.schema.text("--")),
    );
    expect(undoGuardKey.getState(editor.state)).toBeNull();
    editor.destroy();
  });
});

describe("undo-guard release / shift (integration)", () => {
  it("RELEASES when a later edit lands inside the guarded region", () => {
    const editor = makeEditor("a—b");
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(2, 3, editor.state.schema.text("--"))
        .setMeta("history$", { redo: false }),
    );
    const guard = undoGuardKey.getState(editor.state)!;
    expect(guard).toEqual({ from: 2, to: 4 });

    // Type a character inside the restored region -> guard is dropped.
    editor.view.dispatch(editor.state.tr.insertText("x", guard.from + 1));
    expect(undoGuardKey.getState(editor.state)).toBeNull();
    editor.destroy();
  });

  it("keeps and SHIFTS the guard when a later edit lands before it", () => {
    const editor = makeEditor("zz a—b");
    // "zz a—b": em-dash at pos 5; replace the 'a' at 4..5 with "--" to arm.
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(4, 5, editor.state.schema.text("--"))
        .setMeta("history$", { redo: false }),
    );
    const guard = undoGuardKey.getState(editor.state)!;
    expect(guard).toEqual({ from: 4, to: 6 });

    // Insert one char at the very start (before the guard) -> guard shifts +1.
    editor.view.dispatch(editor.state.tr.insertText("Q", 1));
    expect(undoGuardKey.getState(editor.state)).toEqual({ from: 5, to: 7 });
    editor.destroy();
  });
});
