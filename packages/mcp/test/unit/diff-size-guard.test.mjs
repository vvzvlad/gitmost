// Issue #464 — prod CPU-DoS pre-flight size guard for diffDocs; recalibrated in
// #582 for the fixed editor-ext recreateTransform (defaults: 200 nodes / 4 KiB).
//
// diffDocs synchronously runs recreateTransform + ChangeSet.addSteps; on a large,
// heavily-changed doc that pins the event loop for seconds WITHOUT throwing. A
// pre-flight size guard routes any doc over MCP_DIFF_MAX_NODES /
// MCP_DIFF_MAX_BYTES straight to the coarse fallback (`fellBack:true`).
//
// THE BUDGET CLAIM, STATED HONESTLY. The caps exist so that every ADMITTED pair
// completes inside a ~200ms synchronous block. That is a claim about the docs the
// guard LETS THROUGH, and #582 found it was false: the previous 12 KiB byte cap
// admitted byte-heavy pairs costing 300-660ms, because the dominant cost sits in
// ChangeSet.addSteps (which #581 did not touch), not in recreateTransform. The byte
// cap is now 4 KiB, the largest value under which the worst admitted shape measured
// inside the budget. The tests below therefore pin BOTH sides of the cap:
//   - "the worst ADMISSIBLE byte-heavy pair stays inside the budget" (the dangerous
//     zone: under the byte cap but expensive), and
//   - "a pair just over the byte cap falls back" (deterministically, in ~1ms).
// The budget test is non-vacuous: restoring the old 12 KiB cap makes it FAIL.
//
// These tests assert the BEHAVIOR of the guard (budget + fast + coarse-mode +
// asymmetry + env knobs). A sibling test (diff-guard-skips-recreate.test.mjs) proves
// recreateTransform is skipped over the cap via a behavioral proxy (guarded run
// is orders of magnitude faster than the same pair with the caps raised).
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDocs } from "../../build/lib/diff.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const t = (text) => ({ type: "text", text });
const para = (text) => ({ type: "paragraph", content: text ? [t(text)] : [] });
const doc = (children) => ({ type: "doc", content: children });

/** A doc of `n` paragraphs whose words are seeded from `seed` (fully changeable). */
function buildDoc(n, wordsPerPara, seed) {
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const words = [];
    for (let w = 0; w < wordsPerPara; w++) words.push(`${seed}${i}_${w}`);
    blocks.push(para(words.join(" ")));
  }
  return doc(blocks);
}

/** Reset the env knobs to their unset default between tests. */
function clearEnv() {
  delete process.env.MCP_DIFF_MAX_NODES;
  delete process.env.MCP_DIFF_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Over-threshold (by node count) -> FAST + coarse mode.
// A fully re-written 600-para doc is the worst case that drove the incident;
// with the guard it must return in well under the ~200ms budget and in coarse
// mode. Without the guard this single call takes multiple SECONDS.
// ---------------------------------------------------------------------------
test("over-threshold doc falls back to coarse mode and returns fast", () => {
  clearEnv();
  // 600 paragraphs -> ~1200 nodes, far over the 200-node default.
  const oldDoc = buildDoc(600, 8, "a");
  const newDoc = buildDoc(600, 8, "b");

  const start = performance.now();
  const r = diffDocs(oldDoc, newDoc);
  const elapsed = performance.now() - start;

  // Coarse mode is signalled in the markdown note (fellBack path).
  assert.match(
    r.markdown,
    /coarse block-level diff/,
    "over-threshold pair must use the coarse fallback",
  );
  // Budget: the guard makes this near-instant. Generous 1s ceiling to avoid CI
  // flake while still being ~10x under the multi-second un-guarded cost.
  assert.ok(
    elapsed < 1000,
    `expected fast coarse fallback, took ${elapsed.toFixed(0)}ms`,
  );
  // Coarse diff still detects the wholesale change.
  assert.ok(r.summary.inserted > 0 || r.summary.deleted > 0, "reports changes");
});

// ---------------------------------------------------------------------------
// Under-threshold (small) doc -> precise diff, NOT coarse mode. No regression.
// ---------------------------------------------------------------------------
test("under-threshold doc uses the precise diff (no fallback note)", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);
  const r = diffDocs(oldDoc, newDoc);

  assert.doesNotMatch(
    r.markdown,
    /coarse block-level diff/,
    "a small doc must take the precise path",
  );
  // Precise word diff finds exactly the inserted word.
  const ins = r.changes.find((c) => c.op === "insert");
  assert.ok(ins && /brave/.test(ins.text), "precise diff isolates the inserted word");
});

