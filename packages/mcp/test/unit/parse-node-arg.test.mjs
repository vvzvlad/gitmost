import { test } from "node:test";
import assert from "node:assert/strict";

import { parseNodeArg } from "../../build/lib/parse-node-arg.js";

test("parseNodeArg passes an object through unchanged", () => {
  const obj = { type: "paragraph", content: [] };
  assert.strictEqual(parseNodeArg(obj), obj);
});

test("parseNodeArg passes undefined/null through unchanged", () => {
  assert.strictEqual(parseNodeArg(undefined), undefined);
  assert.strictEqual(parseNodeArg(null), null);
});

test("parseNodeArg parses a valid JSON string", () => {
  const parsed = parseNodeArg('{"type":"paragraph"}');
  assert.deepStrictEqual(parsed, { type: "paragraph" });
});

test("parseNodeArg throws the default message on invalid JSON string", () => {
  assert.throws(() => parseNodeArg("{not json"), {
    message: "node was a string but not valid JSON",
  });
});

test("parseNodeArg throws a custom message on invalid JSON string", () => {
  assert.throws(
    () => parseNodeArg("{not json", "content was a string but not valid JSON"),
    { message: "content was a string but not valid JSON" },
  );
});
