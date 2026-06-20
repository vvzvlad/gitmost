import { describe, it, expect } from "vitest";
import { Editor, Extension, getSchema } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Superscript } from "@tiptap/extension-superscript";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Node as PMNode } from "@tiptap/pm/model";
import { FootnoteReference } from "./footnote-reference";
import { FootnotesList } from "./footnotes-list";
import { FootnoteDefinition } from "./footnote-definition";
import { TrailingNode } from "../trailing-node";
import {
  computeFootnoteNumbers,
  collectReferenceIds,
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
  FOOTNOTE_DEFINITION_NAME,
} from "./footnote-util";

const extensions = [
  Document,
  Paragraph,
  Text,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
];

function makeEditor(content?: any) {
  return new Editor({
    extensions,
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
  });
}

function countType(doc: PMNode, name: string): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === name) n++;
  });
  return n;
}

describe("footnote numbering (pure function)", () => {
  it("numbers references in document order", () => {
    const schema = getSchema(extensions);
    const doc = PMNode.fromJSON(schema, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "x" } },
            { type: "text", text: "b" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "y" } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "x" },
              content: [{ type: "paragraph" }],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "y" },
              content: [{ type: "paragraph" }],
            },
          ],
        },
      ],
    });

    expect(collectReferenceIds(doc)).toEqual(["x", "y"]);
    const numbers = computeFootnoteNumbers(doc);
    expect(numbers.get("x")).toBe(1);
    expect(numbers.get("y")).toBe(2);
  });
});

describe("setFootnote command", () => {
  it("inserts a reference and a matching definition in the footnotes list", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      ],
    });
    // Cursor at end of the word.
    editor.commands.setTextSelection(6);
    const ok = editor.commands.setFootnote();
    expect(ok).toBe(true);

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(1);

    // The reference id and the definition id match.
    let refId: string | null = null;
    let defId: string | null = null;
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_REFERENCE_NAME) refId = node.attrs.id;
      if (node.type.name === FOOTNOTE_DEFINITION_NAME) defId = node.attrs.id;
    });
    expect(refId).toBeTruthy();
    expect(refId).toBe(defId);
    editor.destroy();
  });

  it("inserts the definition at the correct position matching reference order", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "AAAA" }] },
        { type: "paragraph", content: [{ type: "text", text: "BBBB" }] },
      ],
    });

    // First footnote: place inside the SECOND paragraph (after "BBBB").
    editor.commands.setTextSelection(11); // end of BBBB
    editor.commands.setFootnote();

    // Second footnote: place inside the FIRST paragraph (after "AAAA"),
    // which is BEFORE the first reference in document order.
    editor.commands.setTextSelection(5); // end of AAAA
    editor.commands.setFootnote();

    const doc = editor.state.doc;
    // Reference order in document.
    const refOrder = collectReferenceIds(doc);
    // Definition order in the list.
    const defOrder: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
        defOrder.push(node.attrs.id);
      }
    });

    expect(defOrder).toEqual(refOrder);
    expect(defOrder.length).toBe(2);
    editor.destroy();
  });
});

describe("removeFootnote command (cascade)", () => {
  it("removes both the reference and its definition, and drops the empty list", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      ],
    });
    editor.commands.setTextSelection(6);
    editor.commands.setFootnote();

    let id: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_REFERENCE_NAME) id = node.attrs.id;
    });
    expect(id).toBeTruthy();

    editor.commands.removeFootnote(id!);

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(0);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(0);
    // empty list removed
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(0);
    editor.destroy();
  });
});

