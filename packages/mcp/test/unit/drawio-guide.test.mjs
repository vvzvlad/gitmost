// Unit tests for the drawioGuide progressive-disclosure reference (issue #424).
// Acceptance #2: every section is returned and each is <= ~4KB so pulling one
// does not bloat the model's context.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getGuideSection,
  GUIDE_SECTIONS,
} from "../../build/lib/drawio-guide.js";

const MAX_BYTES = 4096; // "<= ~4KB" acceptance bound.

test("every section is returned and is under ~4KB", () => {
  assert.deepEqual(GUIDE_SECTIONS, [
    "skeleton",
    "layout",
    "containers",
    "icons-aws",
    "icons-azure",
  ]);
  for (const s of GUIDE_SECTIONS) {
    const { section, content } = getGuideSection(s);
    assert.equal(section, s);
    assert.ok(content.length > 200, `${s}: suspiciously short`);
    const bytes = Buffer.byteLength(content, "utf8");
    assert.ok(bytes <= MAX_BYTES, `${s}: ${bytes} bytes exceeds ${MAX_BYTES}`);
  }
});

test("each section's content matches its topic", () => {
  assert.match(getGuideSection("skeleton").content, /mxGraphModel/);
  assert.match(getGuideSection("skeleton").content, /adaptiveColors="auto"/);
  assert.match(getGuideSection("layout").content, /elk/i);
  assert.match(getGuideSection("layout").content, /150px|<150/);
  assert.match(getGuideSection("containers").content, /fillColor=none/);
  assert.match(getGuideSection("icons-aws").content, /resourceIcon/);
  assert.match(getGuideSection("icons-aws").content, /elasticsearch_service/);
  assert.match(getGuideSection("icons-azure").content, /img\/lib\/azure2/);
});

test("omitting the section returns the index of sections", () => {
  const idx = getGuideSection();
  assert.equal(idx.section, "index");
  for (const s of GUIDE_SECTIONS) assert.ok(idx.content.includes(s));
  assert.ok(Buffer.byteLength(idx.content, "utf8") <= MAX_BYTES);
});

test("an unknown section falls back to the index", () => {
  const idx = getGuideSection("nonsense");
  assert.equal(idx.section, "index");
});
