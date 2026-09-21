import { describe, it, expect } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { recreateTransform } from "./recreateTransform";
import { fastCreatePatch } from "./fastCreatePatch";

/**
 * recreateTransform diffs two documents and produces ProseMirror steps that turn
 * `fromDoc` into `toDoc`. It is the backbone of collaborative/version diffing, so
 * THE invariant that matters is: replaying the produced steps on `fromDoc` must
 * reproduce `toDoc` exactly. Every test below re-applies the steps onto a fresh
 * Transform seeded from `fromDoc` (not just trusting `tr.doc`) and asserts node
 * equality with `.eq()`. If a regression makes any step wrong, the round-trip
 * breaks and the test fails.
 */

// Real ProseMirror schema (the standard basic schema) with paragraph/heading +
// strong/em marks — the same primitives the editor diffs in production.
const doc = (...c: PMNode[]) => schema.node("doc", null, c);
const p = (...c: PMNode[]) =>
  schema.node("paragraph", null, c.length ? c : undefined);
const h = (level: number, ...c: PMNode[]) =>
  schema.node("heading", { level }, c);
const t = (text: string, ...marks: any[]) =>
  schema.text(text, marks.length ? marks : undefined);
const strong = schema.marks.strong.create();
const em = schema.marks.em.create();

// Replay the diff's steps onto a fresh Transform built from `fromDoc`. This is
// the faithful "apply(diff) == target" check — it exercises the actual Step
// objects rather than the transform's internal accumulated doc.
function applyDiff(fromDoc: PMNode, toDoc: PMNode, options?: any): PMNode {
  const tr = recreateTransform(fromDoc, toDoc, options);
  const replay = new Transform(fromDoc);
  tr.steps.forEach((s) => {
    const result = replay.maybeStep(s);
    if (result.failed) throw new Error(`step failed: ${result.failed}`);
  });
  return replay.doc;
}

