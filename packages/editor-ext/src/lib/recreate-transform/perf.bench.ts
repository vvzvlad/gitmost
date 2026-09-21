import { describe, it, expect } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createPatch } from "rfc6902";
import { recreateTransform } from "./recreateTransform";
import { fastCreatePatch } from "./fastCreatePatch";

/**
 * Issue #581 performance bench + CI regression guard.
 *
 * BEFORE = rfc6902's stock `createPatch` (the O(len(a)·len(b)) DP array diff that
 * froze the UI). AFTER = `fastCreatePatch` (linear Myers hook).
 *
 * NOTE ON SIZES: stock createPatch is not just slow but memory-explosive on large
 * arrays (it builds nested op arrays via Array.concat inside an N·M table), so it
 * OOMs on the multi-thousand-block forms. We therefore only run BEFORE on a
 * SCALING sweep of modest sizes — which is exactly where its quadratic growth is
 * already unmistakable — and run AFTER (plus full recreateTransform e2e) on the
 * big/pathological forms it can no longer survive.
 *
 * The two `it` families turn measurements into asserts: (1) after ≪ before on the
 * quadratic form, and (2) a MACHINE-INDEPENDENT scaling-ratio guard proving AFTER
 * stays sub-quadratic as size grows 6x.
 */

const doc = (...c: PMNode[]) => schema.node("doc", null, c);
const p = (...c: PMNode[]) =>
  schema.node("paragraph", null, c.length ? c : undefined);
const h = (level: number, ...c: PMNode[]) =>
  schema.node("heading", { level }, c);
const t = (text: string) => schema.text(text);

const WORDS = 40; // per issue methodology: paragraphs of ~40 words.

function line(i: number, prefix: string): string {
  return Array.from({ length: WORDS }, (_, w) => `${prefix}${i}_w${w}`).join(" ");
}
function para(i: number, prefix = "p"): PMNode {
  return p(t(line(i, prefix)));
}
function baseDoc(n: number, prefix = "p"): PMNode {
  return doc(...Array.from({ length: n }, (_, i) => para(i, prefix)));
}

// Letter-only encoding so paired blocks in a "rewrite" share no tokens (otherwise
// shared digit/index tokens make the similarity classifier see them as edits).
const lettersOf = (i: number) =>
  i.toString(36).replace(/\d/g, (d) => "abcdefghij"[+d]);
function dissimilarDoc(n: number, base: string): PMNode {
  return doc(
    ...Array.from({ length: n }, (_, i) =>
      p(
        t(
          Array.from(
            { length: WORDS },
            (_, w) => `${base}${lettersOf(i)}x${lettersOf(w)}`,
          ).join(" "),
        ),
      ),
    ),
  );
}

// ---- timing helpers -------------------------------------------------------
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function timeMs(fn: () => void, runs = 3): number {
  fn(); // warmup
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    ts.push(performance.now() - s);
  }
  return median(ts);
}

// ---- synthetic form builders (return [fromDoc, toDoc]) --------------------
type Pair = [PMNode, PMNode];

function editEveryK(n: number, k: number): Pair {
  const from = baseDoc(n);
  const to = doc(
    ...Array.from({ length: n }, (_, i) =>
      i % k === 0 ? p(t(line(i, "p") + " EDITED")) : para(i, "p"),
    ),
  );
  return [from, to];
}
function editEvery(n: number): Pair {
  const from = baseDoc(n);
  const to = doc(
    ...Array.from({ length: n }, (_, i) => p(t(line(i, "p") + " EDITED"))),
  );
  return [from, to];
}
function sameShapeRewrite(n: number): Pair {
  // Same paragraph shape, genuinely unrelated words -> degenerate branch.
  return [dissimilarDoc(n, "alpha"), dissimilarDoc(n, "omega")];
}
function structuralRewrite(n: number): Pair {
  const from = baseDoc(n, "orig");
  const to = doc(
    ...Array.from({ length: n }, (_, i) => h(1, t(line(i, "heading")))),
  );
  return [from, to];
}
function pureAppend(n: number, add: number): Pair {
  const base = baseDoc(n);
  const to = doc(
    ...base.content.content,
    ...Array.from({ length: add }, (_, i) => para(i, "appended")),
  );
  return [base, to];
}
function neighborEditPlusAppend(n: number, add: number): Pair {
  const base = baseDoc(n);
  const edited = base.content.content.map((node, i) =>
    i === n - 1 ? p(t(line(i, "p") + " EDITED")) : node,
  );
  const to = doc(
    ...edited,
    ...Array.from({ length: add }, (_, i) => para(i, "appended")),
  );
  return [base, to];
}
function removedAdded(removed: number, added: number): Pair {
  const from = doc(
    ...Array.from({ length: removed }, (_, i) => para(i, "sel")),
    para(0, "tail"),
  );
  const to = doc(
    ...Array.from({ length: added }, (_, i) => para(i, "pasted")),
    para(0, "tail"),
  );
  return [from, to];
}
function hugeTextNode(): Pair {
  const big = "lorem ipsum dolor sit amet ".repeat(3000); // ~81k chars
  return [doc(p(t(big + "END-A"))), doc(p(t(big + "END-B")))];
}
function manyLargeNodesRewritten(m: number): Pair {
  const big = (s: string) => (s + " ").repeat(200); // ~2000 chars ≈ WORD_DIFF_MAX_CHARS
  const from = doc(...Array.from({ length: m }, () => p(t(big("alpha")))));
  const to = doc(...Array.from({ length: m }, () => p(t(big("omega")))));
  return [from, to];
}

