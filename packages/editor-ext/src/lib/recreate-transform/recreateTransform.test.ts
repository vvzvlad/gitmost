import { describe, it, expect } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { recreateTransform } from "./recreateTransform";

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
