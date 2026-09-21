import { describe, it, expect } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { recreateTransform } from "./recreateTransform";

/**
 * Issue #581 — randomized round-trip PROPERTY test for the linear array diff
 * (`fastCreatePatch` / `fastArrayDiff`). The fixed cases in
 * `recreateTransform.test.ts` cover the branches a human thought to write; the
 * failure modes of a custom Myers diff with five interacting heuristics live in
 * inputs nobody wrote by hand. This generates many random schema-basic document
 * pairs and asserts THE invariant that matters: replaying the produced steps on
 * `a` reproduces `b` exactly (`apply(recreateTransform(a,b).steps to a).eq(b)`).
 *
 * DETERMINISM: a fixed-seed mulberry32 PRNG (NOT Math.random) drives every choice,
 * so a CI failure is exactly reproducible from the logged seed. Docs are built via
 * the real schema and node constructors (never hand-rolled JSON), so every pair is
 * schema-valid and free of the rfc6902 corner cases (undefined array elements,
 * root-type replace) that node-shaped input cannot produce.
 */

// --- seeded PRNG (mulberry32): deterministic, reproducible in CI ---------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed is FIXED so this is a stable regression guard. To reproduce a failure,
// read the seed logged below and drop it into a scratch run.
const SEED = 0x581c0de;
const N_PAIRS = 300;

// --- schema-basic node builders -----------------------------------------------
const strong = schema.marks.strong.create();
const em = schema.marks.em.create();

const WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "текст", // non-Latin, exercises the Unicode-aware TOKEN_RE
  "пример",
  "alpha",
  "beta",
  "gamma",
  "42x",
];

function makePrng(seed: number) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n); // 0..n-1
  const pick = <T>(arr: T[]): T => arr[int(arr.length)];
  const chance = (p: number) => rnd() < p;
  return { rnd, int, pick, chance };
}

type R = ReturnType<typeof makePrng>;

// A non-empty text run (schema.text throws on empty) with random marks.
function textRun(r: R): PMNode {
  const count = 1 + r.int(6);
  const words = Array.from({ length: count }, () => r.pick(WORDS));
  const text = words.join(" ");
  const marks: any[] = [];
  if (r.chance(0.25)) marks.push(strong);
  if (r.chance(0.25)) marks.push(em);
  return schema.text(text, marks.length ? marks : undefined);
}

// Inline content array: text runs interleaved with occasional hard_breaks. A
// hard_break next to a text run is what creates cross-type positional pairs (the
// type-guard branch) once blocks are edited/reordered.
function inlineContent(r: R): PMNode[] {
  const runs = 1 + r.int(3);
  const out: PMNode[] = [];
  for (let i = 0; i < runs; i++) {
    out.push(textRun(r));
    if (i < runs - 1 && r.chance(0.3)) out.push(schema.node("hard_break"));
  }
  return out;
}

// A single block: paragraph | heading | blockquote (blockquote needs block+).
function block(r: R, allowNesting = true): PMNode {
  const roll = r.int(allowNesting ? 10 : 9);
  if (roll < 6) return schema.node("paragraph", null, inlineContent(r));
  if (roll < 9)
    return schema.node("heading", { level: 1 + r.int(6) }, inlineContent(r));
  // blockquote wrapping 1..3 paragraphs — exercises recursion into a sub-array.
  const inner = Array.from({ length: 1 + r.int(3) }, () =>
    schema.node("paragraph", null, inlineContent(r)),
  );
  return schema.node("blockquote", null, inner);
}

// A document of `min..max` blocks (doc is block+, so at least one).
function makeDoc(r: R, min: number, max: number): PMNode {
  const n = min + r.int(max - min + 1);
  const blocks = Array.from({ length: n }, () => block(r));
  return schema.node("doc", null, blocks);
}