describe("recreateTransform round-trip (apply(diff) == target)", () => {
  it("reconstructs the target on plain text insertion", () => {
    // Inserting " world" must yield exactly the target paragraph.
    const from = doc(p(t("hello")));
    const to = doc(p(t("hello world")));
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("reconstructs the target on text deletion", () => {
    // Deleting a trailing word is the inverse of insertion and must round-trip.
    const from = doc(p(t("hello world")));
    const to = doc(p(t("hello")));
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("reconstructs the target when a word is replaced mid-string", () => {
    // A char-level replace in the middle must not corrupt the surrounding text.
    const from = doc(p(t("the quick brown fox")));
    const to = doc(p(t("the slow brown fox")));
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("reconstructs the target when a mark is added (complexSteps path)", () => {
    // Mark-only changes are diffed in a separate pass; the bolded run must match.
    const from = doc(p(t("hello")));
    const to = doc(p(t("hello", strong)));
    const out = applyDiff(from, to);
    expect(out.eq(to)).toBe(true);
    // Sanity: the produced doc actually carries the strong mark.
    expect(out.firstChild!.firstChild!.marks.length).toBe(1);
  });

  it("reconstructs the target when a mark is removed", () => {
    // Removing the only mark must leave the same text with no marks.
    const from = doc(p(t("hello", strong)));
    const to = doc(p(t("hello")));
    const out = applyDiff(from, to);
    expect(out.eq(to)).toBe(true);
    expect(out.firstChild!.firstChild!.marks.length).toBe(0);
  });

  it("reconstructs the target on a paragraph split into two blocks", () => {
    // Structural change (one block -> two) must replay as valid replace steps.
    const from = doc(p(t("hello world")));
    const to = doc(p(t("hello")), p(t("world")));
    const out = applyDiff(from, to);
    expect(out.eq(to)).toBe(true);
    expect(out.childCount).toBe(2);
  });

  it("reconstructs the target on a node-type change (paragraph -> heading)", () => {
    // Type/attrs changes drive the setNodeMarkup branch; the node must become a
    // heading while keeping its text.
    const from = doc(p(t("hello")));
    const to = doc(h(1, t("hello")));
    const out = applyDiff(from, to);
    expect(out.eq(to)).toBe(true);
    expect(out.firstChild!.type.name).toBe("heading");
  });

  it("reconstructs a combined structural + mark change", () => {
    // Several diff kinds at once (new block + italic run) still round-trips.
    const from = doc(p(t("alpha")));
    const to = doc(p(t("alpha")), p(t("beta", em)));
    const out = applyDiff(from, to);
    expect(out.eq(to)).toBe(true);
  });

  it("produces an empty step list for identical documents", () => {
    // No diff => no work; spurious steps would mean wasted/incorrect history.
    const from = doc(p(t("same")));
    const to = doc(p(t("same")));
    const tr = recreateTransform(from, to);
    expect(tr.steps.length).toBe(0);
    expect(tr.doc.eq(to)).toBe(true);
  });

  it("round-trips with complexSteps:false (marks diffed as replaces)", () => {
    // With complexSteps off, mark changes are folded into replace steps rather
    // than dedicated mark steps — the result must still equal the target.
    const from = doc(p(t("hello")));
    const to = doc(p(t("hello", strong)));
    expect(applyDiff(from, to, { complexSteps: false }).eq(to)).toBe(true);
  });

  it("round-trips with wordDiffs:true (whole-word text diffing)", () => {
    // wordDiffs changes the granularity of the text diff, not the outcome.
    const from = doc(p(t("the quick brown fox")));
    const to = doc(p(t("the quick red fox")));
    expect(applyDiff(from, to, { wordDiffs: true }).eq(to)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #581 — fastCreatePatch (linear array diff) round-trip coverage. Same
// `applyDiff` invariant: replaying the produced steps on `fromDoc` must exactly
// reproduce `toDoc`. These exercise every branch of the new array-diff hook
// (granular pairing, cross-type type-guard, degenerate whole-array rewrite,
// coarse snapshot runs) plus the word-diff cap.
// ---------------------------------------------------------------------------

// A blockquote wrapping paragraphs — the nested content array exercises recursion
// into a sub-array (schema-basic has no bullet_list).
const bq = (...c: PMNode[]) => schema.node("blockquote", null, c);
// hard_break is a leaf inline node of a DIFFERENT type than text — used to force a
// cross-type positional pair (the type-guard path).
const br = () => schema.node("hard_break");

// Build a doc of `n` paragraphs, each `words` words of the given prefix.
function manyParas(n: number, prefix: string, words = 6): PMNode {
  const blocks: PMNode[] = [];
  for (let i = 0; i < n; i++) {
    const line = Array.from({ length: words }, (_, w) => `${prefix}${i}w${w}`).join(
      " ",
    );
    blocks.push(p(t(line)));
  }
  return doc(...blocks);
}

// Letter-only encoding of a number so block tokens never share digit tokens.
const lettersOf = (i: number) =>
  i.toString(36).replace(/\d/g, (d) => "abcdefghij"[+d]);
// Build `n` paragraphs whose tokens ALL start with `base` and share NOTHING with
// a different-`base` build — used to genuinely trip the degenerate (rewrite)
// branch (token overlap ~0 between paired blocks).
function rewriteParas(n: number, base: string, words = 6): PMNode {
  return doc(
    ...Array.from({ length: n }, (_, i) =>
      p(
        t(
          Array.from(
            { length: words },
            (_, w) => `${base}${lettersOf(i)}x${lettersOf(w)}`,
          ).join(" "),
        ),
      ),
    ),
  );
}

describe("recreateTransform #581 fast array-diff round-trip", () => {
  it("(a) edits scattered across many blocks", () => {
    const from = manyParas(40, "base");
    const toBlocks: PMNode[] = [];
    for (let i = 0; i < 40; i++) {
      // Edit roughly every 4th block; keep the rest identical.
      toBlocks.push(i % 4 === 0 ? p(t(`edited block number ${i} now`)) : p(t(
        Array.from({ length: 6 }, (_, w) => `base${i}w${w}`).join(" "),
      )));
    }
    const to = doc(...toBlocks);
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(b) edit + insert + delete blocks in one diff", () => {
    const from = doc(p(t("keep one")), p(t("delete me")), p(t("edit me")), p(t("keep two")));
    const to = doc(
      p(t("keep one")),
      p(t("edit me now")),
      p(t("inserted A")),
      p(t("inserted B")),
      p(t("keep two")),
    );
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(c) block reorder", () => {
    const from = doc(p(t("alpha")), p(t("beta")), p(t("gamma")), p(t("delta")));
    const to = doc(p(t("delta")), p(t("beta")), p(t("gamma")), p(t("alpha")));
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(d) same-shape full rewrite of >DEGENERATE_MIN_LEN blocks (degenerate branch)", () => {
    // Dissimilar content on both sides ⇒ token overlap ~0 ⇒ degenerate branch
    // fires (one whole-array replace). Must still round-trip exactly.
    const from = rewriteParas(60, "alpha");
    const to = rewriteParas(60, "omega");
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(e) empty -> full and full -> empty", () => {
    const empty = doc(p());
    const full = manyParas(30, "content");
    expect(applyDiff(empty, full).eq(full)).toBe(true);
    expect(applyDiff(full, empty).eq(empty)).toBe(true);
  });

  it("(f) edit in a nested array (blockquote with paragraphs)", () => {
    const from = doc(bq(p(t("first quoted")), p(t("second quoted")), p(t("third quoted"))));
    const to = doc(bq(p(t("first quoted")), p(t("second quoted EDITED")), p(t("third quoted"))));
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(g) several identical blocks, edit one", () => {
    const same = () => p(t("identical line here"));
    const from = doc(same(), same(), same(), same(), same());
    const to = doc(same(), same(), p(t("identical line CHANGED")), same(), same());
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(h) merge differently-marked runs via hard_break (cross-type pair, type-guard)", () => {
    // Position within the paragraph content array flips between a text node and a
    // hard_break node — a cross-type positional pair that must NOT recurse.
    const from = doc(p(t("line one"), br(), t("line two")));
    const to = doc(p(t("line one"), t(" and "), t("line two")));
    expect(applyDiff(from, to).eq(to)).toBe(true);
    const back = doc(p(t("line one"), br(), t("line two")));
    expect(applyDiff(to, back).eq(back)).toBe(true);
  });

  it("(i) pure append >RUN_COARSE_MIN blocks, and prepend+append with preserved middle", () => {
    const base = manyParas(20, "middle");
    // Append 150 (> RUN_COARSE_MIN=100) new blocks — coarse snapshot path.
    const appended = doc(
      ...base.content.content,
      ...Array.from({ length: 150 }, (_, i) => p(t(`appended ${i}`))),
    );
    expect(applyDiff(base, appended).eq(appended)).toBe(true);

    // Prepend + append with an untouched middle.
    const wrapped = doc(
      ...Array.from({ length: 120 }, (_, i) => p(t(`pre ${i}`))),
      ...base.content.content,
      ...Array.from({ length: 120 }, (_, i) => p(t(`post ${i}`))),
    );
    expect(applyDiff(base, wrapped).eq(wrapped)).toBe(true);
  });

  it("(j) uniform text expansion of every block", () => {
    const n = 40;
    const from = doc(
      ...Array.from({ length: n }, (_, i) => p(t(`block ${i} short`))),
    );
    const to = doc(
      ...Array.from({ length: n }, (_, i) =>
        p(t(`block ${i} short with several additional trailing words appended here`)),
      ),
    );
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(k) edits BEFORE + insert >RUN_COARSE_MIN blocks in middle + edits AFTER", () => {
    const before = Array.from({ length: 10 }, (_, i) => p(t(`before ${i} original`)));
    const after = Array.from({ length: 10 }, (_, i) => p(t(`after ${i} original`)));
    const from = doc(...before, ...after);

    const beforeEdited = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? p(t(`before ${i} EDITED`)) : p(t(`before ${i} original`)),
    );
    const inserted = Array.from({ length: 130 }, (_, i) => p(t(`inserted middle ${i}`)));
    const afterEdited = Array.from({ length: 10 }, (_, i) =>
      i % 3 === 0 ? p(t(`after ${i} EDITED`)) : p(t(`after ${i} original`)),
    );
    const to = doc(...beforeEdited, ...inserted, ...afterEdited);
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("(l) adjacent removed(5) + added(300)", () => {
    const head = Array.from({ length: 5 }, (_, i) => p(t(`selection ${i}`)));
    const tail = [p(t("tail kept"))];
    const from = doc(...head, ...tail);
    const pasted = Array.from({ length: 300 }, (_, i) => p(t(`pasted chunk ${i}`)));
    const to = doc(...pasted, ...tail);
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("word-diff cap: huge single text node still round-trips (whole-text replace)", () => {
    // > WORD_DIFF_HARD_MAX_CHARS combined => whole-text replace branch.
    const big = "lorem ipsum ".repeat(2000); // ~24k chars
    const from = doc(p(t(big + "END-A")));
    const to = doc(p(t(big + "END-B")));
    expect(applyDiff(from, to).eq(to)).toBe(true);
  });

  it("degenerate branch emits a single whole-array replace op", () => {
    // Pin the branch: a dissimilar >DEGENERATE_MIN_LEN rewrite must collapse the
    // /content array diff to ONE replace op (not per-block edits).
    const from = rewriteParas(60, "alpha").toJSON();
    const to = rewriteParas(60, "omega").toJSON();
    const ops = fastCreatePatch(from, to);
    const contentReplaces = ops.filter(
      (o: any) => o.op === "replace" && o.path === "/content",
    );
    expect(contentReplaces.length).toBe(1);
    expect((contentReplaces[0] as any).value).toEqual(to.content);
  });

  it("coarse added run emits a whole-array snapshot, not per-element adds", () => {
    // Appending >RUN_COARSE_MIN blocks must NOT emit hundreds of element-wise
    // add ops (that would hand the consumer back its quadratic loop).
    const base = manyParas(10, "keep");
    const to = doc(
      ...base.content.content,
      ...Array.from({ length: 150 }, (_, i) => p(t(`appended ${i}`))),
    );
    const ops = fastCreatePatch(base.toJSON(), to.toJSON());
    const adds = ops.filter((o: any) => o.op === "add");
    expect(adds.length).toBe(0);
    expect(
      ops.some((o: any) => o.op === "replace" && o.path === "/content"),
    ).toBe(true);
  });

  it("word-diff cap: mid-range budgeted diff still round-trips", () => {
    // Between WORD_DIFF_MAX_CHARS and HARD: budgeted diff (or fallback) must be exact.
    const mid = "word ".repeat(700); // ~3.5k chars
    const from = doc(p(t(mid + "alpha")));
    const to = doc(p(t("prefix change " + mid + "omega")));
    expect(applyDiff(from, to, { wordDiffs: true }).eq(to)).toBe(true);
  });
});
