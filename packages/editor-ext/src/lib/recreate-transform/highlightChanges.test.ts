import { describe, it, expect } from "vitest";
import { schema } from "@tiptap/pm/schema-basic";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ChangeSet, simplifyChanges } from "@tiptap/pm/changeset";
import { recreateTransform } from "./recreateTransform";

/**
 * Issue #581 — highlight-SEMANTICS tests. These run the EXACT pipeline the client
 * history diff (apps/client/.../history-diff.ts) uses to turn two documents into
 * highlight decorations:
 *
 *   recreateTransform({complexSteps:false, wordDiffs:true, simplifyDiff:true})
 *   -> ChangeSet.create(old).addSteps(tr.doc, tr.mapping.maps, [])
 *   -> simplifyChanges(changeSet.changes, new)
 *
 * and then count added/deleted change regions the same way history-diff.ts does
 * (a region with toB>fromB is an "added", toA>fromA is a "deleted"). The point is
 * to prove the new linear array-diff produces the SAME user-visible highlighting
 * shape as the old quadratic diff — granular where the edits are granular, and one
 * aggregate block only on a genuine wholesale rewrite.
 */

const doc = (...c: PMNode[]) => schema.node("doc", null, c);
const p = (...c: PMNode[]) =>
  schema.node("paragraph", null, c.length ? c : undefined);
const t = (text: string) => schema.text(text);

// The client bails on very large change sets; mirror that guard so the tests
// reflect the real pipeline's behaviour on big docs.
const MAX_DIFF_SIZE = 5000;

function countChanges(oldDoc: PMNode, newDoc: PMNode) {
  const tr = recreateTransform(oldDoc, newDoc, {
    complexSteps: false,
    wordDiffs: true,
    simplifyDiff: true,
  });
  const changeSet = ChangeSet.create(oldDoc).addSteps(
    tr.doc,
    tr.mapping.maps,
    [],
  );
  const rawChanges = changeSet.changes;
  if (rawChanges.length > MAX_DIFF_SIZE) {
    return { added: -1, deleted: -1, total: -1, bailed: true };
  }
  const changes = simplifyChanges(rawChanges, newDoc);
  let added = 0;
  let deleted = 0;
  for (const c of changes) {
    if (c.toB > c.fromB) added++;
    if (c.toA > c.fromA) deleted++;
  }
  return { added, deleted, total: added + deleted, bailed: false };
}

describe("recreateTransform #581 highlight semantics", () => {
  it("find-replace in every block (600) stays granular, not one aggregate", () => {
    const n = 600;
    const from = doc(
      ...Array.from({ length: n }, (_, i) =>
        p(t(`block ${i} contains the word target and more filler words here`)),
      ),
    );
    const to = doc(
      ...Array.from({ length: n }, (_, i) =>
        p(t(`block ${i} contains the word replaced and more filler words here`)),
      ),
    );
    const { added, deleted } = countChanges(from, to);
    // Each block has one edited word -> hundreds of granular changes, not 1/1.
    expect(added).toBeGreaterThan(100);
    expect(deleted).toBeGreaterThan(100);
    // 600 blocks under wordDiffs took 5044ms on a loaded CI runner (vitest default
    // is 5000ms); generous timeout so CI variance never flakes it — same convention
    // as the property test (correctness, not speed, is the point here).
  }, 30000);

  it("uniform text expansion of every block adds text but deletes nothing", () => {
    const n = 80;
    const from = doc(
      ...Array.from({ length: n }, (_, i) => p(t(`block ${i} baseline`))),
    );
    const to = doc(
      ...Array.from({ length: n }, (_, i) =>
        p(t(`block ${i} baseline plus several extra appended words here`)),
      ),
    );
    const { added, deleted } = countChanges(from, to);
    expect(added).toBeGreaterThan(0);
    expect(deleted).toBe(0);
  });

  it("prepend + append leaves the preserved middle un-deleted", () => {
    const middle = Array.from({ length: 30 }, (_, i) => p(t(`middle ${i} preserved`)));
    const from = doc(...middle);
    const to = doc(
      ...Array.from({ length: 120 }, (_, i) => p(t(`prepended ${i}`))),
      ...middle,
      ...Array.from({ length: 120 }, (_, i) => p(t(`appended ${i}`))),
    );
    const { deleted } = countChanges(from, to);
    // Pure surrounding inserts: the untouched middle must NOT show as deleted.
    expect(deleted).toBe(0);
  });

  it("content-heavy prepend + append keeps the preserved middle un-deleted (pre-classifier guard)", () => {
    // Reproduces the #581 pre-classifier bug directly. Indices are encoded as
    // LETTERS so paragraphs carry only non-digit tokens (6 unique words each):
    // shared digit indices would let the similarity classifier read unrelated
    // blocks as "similar" and mask the bug. Each block is content-heavy so token
    // similarity cannot accidentally rescue the result either.
    const word = (n: number) =>
      n.toString(36).replace(/\d/g, (d) => "ghijklmnop"[+d]);
    const heavy = (prefix: string, i: number) =>
      p(
        t(
          Array.from(
            { length: 6 },
            (_, w) => `${prefix}${word(i)}${word(w)}zeta`,
          ).join(" "),
        ),
      );
    const middle = Array.from({ length: 20 }, (_, i) => heavy("mid", i));
    const from = doc(...middle);
    const to = doc(
      ...Array.from({ length: 120 }, (_, i) => heavy("pre", i)),
      ...middle,
      ...Array.from({ length: 120 }, (_, i) => heavy("post", i)),
    );
    // maxLen = 260, shared = 20 -> shared/maxLen ≈ 0.077 < DEGENERATE_COMMON_RATIO,
    // so the OLD pre-classifier (lacking the shared/min(N,M) guard) fired a single
    // whole-array replace and flagged the untouched middle as DELETED (deleted=1).
    // The guard (shared/min = 20/20 = 1.0, not < 0.1) now blocks it -> Myers ->
    // granular diff -> the preserved middle is NOT shown deleted.
    const { added, deleted, total } = countChanges(from, to);
    expect(deleted).toBe(0);
    // ...and the diff is granular (the 240 new blocks), not one whole-doc replace.
    expect(added).toBeGreaterThan(1);
    expect(total).toBeGreaterThan(1);
  });

  it("same-shape wholesale rewrite collapses to a single aggregate change", () => {
    const n = 60;
    const from = doc(
      ...Array.from({ length: n }, (_, i) =>
        p(t(`original alpha bravo charlie ${i} delta echo foxtrot`)),
      ),
    );
    const to = doc(
      ...Array.from({ length: n }, (_, i) =>
        p(t(`unrelated whiskey xray yankee ${i} zulu tango sierra`)),
      ),
    );
    const { total } = countChanges(from, to);
    // Degenerate branch -> one whole-array replace -> a single aggregate change
    // region (one deletion span + one insertion span), NOT ~120 per-block edits.
    expect(total).toBeLessThanOrEqual(4);
  });
});
