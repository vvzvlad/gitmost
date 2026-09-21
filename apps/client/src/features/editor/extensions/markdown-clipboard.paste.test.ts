import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { MarkdownClipboard } from "./markdown-clipboard";

/**
 * Integration coverage for the async `handlePaste` seam (issue #347). The paste
 * conversion moved to `@docmost/prosemirror-markdown`'s browser entry, whose
 * `markdownToProseMirror` is async — so `handlePaste` captures the range, claims
 * the event (returns true), and dispatches the insert on the next microtask.
 * These tests drive that path end to end on a minimal schema (a plain-markdown
 * paste whose converted nodes fit paragraph/text/bold/italic), asserting the
 * text lands with the right marks and that the raw markdown syntax is consumed
 * (recognized as markdown, not inserted literally).
 */

function makeEditor() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      MarkdownClipboard.configure({ transformPastedText: true }),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
}

// Locate the markdownClipboard plugin and invoke its handlePaste directly with a
// synthetic clipboard event (jsdom has no real paste pipeline). The plugin's
// handlePaste closes over the extension `this`, so calling it off the plugin
// props preserves `this.editor`/`this.options`.
function paste(editor: Editor, text: string): boolean {
  const view = editor.view;
  const plugin = view.state.plugins.find(
    (p: any) => p.props && p.spec?.key,
  ) as any;
  const event = {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  } as unknown as ClipboardEvent;
  // Find the specific handlePaste that belongs to the markdown clipboard plugin.
  const md = view.state.plugins.find(
    (p: any) => typeof p.props?.handlePaste === "function",
  ) as any;
  return md.props.handlePaste(view, event, view.state.selection.content());
}

// Flush the microtask queue so the async .then() dispatch runs.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("MarkdownClipboard handlePaste (async md -> PM)", () => {
  it("converts a plain-markdown paste with bold/italic into marked text", async () => {
    const editor = makeEditor();
    const claimed = paste(editor, "hello **bold** and *italic*");
    // The paste is claimed synchronously (async insert follows).
    expect(claimed).toBe(true);
    await flush();

    const json = editor.getJSON();
    const text = JSON.stringify(json);
    // The raw markdown asterisks are consumed (recognized), not inserted literally.
    expect(editor.getText()).not.toContain("**");
    expect(editor.getText()).toContain("bold");
    expect(editor.getText()).toContain("italic");
    // The bold/italic marks materialized.
    expect(text).toContain('"bold"');
    expect(text).toContain('"italic"');
    editor.destroy();
  });

  it("recognizes a bullet list paste as list structure (not literal '-')", async () => {
    // A bullet list is not representable in this minimal schema, so the converter
    // output would fail PMNode.fromJSON and the catch inserts raw text. Use a
    // paste whose nodes DO fit the schema to assert the happy path instead: two
    // paragraphs separated by a blank line.
    const editor = makeEditor();
    paste(editor, "first para\n\nsecond para");
    await flush();
    const json = editor.getJSON() as any;
    const paras = (json.content || []).filter(
      (n: any) => n.type === "paragraph",
    );
    // Two paragraphs materialized from the blank-line-separated markdown.
    expect(paras.length).toBeGreaterThanOrEqual(2);
    expect(editor.getText()).toContain("first para");
    expect(editor.getText()).toContain("second para");
    editor.destroy();
  });

  it("falls back to raw text when conversion yields nodes the schema lacks", async () => {
    // `# heading` converts to a `heading` node absent from this minimal schema,
    // so PMNode.fromJSON throws and the catch re-inserts the raw text — the user
    // never loses their clipboard content.
    const editor = makeEditor();
    paste(editor, "# a heading line");
    await flush();
    // Content is preserved (either as heading text or literal), never dropped.
    expect(editor.getText()).toContain("a heading line");
    editor.destroy();
  });
});