describe("footnote sync plugin (orphans)", () => {
  it("creates an empty definition for a reference pasted without one", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "x" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "orphan-ref" } },
          ],
        },
      ],
    });
    // Trigger a doc change so appendTransaction runs.
    editor.commands.insertContentAt(1, " ");

    const doc = editor.state.doc;
    let defFound = false;
    doc.descendants((node) => {
      if (
        node.type.name === FOOTNOTE_DEFINITION_NAME &&
        node.attrs.id === "orphan-ref"
      ) {
        defFound = true;
      }
    });
    expect(defFound).toBe(true);
    editor.destroy();
  });

  it("merges multiple footnotesList nodes into one, preserving all definitions, as the last child", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "x" } },
            { type: "text", text: "b" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "y" } },
          ],
        },
        // First (stray) footnotes list, e.g. from a paste/collab merge.
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "x" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "X note" }] }],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "tail" }] },
        // Second footnotes list (the "real" trailing one).
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "y" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Y note" }] }],
            },
          ],
        },
      ],
    });
    // Trigger a local doc change so appendTransaction runs.
    editor.commands.insertContentAt(1, " ");

    const doc = editor.state.doc;
    // Converged to exactly ONE list.
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    // Both definitions preserved (no tracking lost).
    const defIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME) defIds.push(node.attrs.id);
    });
    expect(defIds.sort()).toEqual(["x", "y"]);
    // The single list is the LAST child of the document.
    const lastChild = doc.child(doc.childCount - 1);
    expect(lastChild.type.name).toBe(FOOTNOTES_LIST_NAME);
    editor.destroy();
  });

  it("leaves a correct doc (single trailing list) unchanged — no merge loop", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "x" } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "x" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "X note" }] }],
            },
          ],
        },
      ],
    });
    const before = editor.state.doc.toJSON();
    // A change that doesn't touch footnote structure.
    editor.commands.insertContentAt(1, "z");
    const doc = editor.state.doc;
    // Still exactly one list, still last, definition preserved.
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    const lastChild = doc.child(doc.childCount - 1);
    expect(lastChild.type.name).toBe(FOOTNOTES_LIST_NAME);
    // The footnotes list subtree is identical to before (no spurious rewrite).
    const beforeList = before.content.find(
      (n: any) => n.type === FOOTNOTES_LIST_NAME,
    );
    const afterList = doc
      .toJSON()
      .content.find((n: any) => n.type === FOOTNOTES_LIST_NAME);
    expect(afterList).toEqual(beforeList);
    editor.destroy();
  });

  it("two definitions sharing an id (with two matching references) BOTH survive the first edit (no data loss)", () => {
    // Reproduces the verified data-loss bug: two footnoteDefinition nodes share
    // id "d", and there are two references with id "d". The OLD code built the
    // definitions Map last-wins and emitted exactly one definition for the
    // de-duplicated reference, so the very first keystroke's sync transaction
    // deleted the whole list and rebuilt it from one definition — silently
    // destroying "first" and keeping only "second".
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "d" } },
            { type: "text", text: "b" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "d" } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "d" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "first" }] },
              ],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "d" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "second" }] },
              ],
            },
          ],
        },
      ],
    });
    // The first local keystroke fires the sync plugin's appendTransaction.
    editor.commands.insertContentAt(1, " ");

    const doc = editor.state.doc;
    // BOTH definitions survive.
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(2);
    const defTexts: string[] = [];
    const defIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
        defIds.push(node.attrs.id);
        defTexts.push(node.textContent);
      }
    });
    // No content was lost: both "first" and "second" are still present.
    expect(defTexts.sort()).toEqual(["first", "second"]);
    // The colliding ids were made distinct.
    expect(new Set(defIds).size).toBe(2);
    // Each definition's id matches exactly one reference (1:1 pairing).
    const refIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_REFERENCE_NAME) refIds.push(node.attrs.id);
    });
    expect(refIds.sort()).toEqual(defIds.sort());
    editor.destroy();
  });

  it("re-ids colliding duplicates DETERMINISTICALLY (two clients converge to identical ids)", () => {
    // Cross-client determinism guard. Two collaborating clients each see the
    // SAME duplicate-id document and each make a local edit. The sync plugin
    // runs identically on every client, so it MUST mint the SAME new ids on both
    // — otherwise the two clients diverge permanently over Yjs (duplicated
    // footnotes). This is exactly the blocker the previous random-id
    // (generateFootnoteId / Math.random) implementation caused: it would mint
    // DIFFERENT ids on each client and this assertion would fail.
    const duplicateDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "d" } },
            { type: "text", text: "b" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "d" } },
            { type: "text", text: "c" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "d" } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "d" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "d" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "two" }] },
              ],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "d" },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "three" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const idsAfterLocalEdit = () => {
      // A fresh editor instance = an independent "client" running the same
      // plugin pipeline on the same starting document.
      const editor = makeEditor(structuredClone(duplicateDoc));
      editor.commands.insertContentAt(1, " "); // local keystroke -> sync runs
      const refIds: string[] = [];
      const defIds: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === FOOTNOTE_REFERENCE_NAME)
          refIds.push(node.attrs.id);
        if (node.type.name === FOOTNOTE_DEFINITION_NAME)
          defIds.push(node.attrs.id);
      });
      editor.destroy();
      return { refIds, defIds };
    };

    const clientA = idsAfterLocalEdit();
    const clientB = idsAfterLocalEdit();

    // Both clients computed IDENTICAL ids (the property that makes Yjs converge).
    expect(clientA.refIds).toEqual(clientB.refIds);
    expect(clientA.defIds).toEqual(clientB.defIds);

    // And the ids are deterministic-derived (not random uuid-style): the keeper
    // keeps "d", the duplicates become "d__2", "d__3".
    expect(new Set(clientA.refIds)).toEqual(new Set(["d", "d__2", "d__3"]));
    // Every definition survived with a unique id, 1:1 with the references.
    expect(clientA.defIds.length).toBe(3);
    expect(new Set(clientA.defIds).size).toBe(3);
    expect([...clientA.refIds].sort()).toEqual([...clientA.defIds].sort());
  });

  it("removes an orphan definition with no matching reference", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "orphan-def" },
              content: [{ type: "paragraph" }],
            },
          ],
        },
      ],
    });
    editor.commands.insertContentAt(1, "y");

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(0);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(0);
    editor.destroy();
  });
});