// ---------------------------------------------------------------------------
// Asymmetry: a small NEW doc vs a huge OLD doc (and vice versa) still explodes
// rfc6902, so max(old,new) must trip the guard in BOTH directions.
// ---------------------------------------------------------------------------
test("asymmetric pair (huge old, tiny new) falls back to coarse", () => {
  clearEnv();
  const hugeOld = buildDoc(600, 8, "a");
  const tinyNew = doc([para("just one line")]);
  const r = diffDocs(hugeOld, tinyNew);
  assert.match(r.markdown, /coarse block-level diff/, "huge-old side must trip the guard");
});

test("asymmetric pair (tiny old, huge new) falls back to coarse", () => {
  clearEnv();
  const tinyOld = doc([para("just one line")]);
  const hugeNew = buildDoc(600, 8, "b");
  const r = diffDocs(tinyOld, hugeNew);
  assert.match(r.markdown, /coarse block-level diff/, "huge-new side must trip the guard");
});

// ---------------------------------------------------------------------------
// Byte axis: a FEW nodes but a very large serialized size (long text runs) is
// dangerous too (per-run word diff is O(words²)), so the byte cap must trip
// independently of the node count.
// ---------------------------------------------------------------------------
test("node-light but byte-heavy doc falls back on the byte cap", () => {
  clearEnv();
  // 5 paragraphs (~11 nodes, well under the node cap) but each a very long run,
  // pushing the serialized size far over the 4 KiB byte default.
  const bigRun = (seed) =>
    doc(
      Array.from({ length: 5 }, (_, i) =>
        para(Array.from({ length: 800 }, (_, w) => `${seed}${i}_${w}`).join(" ")),
      ),
    );
  const oldDoc = bigRun("a");
  const newDoc = bigRun("b");
  // Sanity: node count is under the default node cap, so ONLY the byte cap can
  // be what trips the guard here.
  const nodeCount = (d) => {
    let n = 0;
    const v = (x) => {
      if (!x || typeof x !== "object") return;
      n++;
      if (Array.isArray(x.content)) for (const c of x.content) v(c);
    };
    v(d);
    return n;
  };
  assert.ok(nodeCount(oldDoc) < 200, "node count is under the node cap");
  assert.ok(JSON.stringify(oldDoc).length > 4 * 1024, "serialized size is over the byte cap");

  const r = diffDocs(oldDoc, newDoc);
  assert.match(r.markdown, /coarse block-level diff/, "byte cap must trip independently");
});

// ---------------------------------------------------------------------------
// Env override: a very low MCP_DIFF_MAX_NODES forces fallback on a tiny doc,
// proving the knob is read fresh and actually gates the diff.
// ---------------------------------------------------------------------------
test("MCP_DIFF_MAX_NODES override forces fallback on a small doc", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);

  // Baseline: default caps -> precise diff.
  assert.doesNotMatch(diffDocs(oldDoc, newDoc).markdown, /coarse block-level diff/);

  // Knob set absurdly low -> even this 4-node doc trips the guard.
  process.env.MCP_DIFF_MAX_NODES = "1";
  try {
    const r = diffDocs(oldDoc, newDoc);
    assert.match(r.markdown, /coarse block-level diff/, "low node cap forces fallback");
  } finally {
    clearEnv();
  }
});

test("MCP_DIFF_MAX_BYTES override forces fallback on a small doc", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);

  process.env.MCP_DIFF_MAX_BYTES = "1";
  try {
    const r = diffDocs(oldDoc, newDoc);
    assert.match(r.markdown, /coarse block-level diff/, "low byte cap forces fallback");
  } finally {
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// Garbage / unset env values fall back to the DEFAULT (the guard can never be
// accidentally disabled by a malformed knob). A small doc must still diff
// precisely under a garbage cap.
// ---------------------------------------------------------------------------
test("garbage env values fall back to the default cap (guard not disabled)", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);

  for (const bad of ["not-a-number", "0", "-5", "", "NaN", "1e999"]) {
    process.env.MCP_DIFF_MAX_NODES = bad;
    process.env.MCP_DIFF_MAX_BYTES = bad;
    // Under the DEFAULT caps this small doc is precise (garbage did not raise
    // OR disable the cap). "1e999" -> parseInt yields 1 (finite) which is a
    // valid low cap and would fall back; exclude that from the precise check.
    const r = diffDocs(oldDoc, newDoc);
    if (bad === "1e999") {
      // parseInt("1e999",10) === 1 -> a legit low cap -> fallback. Guard active.
      assert.match(r.markdown, /coarse block-level diff/);
    } else {
      assert.doesNotMatch(
        r.markdown,
        /coarse block-level diff/,
        `garbage value ${JSON.stringify(bad)} must fall back to the default cap`,
      );
    }
  }
  clearEnv();
});