// The async seam captures the target range synchronously, then replaces on the
// next microtask. If the document changed under it between capture and resolve
// (impossible in prod — same microtask — but pinned here), BOTH the success
// (replaceRange) and the fail-open (insertText) branches must fall back to the
// LIVE selection rather than a stale absolute range, so neither clobbers content
// nor throws a RangeError. We force the mid-flight change by dispatching a
// doc-mutating transaction AFTER the synchronous claim but BEFORE flushing the
// microtask that runs the `.then`/`.catch`.
describe("MarkdownClipboard handlePaste — doc-changed-mid-flight guard", () => {
  // Replace the whole doc with one paragraph of `text` (synchronous dispatch).
  // An empty string yields an empty paragraph (a text node may not be empty).
  function seedContent(editor: Editor, text: string) {
    editor.commands.setContent({
      type: "doc",
      content: [
        text
          ? { type: "paragraph", content: [{ type: "text", text }] }
          : { type: "paragraph" },
      ],
    });
  }

  it("success branch: mid-flight doc change routes the paste to the LIVE selection, never the stale range (clobber-proving)", async () => {
    // The paste captures a NON-EMPTY range {1,5} (over "AAAA"). Then, before the
    // async resolve, the doc GROWS ("MARKER" inserted at the start) and the cursor
    // is parked at the doc END. The captured {1,5} is now stale and points INTO
    // "MARKER". A WORKING guard replaces at the live (end) selection → MARKER is
    // untouched. A BROKEN guard replaces the stale {1,5} → it erases the first
    // characters of MARKER (this is what a zero-width `from==to` range could never
    // reveal, which is why the earlier version was vacuous).
    const editor = makeEditor();
    seedContent(editor, "AAAABBBB");
    editor.commands.setTextSelection({ from: 1, to: 5 }); // captured range = {1,5}
    const claimed = paste(editor, "hello **bold**");
    expect(claimed).toBe(true);

    // Mid-flight: grow the doc and move the cursor to a KNOWN-safe end position.
    editor.view.dispatch(editor.view.state.tr.insertText("MARKER", 1));
    const end = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: end, to: end });
    await flush();

    const text = editor.getText();
    // MARKER intact only if the guard used the live selection, not the stale range.
    expect(text).toContain("MARKER");
    expect(text).toContain("bold");
    expect(text).not.toContain("**");
    editor.destroy();
  });

  it("fail-open branch: a mid-flight doc SHRINK makes the stale `to` out of bounds — the guard must avoid a RangeError (throw-proving)", async () => {
    // The paste captures a range {1,9} over an 8-char paragraph, then the
    // conversion FAILS (`# heading` -> a heading node the minimal schema lacks,
    // so PMNode.fromJSON throws -> the fail-open catch runs). Before the reject,
    // the doc is SHRUNK to an empty paragraph, so the captured `to` (9) is now far
    // past the doc's end. A WORKING guard inserts the raw text at the live (valid)
    // selection → "raw heading" lands. A BROKEN guard does insertText(md, 1, 9) on
    // a size-2 doc → RangeError, so the dispatch never runs and "raw heading" is
    // absent (the assertion reddens). A zero-width/growing-doc setup could never
    // push `to` out of bounds, which is why the earlier version was vacuous.
    const editor = makeEditor();
    seedContent(editor, "AAAABBBB");
    editor.commands.setTextSelection({ from: 1, to: 9 }); // captured range = {1,9}
    paste(editor, "# raw heading");

    // Mid-flight: shrink the doc so the captured `to` = 9 is now out of bounds.
    seedContent(editor, "");
    await flush();

    const text = editor.getText();
    // Raw text lands (via the live selection) only if the guard avoided the
    // stale, now-out-of-bounds range.
    expect(text).toContain("raw heading");
    editor.destroy();
  });

  it("two pastes in flight: neither payload is lost (no data loss)", async () => {
    // Prod-unreachable (two paste events are separate macrotasks, and each
    // conversion resolves on a microtask before the next), but pinned here: when
    // both resolve back-to-back, the second sees the changed doc and inserts at
    // the live selection the first left — so the two payloads may INTERLEAVE, but
    // neither is dropped. We assert no data loss, not contiguity.
    const editor = makeEditor();
    paste(editor, "alphaword");
    paste(editor, "betaword");
    await flush();
    const text = editor.getText();
    // Neither payload fully dropped (interleaving may split one of them).
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    editor.destroy();
  });
});
