// #409: unstorableYjsError diagnostics PRECEDENCE. The opaque Yjs encode failure
// (`Unknown node type: undefined`) is a node-SHAPE problem, so the shared
// findInvalidNode is consulted FIRST and yields a path-anchored node message;
// only a shape-sound doc falls back to findUnstorableAttr (undefined/function/
// etc. attr values). Exercised through `assertYjsEncodable`, which runs the same
// encode + error-wrapping the live write path uses.
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertYjsEncodable } from "../../build/lib/collaboration.js";
import {
  findInvalidNode,
  findUnstorableAttr,
} from "@docmost/prosemirror-markdown";

const doc = (...content) => ({ type: "doc", content });

test("a nested typeless node yields the rich node-shape message (not an attr hint)", () => {
  const bad = doc({
    type: "paragraph",
    content: [{ text: "oops", marks: [] }], // missing "type":"text"
  });
  assert.throws(
    () => assertYjsEncodable(bad),
    (err) => {
      assert.match(err.message, /Invalid node:/);
      assert.match(err.message, /missing "type"/);
      assert.match(err.message, /content\[0\]/);
      // It must NOT fall through to the generic attribute sentence.
      assert.doesNotMatch(err.message, /Offending attribute/);
      assert.doesNotMatch(
        err.message,
        /attribute likely holds a value Yjs cannot store/,
      );
      return true;
    },
  );
});

test("PRECEDENCE: a genuine undefined-attr case is a node-SHAPE-clean case, so the attr fallback fires", () => {
  // A doc whose node shapes are ALL valid but that carries a Yjs-unstorable
  // undefined attribute. unstorableYjsError checks findInvalidNode FIRST (must
  // miss here) and only then findUnstorableAttr (must hit) — this is exactly the
  // division of labor that keeps a real attr problem from being mislabelled as a
  // node-shape problem, and vice versa. We assert the two helpers directly (the
  // wrapper is not exported) because sanitizeForYjs strips undefined attrs before
  // the live encoder ever sees them, so this branch cannot be reached through
  // assertYjsEncodable without also failing the clone.
  const attrProblem = doc({
    type: "paragraph",
    attrs: { id: "p1", indent: undefined },
    content: [{ type: "text", text: "hi" }],
  });
  // findInvalidNode: shape is clean -> null (so the wrapper does NOT emit
  // "Invalid node").
  assert.equal(findInvalidNode(attrProblem), null);
  // findUnstorableAttr: pinpoints the undefined attr -> the fallback message.
  assert.match(findUnstorableAttr(attrProblem) ?? "", /indent \(undefined\)/);
});

test("PRECEDENCE: a node-shape problem is caught by findInvalidNode even when an attr is also unstorable", () => {
  // Both a shape problem (typeless nested leaf) AND an unstorable attr exist;
  // findInvalidNode wins, so the model is pointed at the node shape (the real
  // root cause of `Unknown node type: undefined`), not the attribute.
  const both = doc({
    type: "paragraph",
    attrs: { id: "p1", indent: undefined },
    content: [{ text: "oops" }],
  });
  const shape = findInvalidNode(both);
  assert.notEqual(shape, null);
  assert.match(shape.summary, /missing "type"/);
});

test("a fully valid document encodes without throwing", () => {
  const good = doc({
    type: "paragraph",
    attrs: { id: "p1" },
    content: [{ type: "text", text: "hi" }],
  });
  assert.doesNotThrow(() => assertYjsEncodable(good));
});
