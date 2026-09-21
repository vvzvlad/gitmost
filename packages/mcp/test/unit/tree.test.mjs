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

// ---------------------------------------------------------------------------
// #443 getTree output shape: { pageId, title, children?, hasChildren? }
// ---------------------------------------------------------------------------

// A small representative space used across the getTree tests:
//   r1 (Infrastructure)
//     c1 (Datacenter A)
//       g1 (Servers)   [leaf]
//     c2 (Datacenter B) [leaf]
//   r2 (Notes)          [leaf]
const SAMPLE = [
  { id: "r2", slugId: "s-r2", title: "Notes", position: "a1", icon: "📝", hasChildren: false },
  { id: "r1", slugId: "s-r1", title: "Infrastructure", position: "a0", icon: "🏢", hasChildren: true },
  { id: "c2", slugId: "s-c2", title: "Datacenter B", position: "b1", parentPageId: "r1", icon: "🅱️", hasChildren: false },
  { id: "c1", slugId: "s-c1", title: "Datacenter A", position: "b0", parentPageId: "r1", icon: "🅰️", hasChildren: true },
  { id: "g1", slugId: "s-g1", title: "Servers", position: "c0", parentPageId: "c1", icon: "🖥️", hasChildren: false },
];

test("getTree shape: correct nesting + order-by-position, only {pageId,title,children?}, no leak", () => {
  const tree = buildPageTree(SAMPLE, { shape: "getTree" });

  // Roots sorted by position: r1 (a0) before r2 (a1).
  assert.deepEqual(
    tree.map((n) => n.pageId),
    ["r1", "r2"],
  );
  // r1's children sorted by position: c1 (b0) before c2 (b1).
  assert.deepEqual(
    tree[0].children.map((n) => n.pageId),
    ["c1", "c2"],
  );
  // Deep nesting: g1 under c1.
  assert.deepEqual(
    tree[0].children[0].children.map((n) => n.pageId),
    ["g1"],
  );

  // No slugId/icon/position/parentPageId/hasChildren leak on any node.
  const walk = (nodes) => {
    for (const n of nodes) {
      assert.deepEqual(
        Object.keys(n).sort(),
        n.children ? ["children", "pageId", "title"] : ["pageId", "title"],
        `unexpected keys on ${n.pageId}: ${Object.keys(n)}`,
      );
      assert.equal("slugId" in n, false);
      assert.equal("icon" in n, false);
      assert.equal("position" in n, false);
      assert.equal("parentPageId" in n, false);
      // Fully-expanded tree (no maxDepth): hasChildren never set.
      assert.equal("hasChildren" in n, false);
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
});

test("getTree maxDepth:1 returns roots only, each with hasChildren from the flat item", () => {
  const tree = buildPageTree(SAMPLE, { shape: "getTree", maxDepth: 1 });

  assert.deepEqual(
    tree.map((n) => n.pageId),
    ["r1", "r2"],
  );
  // No children arrays at depth 1 when maxDepth:1.
  for (const n of tree) assert.equal("children" in n, false);
  // r1 has children on the server -> hasChildren:true; r2 is a leaf -> omitted.
  assert.equal(tree[0].hasChildren, true);
  assert.equal("hasChildren" in tree[1], false);
});

test("getTree maxDepth:2 cuts grandchildren; hasChildren only on the cut interior node", () => {
  const tree = buildPageTree(SAMPLE, { shape: "getTree", maxDepth: 2 });

  const r1 = tree[0];
  // Depth-1 node r1 was EXPANDED (its children are present) -> no hasChildren.
  assert.equal("hasChildren" in r1, false);
  assert.equal(r1.children.length, 2);

  const [c1, c2] = r1.children;
  // c1 is at depth 2 (the cut) and has children on the server -> hasChildren:true,
  // and its grandchild g1 is NOT present.
  assert.equal(c1.pageId, "c1");
  assert.equal("children" in c1, false);
  assert.equal(c1.hasChildren, true);
  // c2 is at depth 2 but is a leaf on the server -> hasChildren omitted.
  assert.equal(c2.pageId, "c2");
  assert.equal("children" in c2, false);
  assert.equal("hasChildren" in c2, false);

  // r2 is a depth-1 leaf -> no hasChildren, no children.
  assert.equal("hasChildren" in tree[1], false);
});

test("getTree hasChildren is set ONLY on depth-cut nodes (not leaves, not expanded interior nodes)", () => {
  // Full tree (no cut): NO node anywhere carries hasChildren.
  const full = buildPageTree(SAMPLE, { shape: "getTree" });
  const anyHasChildren = (nodes) =>
    nodes.some((n) => "hasChildren" in n || (n.children && anyHasChildren(n.children)));
  assert.equal(anyHasChildren(full), false);
});

test("getTree orphan (parent filtered out) surfaces as a root, not dropped", () => {
  const tree = buildPageTree(
    [
      { id: "root", slugId: "s-root", title: "Root", position: "a0", hasChildren: true },
      // parentPageId points at an id NOT in the flat list (parent filtered by perms).
      { id: "orphan", slugId: "s-orphan", title: "Orphan", position: "a1", parentPageId: "gone", hasChildren: false },
    ],
    { shape: "getTree" },
  );

  assert.deepEqual(
    tree.map((n) => n.pageId).sort(),
    ["orphan", "root"],
  );
  const orphan = tree.find((n) => n.pageId === "orphan");
  assert.equal("children" in orphan, false);
  assert.equal("hasChildren" in orphan, false);
});

test("getTree rootPageId path: a seeded single-root subtree keeps the getTree shape", () => {
  // Simulate the server seeding the CTE with the subtree root c1: the flat list
  // it returns contains c1 (now a root, parent absent) + its descendant g1.
  const subtree = [
    { id: "c1", slugId: "s-c1", title: "Datacenter A", position: "b0", hasChildren: true },
    { id: "g1", slugId: "s-g1", title: "Servers", position: "c0", parentPageId: "c1", hasChildren: false },
  ];
  const tree = buildPageTree(subtree, { shape: "getTree" });

  assert.equal(tree.length, 1);
  assert.equal(tree[0].pageId, "c1");
  assert.deepEqual(
    tree[0].children.map((n) => n.pageId),
    ["g1"],
  );
  assert.equal("slugId" in tree[0], false);
});

test("getTree maxDepth<=0 / non-finite is treated as no cut (whole tree)", () => {
  for (const bad of [0, -3, NaN, Infinity, undefined]) {
    const tree = buildPageTree(SAMPLE, { shape: "getTree", maxDepth: bad });
    // Grandchild g1 present -> no cut applied.
    assert.deepEqual(
      tree[0].children[0].children.map((n) => n.pageId),
      ["g1"],
      `maxDepth=${bad} should not cut`,
    );
  }
});

test("buildPageTree() with no options is byte-identical to the historic lean call", () => {
  // Guard the existing callers: buildPageTree(pages) must be unchanged by the
  // additive options param.
  const withoutOpts = buildPageTree(SAMPLE);
  const withEmptyOpts = buildPageTree(SAMPLE, {});
  assert.deepEqual(withoutOpts, withEmptyOpts);
  // And it is the lean {id,slugId,title,children?} shape, not the getTree shape.
  assert.deepEqual(Object.keys(withoutOpts[0]).sort(), ["children", "id", "slugId", "title"]);
});
