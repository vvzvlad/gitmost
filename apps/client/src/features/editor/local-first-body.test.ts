import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { StarterKit } from "@tiptap/starter-kit";
import * as Y from "yjs";
import {
  COLLAB_BODY_FIELD,
  createBodyWriteGuard,
  isYdocBodyNonEmpty,
} from "./local-first-body";

/**
 * #564 guard 2, the CROWN guarantee, tested directly on the guard.
 *
 * The component test proves the same thing end-to-end but has to run on a
 * trimmed extension list (the full docmost list crashes under vitest for a
 * module-resolution reason unrelated to #564 — see the note in
 * page-editor.local-first.test.tsx). This spec closes the SEMANTIC half instead:
 * it exercises the two classes of writer that the trimmed list cannot represent
 * and that a real extension list is full of —
 *
 *  1. a plugin `appendTransaction` that mutates the doc (this is how TrailingNode
 *     and friends seed a document — and what would seed the local ydoc, and get
 *     pushed to the server, if the guard did not hold);
 *  2. a `provider.on("synced")`-style callback that dispatches straight into the
 *     view (this is how @tiptap/extension-unique-id assigns `data-id`s).
 *
 * Both must be REJECTED before the remote confirms and PASS after — the second
 * half is what keeps the first non-vacuous.
 */

const appendKey = new PluginKey("testAppendTransaction");

/** Stands in for TrailingNode/UniqueID-style plugins: appends a doc mutation. */
function createAppendingPlugin(getEnabled: () => boolean) {
  return Extension.create({
    name: "testAppendingPlugin",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: appendKey,
          appendTransaction: (transactions, _oldState, newState) => {
            if (!getEnabled()) return undefined;
            // Only react to a transaction we did not append ourselves.
            if (transactions.some((tr) => tr.getMeta(appendKey))) {
              return undefined;
            }
            const tr = newState.tr;
            tr.setMeta(appendKey, true);
            tr.insertText("[appended]", newState.doc.content.size - 1);
            return tr;
          },
        }),
      ];
    },
  });
}

let canWrite = false;
let isActive = true;
let appendEnabled = false;
let editor: Editor;

function docText(): string {
  return editor.state.doc.textContent;
}

beforeEach(() => {
  canWrite = false;
  isActive = true;
  appendEnabled = false;
  editor = new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false } as never),
      createAppendingPlugin(() => appendEnabled),
      createBodyWriteGuard({
        isActive: () => isActive,
        canWrite: () => canWrite,
      }),
    ],
    content: "<p>seed</p>",
  });
});

afterEach(() => {
  editor.destroy();
});

describe("createBodyWriteGuard", () => {
  it("REJECTS a direct doc-changing dispatch before the remote confirms", () => {
    editor.commands.insertContent("typed");
    expect(docText()).toBe("seed");

    // ... and lets it through once the remote has confirmed. (Non-vacuity: the
    // very same command demonstrably reaches the doc when the guard opens.)
    canWrite = true;
    editor.commands.insertContent("typed");
    expect(docText()).toContain("typed");
  });

  it("REJECTS a plugin appendTransaction that would seed the doc", () => {
    appendEnabled = true;
    // Any transaction at all triggers the appendTransaction pass. A pure
    // selection tr is not doc-changing, so the guard lets IT through — what must
    // not survive is the doc mutation the plugin appends on top of it.
    editor.view.dispatch(editor.state.tr.setMeta("probe", true));
    expect(docText()).toBe("seed");

    canWrite = true;
    editor.view.dispatch(editor.state.tr.setMeta("probe", true));
    expect(docText()).toContain("[appended]");
  });

  it("lets a provider.on('synced')-style dispatcher through the moment writes open", () => {
    // Exactly the @tiptap/extension-unique-id shape: a callback fired from the
    // provider's "synced" emit does ONE `view.dispatch` and unsubscribes. It gets
    // no second chance, so the guard must already be open when it runs — which is
    // why page-editor opens it synchronously inside onSynced (#564 F3).
    const stampIds = () => {
      const tr = editor.state.tr;
      tr.insertText("[ids]", 1);
      editor.view.dispatch(tr);
    };

    // Before the confirmation: rejected (this is the bug's other sign — a stale
    // local copy must not be mutated).
    stampIds();
    expect(docText()).toBe("seed");

    // The synced emit flips the guard open, THEN the subscriber runs.
    canWrite = true;
    stampIds();
    expect(docText()).toContain("[ids]");
  });

  it("always passes a Yjs-originated change (local hydration / remote merge)", () => {
    // Blocking these would leave the body blank: this is how the ydoc paints the
    // editor in the first place.
    const tr = editor.state.tr;
    tr.insertText("from-yjs", 1);
    tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(tr);

    expect(canWrite).toBe(false);
    expect(docText()).toContain("from-yjs");
  });

  it("passes non-doc-changing transactions (selection, decorations)", () => {
    const before = editor.state.doc.toJSON();
    editor.view.dispatch(editor.state.tr.setMeta("decorations", true));
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it("is INERT when the flag is off — the flag-off path behaves like today", () => {
    isActive = false;
    appendEnabled = true;

    editor.commands.insertContent("typed");
    expect(docText()).toContain("typed");
    expect(docText()).toContain("[appended]");
  });
});

describe("isYdocBodyNonEmpty", () => {
  it("is false for a fresh/empty ydoc and for an empty paragraph", () => {
    expect(isYdocBodyNonEmpty(new Y.Doc())).toBe(false);

    const doc = new Y.Doc();
    doc
      .getXmlFragment(COLLAB_BODY_FIELD)
      .insert(0, [new Y.XmlElement("paragraph")]);
    expect(isYdocBodyNonEmpty(doc)).toBe(false);
  });

  it("is true for a paragraph with text and for a childless non-paragraph node", () => {
    const withText = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    withText.getXmlFragment(COLLAB_BODY_FIELD).insert(0, [paragraph]);
    const text = new Y.XmlText();
    text.insert(0, "hello");
    paragraph.insert(0, [text]);
    expect(isYdocBodyNonEmpty(withText)).toBe(true);

    // An image / horizontal rule / embed has no children but IS content.
    const withImage = new Y.Doc();
    withImage
      .getXmlFragment(COLLAB_BODY_FIELD)
      .insert(0, [new Y.XmlElement("image")]);
    expect(isYdocBodyNonEmpty(withImage)).toBe(true);
  });
});
