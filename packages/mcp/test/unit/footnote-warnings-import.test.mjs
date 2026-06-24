import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeFootnotes,
  footnoteWarningsField,
} from "../../build/lib/footnote-analyze.js";
import {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
} from "../../build/lib/markdown-document.js";

// Pins the footnoteWarnings PLUMBING contract (#169 review): the field is
// present only on problems and omitted on clean input, AND `import_page_markdown`
// analyzes the BODY (after the docmost:meta / docmost:comments blocks) — so a
// footnote-like token inside those JSON blocks never warns, while a real marker
// in the body does. importPageMarkdown does exactly
// `footnoteWarningsField(parseDocmostMarkdown(full).body)` over a collab socket
// this harness does not stand up, so we test the same pure composition directly.

test("footnoteWarningsField is present on problems and omitted on clean input", () => {
  const problem = footnoteWarningsField("See[^missing].\n\n[^a]: defined");
  assert.ok(Array.isArray(problem.footnoteWarnings));
  assert.match(problem.footnoteWarnings.join("\n"), /no matching definition/);

  const clean = footnoteWarningsField("A[^a] and reuse[^a].\n\n[^a]: fine");
  assert.deepEqual(clean, {}); // no key at all on clean input
});

test("import analyzes the BODY only — tokens inside meta/comments never warn", () => {
  // meta + comments JSON carry `[^metaonly]` / `[^commentonly]`-looking text; the
  // BODY has a genuinely dangling `[^bodyref]`.
  const full = serializeDocmostMarkdown(
    { pageId: "p1", note: "front-matter mentions [^metaonly] in text" },
    "Body with a dangling[^bodyref] marker.",
    [{ id: "c1", content: "a comment that says [^commentonly]" }],
  );

  const { body } = parseDocmostMarkdown(full);
  // Sanity: the meta/comments markers are NOT in the parsed body.
  assert.ok(!body.includes("[^metaonly]"));
  assert.ok(!body.includes("[^commentonly]"));

  const field = footnoteWarningsField(body);
  const joined = (field.footnoteWarnings ?? []).join("\n");
  // ONLY the body's dangling reference is flagged.
  assert.match(joined, /\[\^bodyref\]/);
  assert.ok(!joined.includes("metaonly"));
  assert.ok(!joined.includes("commentonly"));

  // Cross-check against analyzeFootnotes directly (same composition the importer uses).
  assert.deepEqual(analyzeFootnotes(body).danglingReferences, ["bodyref"]);
});

test("import on a clean body yields no footnoteWarnings field", () => {
  const full = serializeDocmostMarkdown(
    { pageId: "p1" },
    "Clean body[^a] reusing[^a].\n\n[^a]: ok",
    [],
  );
  const { body } = parseDocmostMarkdown(full);
  assert.deepEqual(footnoteWarningsField(body), {});
});