/**
 * Live-editor regression tests for the sync-plugin infinite loop (the hard
 * freeze when activating /footnote). These drive a REAL Tiptap editor through
 * the same plugin pipeline the browser uses — including the TrailingNode plugin,
 * which is what turned the "move list to the end" pass into an infinite
 * ping-pong (list moved last -> trailing paragraph appended after it -> list no
 * longer last -> moved again -> ...).
 *
 * If the loop regresses, ProseMirror's appendTransaction round loop never
 * terminates and these tests HANG (the vitest timeout fails them). The
 * transaction counter additionally fails fast with a bounded iteration cap, so
 * a regression surfaces as an explicit error instead of only a slow timeout.
 */
describe("footnote sync plugin (no infinite loop — live editor)", () => {
  // Hard cap on how many doc-changing appendTransaction rounds we tolerate for a
  // single user action. Convergence takes a couple of rounds at most; anything
  // approaching this means the plugins are oscillating.
  const MAX_ROUNDS = 50;

  // The production editor wires FootnoteReference alongside TrailingNode and
  // Superscript; both participate in the loop the bug exhibited, so we mirror
  // that here.
  function makeLiveEditor(content?: any) {
    let rounds = 0;
    // A guard plugin that counts doc-changing appendTransaction rounds and
    // throws if they exceed the cap, converting a would-be infinite loop into a
    // deterministic failure instead of a wall-clock hang.
    const LoopGuard = Extension.create({
      name: "footnoteLoopGuard",
      // Run last so it observes every other plugin's appended transaction.
      priority: -1000,
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey("footnoteLoopGuard"),
            appendTransaction(transactions) {
              if (transactions.some((t) => t.docChanged)) {
                rounds += 1;
                if (rounds > MAX_ROUNDS) {
                  throw new Error(
                    `footnote sync did not converge: exceeded ${MAX_ROUNDS} appendTransaction rounds (infinite loop)`,
                  );
                }
              }
              return null;
            },
          }),
        ];
      },
    });

    const editor = new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        Superscript,
        TrailingNode,
        LoopGuard,
        FootnoteReference,
        FootnotesList,
        FootnoteDefinition,
      ],
      content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
    });
    return { editor, getRounds: () => rounds, resetRounds: () => (rounds = 0) };
  }

  function lastFootnotesListIsTrailing(doc: PMNode): boolean {
    // Canonical placement: the list is the last meaningful block — only empty
    // paragraphs (the trailing-node) may follow it.
    let listIndex = -1;
    for (let i = 0; i < doc.childCount; i++) {
      if (doc.child(i).type.name === FOOTNOTES_LIST_NAME) listIndex = i;
    }
    if (listIndex === -1) return false;
    for (let i = listIndex + 1; i < doc.childCount; i++) {
      const child = doc.child(i);
      if (!(child.type.name === "paragraph" && child.content.size === 0)) {
        return false;
      }
    }
    return true;
  }

  it("setFootnote() RETURNS (no hang) and produces one ref + one def in a trailing list", () => {
    const { editor } = makeLiveEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
    });
    editor.commands.setTextSelection(3);
    const ok = editor.commands.setFootnote();
    expect(ok).toBe(true);

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(1);
    expect(lastFootnotesListIsTrailing(doc)).toBe(true);
    editor.destroy();
  });

  it("a second setFootnote() does not hang: two refs + two defs in one list", () => {
    const { editor } = makeLiveEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
    });
    editor.commands.setTextSelection(3);
    editor.commands.setFootnote();
    editor.commands.setTextSelection(3);
    editor.commands.setFootnote();

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(2);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(2);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    expect(lastFootnotesListIsTrailing(doc)).toBe(true);
    editor.destroy();
  });

  it("converges and stabilizes: an unrelated edit does not keep producing transactions", () => {
    const { editor, getRounds, resetRounds } = makeLiveEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
    });
    editor.commands.setTextSelection(3);
    editor.commands.setFootnote();

    // Now the doc is canonical. Dispatch an unrelated edit (insert text) and
    // assert the sync plugin converges in a bounded number of rounds and the
    // document is stable (one ref/def/list, list trailing).
    resetRounds();
    editor.commands.insertContentAt(1, "Z");
    const afterFirst = editor.state.doc.toJSON();
    const roundsAfterEdit = getRounds();
    expect(roundsAfterEdit).toBeLessThan(MAX_ROUNDS);

    // A follow-up no-op-ish edit must not re-trigger structural rewrites: the
    // footnotes section is identical before and after a further unrelated edit.
    editor.commands.insertContentAt(2, "Y");
    const afterSecond = editor.state.doc.toJSON();

    const listOf = (json: any) =>
      json.content.find((n: any) => n.type === FOOTNOTES_LIST_NAME);
    expect(listOf(afterSecond)).toEqual(listOf(afterFirst));
    expect(countType(editor.state.doc, FOOTNOTES_LIST_NAME)).toBe(1);
    editor.destroy();
  });

  it("two footnotesList nodes converge to one (merge) without looping", () => {
    const { editor } = makeLiveEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "x" } },
            { type: "text", text: "b" },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: "y" } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "x" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "X" }] },
              ],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "tail" }] },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: "y" },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Y" }] },
              ],
            },
          ],
        },
      ],
    });
    // Trigger a local doc change so appendTransaction runs (must not hang).
    editor.commands.insertContentAt(1, " ");

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    const defIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME)
        defIds.push(node.attrs.id);
    });
    expect(defIds.sort()).toEqual(["x", "y"]);
    expect(lastFootnotesListIsTrailing(doc)).toBe(true);
    editor.destroy();
  });
});
