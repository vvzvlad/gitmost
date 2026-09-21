import { test } from "node:test";
import assert from "node:assert/strict";

import { footnoteWarningsField } from "../../build/lib/footnote-analyze.js";
import {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
} from "../../build/lib/markdown-document.js";

// Pins the footnoteWarnings PLUMBING contract (#169 review; reduced in #414): the
// field is present only when legacy reference-style `[^id]:` syntax is used and
// omitted otherwise, AND `importPageMarkdown` analyzes the BODY (after the
// docmost:meta / docmost:comments blocks) — so a footnote-like token inside those
// JSON blocks never warns, while a real definition in the body does.
// importPageMarkdown does exactly `footnoteWarningsField(parseDocmostMarkdown(full).body)`
// over a collab socket this harness does not stand up, so we test the same pure
// composition directly.

test("footnoteWarningsField is present on legacy syntax and omitted on the inline form", () => {
  const legacy = footnoteWarningsField("See[^a].\n\n[^a]: defined");
  assert.ok(Array.isArray(legacy.footnoteWarnings));
  assert.match(legacy.footnoteWarnings.join("\n"), /reference-style footnotes/i);

  const inline = footnoteWarningsField("A note.^[the body] reused.^[the body]");
  assert.deepEqual(inline, {}); // no key at all on inline-footnote input
});

test("import analyzes the BODY only — tokens inside meta/comments never warn", () => {
  // meta + comments JSON carry `[^metaonly]:` / `[^commentonly]:`-looking text;
  // the BODY has a genuine legacy `[^bodyref]:` definition.
  const full = serializeDocmostMarkdown(
    { pageId: "p1", note: "front-matter mentions [^metaonly]: in text" },
    "Body with a legacy[^bodyref] marker.\n\n[^bodyref]: the definition",
    [{ id: "c1", content: "a comment that says [^commentonly]: text" }],
  );

  const { body } = parseDocmostMarkdown(full);
  // Sanity: the meta/comments markers are NOT in the parsed body.
  assert.ok(!body.includes("[^metaonly]"));
  assert.ok(!body.includes("[^commentonly]"));

  const field = footnoteWarningsField(body);
  // ONLY the body's legacy definition triggers the advisory.
  assert.ok(Array.isArray(field.footnoteWarnings));
  assert.match(field.footnoteWarnings.join("\n"), /reference-style footnotes/i);

  // The meta/comments tokens, analyzed on their own, would NOT have warned in a
  // way that leaks here — the field is computed over the body only.
  assert.deepEqual(footnoteWarningsField("front-matter mentions text"), {});
});

test("import on an inline-footnote body yields no footnoteWarnings field", () => {
  const full = serializeDocmostMarkdown(
    { pageId: "p1" },
    "Clean body.^[a note] reusing.^[a note]",
    [],
  );
  const { body } = parseDocmostMarkdown(full);
  assert.deepEqual(footnoteWarningsField(body), {});
});
