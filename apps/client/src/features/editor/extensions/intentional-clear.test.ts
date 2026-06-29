import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  IntentionalClear,
  INTENTIONAL_CLEAR_MESSAGE_TYPE,
} from "./intentional-clear";

/**
 * #251 — the intentional-clear signal is driven through the REAL editor path:
 * a fresh Editor with the IntentionalClear extension, a fake provider that
 * records sendStateless, and the actual select-all + delete command the user's
 * keystroke runs. No hand-poke of any flag.
 */
describe("IntentionalClear extension", () => {
  let sendStateless: ReturnType<typeof vi.fn>;

  const makeEditor = (content: unknown) =>
    new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        IntentionalClear.configure({
          // Minimal provider stand-in: only sendStateless is exercised.
          provider: { sendStateless } as any,
        }),
      ],
      content: content as any,
    });

  beforeEach(() => {
    sendStateless = vi.fn();
  });

  it("emits the clear signal when a user empties a non-empty doc (select-all + delete)", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello world" }] },
      ],
    });

    // The exact command path a select-all + Delete keystroke dispatches.
    editor.chain().selectAll().deleteSelection().run();

    expect(sendStateless).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendStateless.mock.calls[0][0]);
    expect(payload).toEqual({ type: INTENTIONAL_CLEAR_MESSAGE_TYPE });

    editor.destroy();
  });

  it("does NOT emit when typing into an empty doc (no non-empty → empty transition)", () => {
    const editor = makeEditor({ type: "doc", content: [{ type: "paragraph" }] });

    editor.chain().insertContent("typed text").run();

    expect(sendStateless).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("does NOT emit on an edit that leaves the doc non-empty", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "keep me" }] },
      ],
    });

    editor.chain().insertContent(" more").run();

    expect(sendStateless).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("does NOT emit when a REMOTE/merge (change-origin) transaction empties the doc", () => {
    // This pins the CENTRAL #248 protection: only a LOCAL user edit may emit the
    // intentional-clear signal. An emptiness arriving from another client, a bad
    // merge, or an emptied transclusion is applied as a y-sync transaction tagged
    // with the ySyncPluginKey meta, which `isChangeOrigin` detects. The extension
    // must early-return on it and NOT punch the empty write through the server
    // guard.
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "remote content" }] },
      ],
    });

    // Build a transaction that empties the non-empty doc and tag it exactly the
    // way y-tiptap tags a remote y-sync update: `tr.setMeta(ySyncPluginKey,
    // { isChangeOrigin: true })` (see @tiptap/y-tiptap sync-plugin). This makes
    // the real `isChangeOrigin(tr)` predicate return true — not a stand-in.
    const { state } = editor;
    const tr = state.tr
      .delete(0, state.doc.content.size)
      .setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(tr);

    // The transaction really emptied the doc (became the single empty paragraph)…
    expect(editor.state.doc.textContent).toBe("");
    // …yet because it is change-origin, no signal is emitted.
    expect(sendStateless).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("does NOT emit when the doc was already empty", () => {
    const editor = makeEditor({ type: "doc", content: [{ type: "paragraph" }] });

    // Selecting all + delete on an already-empty doc is a no-op transition.
    editor.chain().selectAll().deleteSelection().run();

    expect(sendStateless).not.toHaveBeenCalled();
    editor.destroy();
  });
});