// ---------------------------------------------------------------------------
// A large doc that trips the guard must still return the correct INTEGRITY
// counts (computeIntegrity runs before the diff and is unaffected by fallback).
// ---------------------------------------------------------------------------
test("integrity counts are still correct on a guard-tripped (coarse) doc", () => {
  clearEnv();
  const image = { type: "image", attrs: { src: "/api/files/a.png" } };
  const oldDoc = doc([image, ...buildDoc(600, 8, "a").content]);
  const newDoc = doc([...buildDoc(600, 8, "b").content]); // image removed

  const r = diffDocs(oldDoc, newDoc);
  assert.match(r.markdown, /coarse block-level diff/, "large pair fell back");
  assert.deepEqual(r.integrity.images, [1, 0], "integrity is computed regardless of fallback");
});

// ---------------------------------------------------------------------------
// #582 NODE CAP (150 -> 200) — and the honest statement of what it buys.
//
// Under the DEFAULT byte cap (4 KiB) the node cap is SUBSUMED: it can never trip.
// A text block costs ~55 B of JSON, so only ~68 of them (~137 nodes) fit under
// 4 KiB; even the cheapest possible node (an EMPTY paragraph, ~21 B) only gets
// ~190 nodes in. The byte cap always refuses first. So the 150 -> 200 raise admits
// nothing new for prose — the node cap survives purely as defence-in-depth, and it
// becomes live only when an operator RAISES MCP_DIFF_MAX_BYTES.
//
// These two tests pin exactly that, rather than the (false) claim that bigger pages
// now get precise diffs:
//   1. subsumption — a 201-node doc cannot be built under the byte cap at all;
//   2. the node cap still works in the regime where it IS reachable (byte cap
//      raised), including the 150 -> 200 window.
// ---------------------------------------------------------------------------
function nodeCount(d) {
  let n = 0;
  const v = (x) => {
    if (!x || typeof x !== "object") return;
    n++;
    if (Array.isArray(x.content)) for (const c of x.content) v(c);
  };
  v(d);
  return n;
}

test("the node cap is subsumed by the byte cap at the default settings", () => {
  clearEnv();
  // The CHEAPEST node there is: an empty paragraph (~21 B of JSON, no text child).
  // Even 200 of them do not fit under the 4 KiB byte cap, so no document can ever
  // reach the 200-node cap while staying byte-admissible.
  const emptyParas = (n) => doc(Array.from({ length: n }, () => ({ type: "paragraph" })));
  const atNodeCap = emptyParas(200); // 201 nodes counting the doc node
  assert.ok(nodeCount(atNodeCap) > 200, "this doc is at/over the node cap");
  assert.ok(
    JSON.stringify(atNodeCap).length > 4 * 1024,
    "…yet it is ALREADY over the byte cap — the byte cap refuses it first, so the " +
      "node cap cannot be the thing that trips at default settings",
  );

  // And the realistic shape is far more byte-hungry: ~68 text blocks exhaust 4 KiB.
  const textBlocks = buildDoc(75, 1, "a"); // 151 nodes, over the OLD 150-node cap
  assert.ok(nodeCount(textBlocks) > 150, "over the old 150-node cap");
  assert.ok(
    JSON.stringify(textBlocks).length > 4 * 1024,
    "a doc in the 150→200 node window is already over the byte cap, so the raise " +
      "admits no prose that the old cap refused",
  );
});

