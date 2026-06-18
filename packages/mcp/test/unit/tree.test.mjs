import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPageTree } from "../../build/lib/tree.js";

test("buildPageTree nests two children under their parent", () => {
  const tree = buildPageTree([
    { id: "root", slugId: "s-root", title: "Root", position: "a0" },
    {
      id: "c1",
      slugId: "s-c1",
      title: "Child 1",
      position: "a0",
      parentPageId: "root",
    },
    {
      id: "c2",
      slugId: "s-c2",
      title: "Child 2",
      position: "a1",
      parentPageId: "root",
    },
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "root");
  assert.equal(tree[0].children.length, 2);
  assert.deepEqual(
    tree[0].children.map((c) => c.id),
    ["c1", "c2"],
  );
});

test("buildPageTree sorts children and roots ascending by position", () => {
  const tree = buildPageTree([
    // Roots provided out of order.
    { id: "r2", slugId: "s-r2", title: "R2", position: "a2" },
    { id: "r1", slugId: "s-r1", title: "R1", position: "a1" },
    // Children provided out of order.
    {
      id: "c2",
      slugId: "s-c2",
      title: "C2",
      position: "b1",
      parentPageId: "r1",
    },
    {
      id: "c1",
      slugId: "s-c1",
      title: "C1",
      position: "b0",
      parentPageId: "r1",
    },
  ]);

  assert.deepEqual(
    tree.map((n) => n.id),
    ["r1", "r2"],
  );
  assert.deepEqual(
    tree[0].children.map((c) => c.id),
    ["c1", "c2"],
  );
});

test("buildPageTree omits the children key for leaf nodes", () => {
  const tree = buildPageTree([
    { id: "leaf", slugId: "s-leaf", title: "Leaf", position: "a0" },
  ]);

  assert.equal(tree.length, 1);
  assert.equal("children" in tree[0], false);
});

test("buildPageTree promotes an orphan (missing parent) to a root", () => {
  const tree = buildPageTree([
    {
      id: "orphan",
      slugId: "s-orphan",
      title: "Orphan",
      position: "a0",
      // parentPageId references an id NOT present in the input.
      parentPageId: "does-not-exist",
    },
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "orphan");
  assert.equal("children" in tree[0], false);
});

test("buildPageTree is cycle-safe (two-node cycle does not recurse or appear in output)", () => {
  // A <-> B cycle: each node's parent is present, so neither becomes a root.
  // The cycle component is unreachable from the returned roots, so the output
  // is finite and JSON-serializable (no infinite recursion / circular JSON).
  const tree = buildPageTree([
    { id: "A", slugId: "s-A", title: "A", position: "a0", parentPageId: "B" },
    { id: "B", slugId: "s-B", title: "B", position: "a1", parentPageId: "A" },
  ]);

  assert.deepEqual(tree, []);
  // Must not throw on a structure that contains the cyclic component internally.
  assert.doesNotThrow(() => JSON.stringify(tree));
});

test("buildPageTree is self-reference-safe (node parented to itself is dropped, no crash)", () => {
  const tree = buildPageTree([
    { id: "root", slugId: "s-root", title: "Root", position: "a0" },
    // Self-referencing node: its parent is present (itself) -> not a root.
    { id: "self", slugId: "s-self", title: "Self", position: "a0", parentPageId: "self" },
  ]);

  assert.deepEqual(
    tree.map((n) => n.id),
    ["root"],
  );
  assert.doesNotThrow(() => JSON.stringify(tree));
});

test("buildPageTree output shape is lean (drops position/parentPageId/hasChildren)", () => {
  const tree = buildPageTree([
    {
      id: "p1",
      slugId: "s-p1",
      title: "P1",
      position: "a0",
      parentPageId: null,
      hasChildren: false,
      spaceId: "space-1",
    },
  ]);

  const node = tree[0];
  assert.deepEqual(node, { id: "p1", slugId: "s-p1", title: "P1" });
  assert.equal("position" in node, false);
  assert.equal("parentPageId" in node, false);
  assert.equal("hasChildren" in node, false);
  assert.equal("spaceId" in node, false);
});
