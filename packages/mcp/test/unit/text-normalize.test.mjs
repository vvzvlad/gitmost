import { test } from "node:test";
import assert from "node:assert/strict";

import { stripInlineMarkdown } from "../../build/lib/text-normalize.js";

test("strips strong wrappers", () => {
  assert.equal(stripInlineMarkdown("**в полном порядке**"), "в полном порядке");
});

test("strips emphasis and trims a trailing emoji, keeps sentence punctuation", () => {
  assert.equal(stripInlineMarkdown("*Конец.* ✨"), "Конец.");
});

test("strips inline code", () => {
  assert.equal(stripInlineMarkdown("`code`"), "code");
});

test("links collapse to their visible text", () => {
  assert.equal(stripInlineMarkdown("[t](http://x)"), "t");
});

test("a plain string is unchanged", () => {
  assert.equal(stripInlineMarkdown("just plain text"), "just plain text");
});

test("a string of only markers returns the original", () => {
  assert.equal(stripInlineMarkdown("***"), "***");
});

test("nested wrappers collapse to the inner text", () => {
  assert.equal(stripInlineMarkdown("**_x_**"), "x");
});

test("image syntax collapses to its alt text", () => {
  assert.equal(stripInlineMarkdown("![alt](src)"), "alt");
});

test("a trailing flag emoji is trimmed", () => {
  // Regional-indicator flags are not Extended_Pictographic, so this guards the
  // explicit U+1F1E6–U+1F1FF range in the decoration-trim class.
  assert.equal(stripInlineMarkdown("hello 🇺🇸").trim(), "hello");
});