test("the node cap still guards when the byte cap is raised (150→200 window)", () => {
  clearEnv();
  // Isolate the node axis: raise the byte knob so ONLY the node count can trip.
  process.env.MCP_DIFF_MAX_BYTES = "1000000";
  try {
    // 90 paragraphs -> 181 nodes: over the OLD 150-node cap, under the NEW 200.
    const oldDoc = buildDoc(90, 6, "a");
    const newDoc = JSON.parse(JSON.stringify(oldDoc));
    // A realistic agent edit: one word changed in two separate blocks.
    newDoc.content[10].content[0].text += " sentinelalpha";
    newDoc.content[70].content[0].text += " sentinelbeta";

    const nodes = Math.max(nodeCount(oldDoc), nodeCount(newDoc));
    assert.ok(nodes > 150, `pair must exceed the OLD 150-node cap (was ${nodes})`);
    assert.ok(nodes <= 200, `pair must be within the NEW 200-node cap (was ${nodes})`);

    // Control: with the OLD node cap restored, this SAME pair falls back — proof
    // that the 150→200 raise (not some unrelated change) is what admits it.
    process.env.MCP_DIFF_MAX_NODES = "150";
    assert.match(
      diffDocs(oldDoc, newDoc).markdown,
      /coarse block-level diff/,
      "under the OLD 150-node cap this pair fell back",
    );
    delete process.env.MCP_DIFF_MAX_NODES;

    const r = diffDocs(oldDoc, newDoc);
    assert.doesNotMatch(
      r.markdown,
      /coarse block-level diff/,
      "under the NEW 200-node cap the same pair takes the precise path",
    );
    // PRECISE: the change ranges are the two inserted words, not the whole blocks.
    const inserts = r.changes.filter((c) => c.op === "insert");
    assert.equal(inserts.length, 2, "exactly the two edited spots are reported");
    for (const ins of inserts) {
      assert.match(ins.text, /sentinel(alpha|beta)/, "insert is the edited word");
      assert.ok(
        ins.text.length < 20,
        `precise range, not a whole-block coarse chunk (got ${ins.text.length} chars)`,
      );
    }
    assert.equal(r.summary.deleted, 0, "nothing was deleted");

    // Past the node cap it still degrades, even with bytes unlimited.
    const bigOld = buildDoc(110, 4, "a"); // 221 nodes
    const bigNew = JSON.parse(JSON.stringify(bigOld));
    bigNew.content[5].content[0].text += " sentinelalpha";
    assert.ok(Math.max(nodeCount(bigOld), nodeCount(bigNew)) > 200, "over the node cap");
    assert.match(
      diffDocs(bigOld, bigNew).markdown,
      /coarse block-level diff/,
      "past the node cap the pair degrades to coarse",
    );
  } finally {
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// #582 THE DANGEROUS ZONE — a doc UNDER the byte cap can still be EXPENSIVE, and
// that is the only thing the byte cap is for. Nothing used to test it, which is how
// the 12 KiB cap shipped while admitting 300-660ms blocks under a "~200ms" comment.
//
// The adversarial worst case is text REWRITTEN wholesale with the SHORTEST possible
// unique tokens: ChangeSet.addSteps re-diffs the replaced range token by token, so
// at a fixed byte budget more tokens = more work (~40-60% worse than prose-length
// words). This is agent/user-authored content, so the attacker picks the density.
//
// NON-VACUITY: the second pair below sits just over the byte cap, so the guard
// refuses it in ~1ms. Restore the old cap (MCP_DIFF_MAX_BYTES=12288) and it is
// ADMITTED instead, costs 400-660ms, and this test FAILS. That is precisely the
// regression the tightened cap removes.
// ---------------------------------------------------------------------------

/** One paragraph packed with the shortest unique tokens, up to `budget` JSON bytes. */
function densePara(seed, budget) {
  let s = "";
  let w = 0;
  for (;;) {
    const next = `${seed}${(w).toString(36)} `;
    if (JSON.stringify(doc([para(s + next)])).length > budget) break;
    s += next;
    w++;
  }
  return doc([para(s)]);
}

/** Best-of-3, to shed GC/JIT noise the way the calibration bench does. */
function bestOf3(fn) {
  let best = Infinity;
  let out;
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    out = fn();
    best = Math.min(best, performance.now() - s);
  }
  return { out, ms: best };
}

// The stated budget is ~200ms. The worst ADMITTED shape measures ~136-186ms
// best-of-3 on a fast box, but a loaded CI runner has been observed at 311ms
// (develop run 29709045681) — so the admitted-path ceiling carries ~2x headroom
// over that observation, same convention as the drawio-layout bench loosening.
const ADMITTED_CEILING_MS = 600;
// The fallback ceiling stays TIGHT on purpose: the guarded (fallback) path costs
// ~1ms, while restoring the old 12 KiB byte cap re-admits pairs costing >=400ms
// even on a fast box — 300ms still separates the two decisively.
const FALLBACK_CEILING_MS = 300;

test("the worst ADMISSIBLE byte-heavy pair stays inside the budget", () => {
  clearEnv();
  // Just UNDER the 4 KiB byte cap, every token rewritten: the most expensive pair
  // the guard actually lets through.
  const oldDoc = densePara("a", 4 * 1024);
  const newDoc = densePara("b", 4 * 1024);

  // Non-vacuity #1: it really is ADMITTED (this is the dangerous zone, not a
  // fallback in disguise), and really is byte-bound rather than node-bound.
  const bytes = Math.max(
    JSON.stringify(oldDoc).length,
    JSON.stringify(newDoc).length,
  );
  assert.ok(bytes > 3 * 1024, `pair must sit near the byte cap (was ${bytes}B)`);
  assert.ok(bytes <= 4 * 1024, `pair must be UNDER the byte cap (was ${bytes}B)`);
  assert.ok(nodeCount(oldDoc) < 200, "only 3 nodes: the node cap is not in play");

  const { out, ms } = bestOf3(() => diffDocs(oldDoc, newDoc));
  assert.doesNotMatch(
    out.markdown,
    /coarse block-level diff/,
    "this pair is ADMITTED — the precise pipeline really did run",
  );
  assert.ok(out.summary.inserted > 0 && out.summary.deleted > 0, "it really diffed");
  assert.ok(
    ms < ADMITTED_CEILING_MS,
    `worst admissible byte-heavy pair must hold the ~200ms budget, took ${ms.toFixed(0)}ms`,
  );
});

test("a byte-heavy pair just OVER the cap falls back (and the old 12 KiB cap did not)", () => {
  clearEnv();
  // The shape the OLD 12 KiB cap admitted — and blocked the event loop for ~400-660ms.
  const oldDoc = densePara("a", 12 * 1024);
  const newDoc = densePara("b", 12 * 1024);
  const bytes = Math.max(
    JSON.stringify(oldDoc).length,
    JSON.stringify(newDoc).length,
  );
  assert.ok(bytes > 4 * 1024, `pair must exceed the NEW byte cap (was ${bytes}B)`);
  assert.ok(bytes <= 12 * 1024, `…while fitting the OLD 12 KiB cap (was ${bytes}B)`);
  assert.ok(nodeCount(oldDoc) < 200, "only 3 nodes: ONLY the byte cap can trip here");

  const { out, ms } = bestOf3(() => diffDocs(oldDoc, newDoc));
  assert.match(
    out.markdown,
    /coarse block-level diff/,
    "over the byte cap -> coarse fallback",
  );
  // This is the assertion that FAILS if MCP_DIFF_MAX_BYTES is restored to 12288:
  // the pair would then be admitted and cost >=400ms instead of ~1ms.
  assert.ok(
    ms < FALLBACK_CEILING_MS,
    `the guarded path must hold the budget, took ${ms.toFixed(0)}ms`,
  );
});

// ---------------------------------------------------------------------------
// The pathology that DRIVES the byte cap (#582): a SINGLE large text node rewritten
// wholesale is expensive in ChangeSet.addSteps (not in recreateTransform) — which is
// why the byte cap had to come DOWN to 4 KiB rather than up. Far past the cap the
// pair must fall back — deterministically and fast.
// ---------------------------------------------------------------------------
test("a single huge rewritten text node (byte-axis worst case) falls back fast", () => {
  clearEnv();
  const bigText = (seed) => {
    let s = "";
    let w = 0;
    while (s.length < 40_000) s += `${seed}${w++} `;
    return doc([para(s.slice(0, 40_000))]);
  };
  const oldDoc = bigText("a");
  const newDoc = bigText("b");
  assert.ok(nodeCount(oldDoc) < 200, "3 nodes: only the byte cap can trip here");

  const start = performance.now();
  const r = diffDocs(oldDoc, newDoc);
  const elapsed = performance.now() - start;

  assert.match(r.markdown, /coarse block-level diff/, "byte cap catches it");
  assert.ok(
    elapsed < 200,
    `the guarded path must stay inside the budget, took ${elapsed.toFixed(0)}ms`,
  );
});

// ---------------------------------------------------------------------------
// The other side of the byte axis: a big text node with a SMALL edit is cheap
// (recreateTransform emits one tiny step), but the guard is a pre-flight on SIZE
// and refuses it anyway. Pinned so the trade-off is explicit and any future
// change to it is a deliberate test edit, not an accident.
// ---------------------------------------------------------------------------
test("byte cap refuses a big-but-lightly-edited doc (documented trade-off)", () => {
  clearEnv();
  let s = "";
  let w = 0;
  while (s.length < 20_000) s += `word${w++} `;
  const oldDoc = doc([para(s)]);
  const newDoc = doc([para(s.replace("word5 ", "word5 sentinelalpha "))]);

  const r = diffDocs(oldDoc, newDoc);
  assert.match(
    r.markdown,
    /coarse block-level diff/,
    "over the byte cap -> coarse, even though this particular edit is cheap",
  );
});