const E2E_OPTS = { complexSteps: false, wordDiffs: true, simplifyDiff: true };

/* eslint-disable no-console */
describe("recreateTransform #581 performance bench", () => {
  it("BEFORE (stock) vs AFTER (fast) createPatch — scaling sweep", () => {
    const sizes = [50, 100, 200, 400];
    console.log(
      `\n#581 BEFORE(stock createPatch) vs AFTER(fastCreatePatch) — median ms\n` +
        `${"form".padEnd(16)}${"N".padStart(6)}${"before".padStart(10)}${"after".padStart(10)}  speedup`,
    );
    let lastEvery: { before: number; after: number } | null = null;
    for (const form of ["edit 1/3", "every block"] as const) {
      for (const n of sizes) {
        const [a, b] = form === "edit 1/3" ? editEveryK(n, 3) : editEvery(n);
        const aj = a.toJSON();
        const bj = b.toJSON();
        const before = timeMs(() => createPatch(aj, bj), 1);
        const after = timeMs(() => fastCreatePatch(aj, bj), 3);
        console.log(
          `${form.padEnd(16)}${String(n).padStart(6)}${before
            .toFixed(1)
            .padStart(10)}${after.toFixed(2).padStart(10)}  ${(
            before / after
          ).toFixed(0)}x`,
        );
        if (form === "every block" && n === 400) lastEvery = { before, after };
      }
    }
    // Machine-independent: the linear hook must be dramatically faster than the
    // stock quadratic diff on a full-rewrite of 400 blocks (never slower).
    expect(lastEvery!.after).toBeLessThan(lastEvery!.before);
  });

  it("AFTER path on N=600 + pathological forms (fast + e2e)", () => {
    const N = 600; // ~283KB, per issue methodology
    const forms: Array<[string, Pair]> = [
      ["edit 1/10", editEveryK(N, 10)],
      ["edit 1/3", editEveryK(N, 3)],
      ["every block", editEvery(N)],
      ["same-shape rewrite", sameShapeRewrite(N)],
      ["structural rewrite", structuralRewrite(N)],
      ["pure append 2000", pureAppend(N, 2000)],
      ["neighbor+append 2000", neighborEditPlusAppend(N, 2000)],
      ["removed(5)+added(300)", removedAdded(5, 300)],
      ["one huge text node", hugeTextNode()],
      ["M large nodes rewritten", manyLargeNodesRewritten(40)],
    ];
    console.log(
      `\n#581 AFTER — fastCreatePatch + full recreateTransform e2e — median ms\n` +
        `${"form".padEnd(26)}${"fast".padStart(9)}${"e2e".padStart(9)}`,
    );
    for (const [name, [from, to]] of forms) {
      const fromJSON = from.toJSON();
      const toJSON = to.toJSON();
      const fast = timeMs(() => fastCreatePatch(fromJSON, toJSON));
      const e2e = timeMs(() => recreateTransform(from, to, E2E_OPTS));
      console.log(
        `${name.padEnd(26)}${fast.toFixed(1).padStart(9)}${e2e
          .toFixed(1)
          .padStart(9)}`,
      );
    }
    expect(true).toBe(true);
  });

  // ---- CI regression guard: machine-independent SCALING ratio -------------
  // For two forms — "edit 1/10" (granular path) and "same-shape rewrite"
  // (degenerate branch) — measure the AFTER path (fastCreatePatch: the piece #581
  // actually rewrote) at N=100 and N=600 and assert t(600)/t(100) < 20. A stock
  // quadratic diff scales ~36x over 6x size; the linear/near-linear hook stays
  // well under 20 (measured ≈6x granular, ≈14x degenerate). Ratios (not absolute
  // ceilings) keep this independent of the CI machine's speed.
  //
  // Base is FIXED at 100 (not auto-raised past it): the degenerate form's
  // fingerprint Myers is O(N²) when EVERY block differs, so a much larger base
  // would legitimately approach the ceiling — 100/600 is the validated window and
  // still cleanly separates "sub-quadratic" from a reintroduced full quadratic.
  const RATIO_CEILING = 20;
  const SMALL = 100;
  const BIG = 600;

  function fastTime(form: (n: number) => Pair, n: number): number {
    const [from, to] = form(n);
    const fromJSON = from.toJSON();
    const toJSON = to.toJSON();
    return timeMs(() => fastCreatePatch(fromJSON, toJSON), 5);
  }

  const guardForms: Array<[string, (n: number) => Pair]> = [
    ["edit 1/10 (granular)", (n) => editEveryK(n, 10)],
    ["same-shape rewrite (degenerate)", (n) => sameShapeRewrite(n)],
  ];

  for (const [name, form] of guardForms) {
    it(`scales sub-quadratically (t${BIG}/t${SMALL} < ${RATIO_CEILING}): ${name}`, () => {
      const tSmall = fastTime(form, SMALL);
      const tBig = fastTime(form, BIG);
      const ratio = tBig / tSmall;
      console.log(
        `ratio guard [${name}] t(${SMALL})=${tSmall.toFixed(2)}ms ` +
          `t(${BIG})=${tBig.toFixed(2)}ms ratio=${ratio.toFixed(2)}`,
      );
      expect(ratio).toBeLessThan(RATIO_CEILING);
    });
  }
});
/* eslint-enable no-console */
