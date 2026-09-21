import { test } from "node:test";
import assert from "node:assert/strict";

import { applyTextEdits } from "../../build/lib/json-edit.js";

const SHY = "­";
const textNode = (text, extra = {}) => ({ type: "text", text, ...extra });
const paragraph = (...children) => ({ type: "paragraph", content: children });
const doc = (...children) => ({ type: "doc", content: children });

// Collect a failure reason for every granular-edit failure CLASS. Each edit is
// crafted so applyTextEdits routes it to a distinct refusal/miss branch.
function collectReasons() {
  const reasons = [];
  const push = (input, edits) => {
    const { failed } = applyTextEdits(input, edits);
    for (const f of failed) reasons.push({ label: f.find, reason: f.reason });
  };

  // 1. footnote token in replace
  push(doc(paragraph(textNode("body text here"))), [
    { find: "body", replace: "body^[a note]" },
  ]);
  // 2. formatting-only toggle
  push(doc(paragraph(textNode("plain word here"))), [
    { find: "word", replace: "**word**" },
  ]);
  // 3. markers smuggled in replace (find located via markdown-strip)
  push(doc(paragraph(textNode("see the docs page"))), [
    { find: "the **docs**", replace: "the [docs](http://x)" },
  ]);
  // 4. ambiguity (multi-match without replaceAll)
  push(doc(paragraph(textNode("na na na"))), [{ find: "na", replace: "la" }]);
  // 5. atom crossing (hardBreak), no id
  push(
    doc(paragraph(textNode("first line"), { type: "hardBreak" }, textNode("second line"))),
    [{ find: "first line second line", replace: "x" }],
  );
  // 5b. atom crossing WITH a real id (must suggest patchNode <id>, never #idx)
  push(
    doc({
      type: "paragraph",
      attrs: { id: "para-1" },
      content: [textNode("aa"), { type: "hardBreak" }, textNode("bb")],
    }),
    [{ find: "aabb", replace: "x" }],
  );
  // 6. multi-block crossing
  push(doc(paragraph(textNode("first line")), paragraph(textNode("second line"))), [
    { find: "first line second", replace: "x" },
  ]);
  // 7. typography-only
  push(doc(paragraph(textNode("«при" + SHY + "вет»"))), [
    { find: '"привет"', replace: '"hi"' },
  ]);
  // 8. closest-block-text hint (genuine miss)
  push(doc(paragraph(textNode("the quick brown fox jumps"))), [
    { find: "fox jumps now", replace: "x" },
  ]);
  return reasons;
}

test("NO granular-edit failure reason suggests a full-page tool", () => {
  const reasons = collectReasons();
  assert.ok(reasons.length >= 9, `expected many reasons, got ${reasons.length}`);
  for (const { label, reason } of reasons) {
    assert.doesNotMatch(
      reason,
      /updatePageJson/,
      `reason for "${label}" must not suggest updatePageJson: ${reason}`,
    );
    assert.doesNotMatch(
      reason,
      /updatePageMarkdown/,
      `reason for "${label}" must not suggest updatePageMarkdown: ${reason}`,
    );
  }
});

test("patchNode is never suggested with a #idx argument", () => {
  const reasons = collectReasons();
  for (const { label, reason } of reasons) {
    // A #idx immediately after patchNode would be a dead-end suggestion.
    assert.doesNotMatch(
      reason,
      /patchNode\s+#/,
      `reason for "${label}" suggests patchNode #idx: ${reason}`,
    );
  }
});