// Derive `b` from `a`'s block list by applying K random structural/text edits.
// Every mutation keeps the block list valid (>=1 block, blocks assembled from the
// same valid constructors), so the resulting doc is always schema-valid.
function mutate(r: R, aBlocks: PMNode[]): PMNode {
  let blocks = aBlocks.slice();
  const edits = 1 + r.int(6);
  for (let e = 0; e < edits; e++) {
    if (blocks.length === 0) blocks.push(block(r));
    const op = r.int(6);
    if (op === 0) {
      // insert a fresh block at a random position
      blocks.splice(r.int(blocks.length + 1), 0, block(r));
    } else if (op === 1 && blocks.length > 1) {
      // delete a block
      blocks.splice(r.int(blocks.length), 1);
    } else if (op === 2) {
      // replace a block wholesale (often a cross-type positional pair)
      blocks[r.int(blocks.length)] = block(r);
    } else if (op === 3 && blocks.length > 1) {
      // move a block (reorder)
      const from = r.int(blocks.length);
      const [moved] = blocks.splice(from, 1);
      blocks.splice(r.int(blocks.length + 1), 0, moved);
    } else if (op === 4) {
      // edit text inside a paragraph/heading (regenerate its inline content)
      const i = r.int(blocks.length);
      const node = blocks[i];
      if (node.type.name === "paragraph" || node.type.name === "heading") {
        blocks[i] = node.type.create(node.attrs, inlineContent(r));
      }
    } else {
      // bulk edit: insert several blocks at once (drives coarse/snapshot paths)
      const many = Array.from({ length: 3 + r.int(8) }, () => block(r));
      blocks.splice(r.int(blocks.length + 1), 0, ...many);
    }
  }
  if (blocks.length === 0) blocks.push(block(r));
  return schema.node("doc", null, blocks);
}

// Replay the diff's steps onto a fresh Transform built from `fromDoc` — the same
// faithful "apply(diff) == target" check the fixed round-trip tests use. Exercises
// the actual Step objects, not the transform's internal accumulated doc.
function applyDiff(fromDoc: PMNode, toDoc: PMNode, options?: any): PMNode {
  const tr = recreateTransform(fromDoc, toDoc, options);
  const replay = new Transform(fromDoc);
  tr.steps.forEach((s) => {
    const result = replay.maybeStep(s);
    if (result.failed) throw new Error(`step failed: ${result.failed}`);
  });
  return replay.doc;
}

describe("recreateTransform #581 property (seeded random round-trip)", () => {
  it(`round-trips ${N_PAIRS} random schema-basic doc pairs (seed=0x${SEED.toString(16)})`, () => {
    // Log the seed so any failure is reproducible from CI output.
    console.log(
      `[#581 property test] seed=0x${SEED.toString(16)} N=${N_PAIRS}`,
    );
    const r = makePrng(SEED);
    const options = { complexSteps: false, wordDiffs: true, simplifyDiff: true };

    for (let i = 0; i < N_PAIRS; i++) {
      // Mix sizes so pairs hit the granular path AND the large-array paths
      // (degenerate rewrite >50 blocks, coarse snapshot >100 blocks). ~1 in 5 is
      // large; the rest are small/medium.
      const large = r.chance(0.2);
      const a = large ? makeDoc(r, 55, 140) : makeDoc(r, 1, 12);

      // ~1 in 6 is a same-type wholesale rewrite (regenerate every block) to trip
      // the degenerate branch; otherwise derive b via incremental edits.
      let b: PMNode;
      if (large && r.chance(0.5)) {
        const n = a.childCount;
        b = schema.node(
          "doc",
          null,
          Array.from({ length: n }, () => block(r)),
        );
      } else {
        b = mutate(r, a.content.content);
      }

      let out: PMNode;
      try {
        out = applyDiff(a, b, options);
      } catch (err) {
        throw new Error(
          `[#581 property] pair ${i} threw (seed=0x${SEED.toString(16)}): ${
            (err as Error).message
          }\nA=${JSON.stringify(a.toJSON())}\nB=${JSON.stringify(b.toJSON())}`,
        );
      }
      if (!out.eq(b)) {
        throw new Error(
          `[#581 property] pair ${i} round-trip mismatch (seed=0x${SEED.toString(
            16,
          )})\nA=${JSON.stringify(a.toJSON())}\nB=${JSON.stringify(
            b.toJSON(),
          )}\nGOT=${JSON.stringify(out.toJSON())}`,
        );
      }
      expect(out.eq(b)).toBe(true);
    }
    // 300 pairs incl. large (>100-block) docs under wordDiffs run ~7s; give a
    // generous timeout so CI variance never flakes it (correctness, not speed, is
    // the point here).
  }, 30000);
});
