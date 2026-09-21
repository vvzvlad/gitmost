import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Heading } from "@tiptap/extension-heading";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import { gitmostInsertTranscriptIntoEditor } from "./gitmost-recording.ts";

const ZWSP = "​"; // U+200B — asserted ABSENT (the block-escape lives in the serializer now)

/**
 * #377 — the web-side bridge must append the native host's transcript below the
 * recording. These exercise the pure insert helper through a REAL Tiptap editor
 * (Document/Paragraph/Text/Heading + Bold/Italic/Link marks so an HTML-parsing
 * regression would be caught), asserting the resulting document rather than
 * mocking the editor: transcript present -> "Transcript" heading + one paragraph
 * per non-empty line; content is inserted as LITERAL TEXT (no HTML/markdown
 * parsing); col-0 markdown block triggers are stored verbatim (the git-sync
 * serializer block-escapes them, so no client-side ZWSP is needed);
 * absent/empty/non-string -> no-op.
 */
describe("gitmostInsertTranscriptIntoEditor", () => {
  const makeEditor = () =>
    new Editor({
      // Bold/Italic/Link are registered specifically so that IF the helper ever
      // regressed to inserting an HTML/markdown string (instead of a text node),
      // TipTap would parse `<b>`/`*..*`/`[..](..)` into marks and the literal-
      // text assertions below would fail.
      extensions: [Document, Paragraph, Text, Heading, Bold, Italic, Link],
      // Start from a single empty paragraph (a fresh page's baseline). The
      // helper appends at the end of the doc, i.e. below existing content.
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });

  it("inserts a Transcript heading + one paragraph per non-empty line, verbatim", () => {
    const editor = makeEditor();

    const inserted = gitmostInsertTranscriptIntoEditor(
      editor,
      "You: hello there\nSpeaker 1: hi\n\nYou: bye",
    );

    expect(inserted).toBe(true);

    const nodes = (editor.getJSON().content ?? []) as any[];
    // A level-2 "Transcript" heading is present.
    const heading = nodes.find((n) => n.type === "heading");
    expect(heading?.attrs?.level).toBe(2);
    expect(heading?.content?.[0]?.text).toBe("Transcript");

    // Every non-empty transcript line becomes a paragraph, in order, verbatim;
    // the blank line between them is dropped.
    const texts = nodes
      .filter((n) => n.type === "paragraph")
      .map((n) => n.content?.[0]?.text)
      .filter((t) => typeof t === "string");
    expect(texts).toEqual(["You: hello there", "Speaker 1: hi", "You: bye"]);

    editor.destroy();
  });

  it("inserts HTML + markdown metacharacters as LITERAL text (no injection / no mark parsing)", () => {
    const editor = makeEditor();
    const line =
      "You: <b>bold</b> <script>alert(1)</script> and *stars* and [link](x)";

    const inserted = gitmostInsertTranscriptIntoEditor(editor, line);
    expect(inserted).toBe(true);

    const paras = (editor.getJSON().content ?? []).filter(
      (n: any) => n.type === "paragraph",
    ) as any[];
    // The transcript line is exactly ONE paragraph holding a SINGLE text node
    // whose text is the verbatim string — not split into bold/link/other nodes,
    // not carrying any marks, not raw HTML. This FAILS if the helper switched to
    // insertContent(htmlString): TipTap would then parse <b>/[link](x)/*stars*.
    const content = paras[paras.length - 1].content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].marks ?? []).toEqual([]);
    expect(content[0].text).toBe(line);
    // And no bold/italic/link mark exists anywhere in the document.
    const html = editor.getHTML();
    expect(html).not.toMatch(/<(strong|b|em|i|a)\b/);
    // The angle brackets survived as escaped entities (literal text), not a live
    // <script>/<b> element.
    expect(html).not.toMatch(/<script/i);

    editor.destroy();
  });

  it("inserts col-0 markdown block triggers as verbatim paragraph text (no ZWSP workaround)", () => {
    const editor = makeEditor();
    // Trigger lines (some with a leaked indent) + a normal prefixed line. The
    // git-sync serializer now block-escapes a leading trigger itself, so the
    // bridge inserts each line's TEXT byte-exact (only the leaked indent is
    // trimmed) — no invisible ZWSP is prepended anymore.
    const inserted = gitmostInsertTranscriptIntoEditor(
      editor,
      [
        "- dash",
        "  > quote", // leading indent is trimmed, text otherwise verbatim
        "# hash",
        "1. one",
        "> [!info] note",
        "```js",
        "---",
        "***",
        "___",
        "You: normal line",
      ].join("\n"),
    );
    expect(inserted).toBe(true);

    const texts = (editor.getJSON().content ?? [])
      .filter((n: any) => n.type === "paragraph")
      .map((n: any) => n.content?.[0]?.text)
      .filter((t: any) => typeof t === "string") as string[];

    // Each trigger line is stored as its own byte-exact text (indent trimmed);
    // the git-sync round-trip keeps it a paragraph via the serializer's
    // block-escape, so no ZWSP is needed here.
    expect(texts).toEqual([
      "- dash",
      "> quote",
      "# hash",
      "1. one",
      "> [!info] note",
      "```js",
      "---",
      "***",
      "___",
      "You: normal line",
    ]);
    // Guard: no invisible ZWSP leaked into any inserted line.
    for (const t of texts) expect(t).not.toContain(ZWSP);

    editor.destroy();
  });

  it("is a no-op for undefined / empty / whitespace-only / non-string transcripts", () => {
    for (const value of [undefined, "", "   \n  \n", 42, {}, null]) {
      const editor = makeEditor();
      const before = JSON.stringify(editor.getJSON());

      const inserted = gitmostInsertTranscriptIntoEditor(editor, value as any);

      expect(inserted).toBe(false);
      // Document is untouched (audio-only behavior preserved).
      expect(JSON.stringify(editor.getJSON())).toBe(before);
      editor.destroy();
    }
  });
});
