import { describe, it, expect } from "vitest";
import { deriveFootnoteId } from "./footnote-util";

/**
 * GOLDEN TABLE for `deriveFootnoteId` (and its private alphabetic `suffix`).
 *
 * `deriveFootnoteId` lives ONLY in editor-ext now — it is used by
 * `resolveCollisions` (re-id of a duplicate definition) and `footnotePastePlugin`
 * (re-id of a pasted colliding definition). The MCP/marked import paths no longer
 * derive ids (duplicate definitions there are first-wins-dropped, #166), so there
 * is no cross-package copy and no parity test to keep in sync. This table pins the
 * deterministic scheme so a future change to it is a conscious one.
 */
export const DERIVE_GOLDEN: Array<{
  originalId: string;
  occurrence: number;
  taken: string[];
  expected: string;
  why: string;
}> = [
  // Base candidate `${id}__${occurrence}` when nothing collides.
  { originalId: "d", occurrence: 2, taken: [], expected: "d__2", why: "plain base, second occurrence" },
  { originalId: "d", occurrence: 3, taken: [], expected: "d__3", why: "plain base, third occurrence" },
  // The base is taken -> first alphabetic bump is "b" (NOT "a": suffix starts at 'b').
  { originalId: "d", occurrence: 2, taken: ["d__2"], expected: "d__2b", why: "base taken -> first bump 'b'" },
  // Base + first bump taken -> "c".
  { originalId: "d", occurrence: 2, taken: ["d__2", "d__2b"], expected: "d__2c", why: "base+b taken -> 'c'" },
  // A non-contiguous taken set still walks deterministically to the first free slot.
  {
    originalId: "d",
    occurrence: 2,
    taken: ["d__2", "d__2b", "d__2c", "d__2d"],
    expected: "d__2e",
    why: "base + b,c,d taken -> 'e'",
  },
  // >25 bump: base + b..z (the 25 single-letter suffixes) all taken -> "bb".
  // suffix(26) === "bb" (base-25 over b..z, carrying to a two-letter suffix).
  {
    originalId: "d",
    occurrence: 2,
    taken: ["d__2", ...singleLetterSuffixes().map((s) => `d__2${s}`)],
    expected: "d__2bb",
    why: ">25 collisions -> two-letter suffix 'bb'",
  },
];

/** The 25 single-letter suffixes the scheme uses: b, c, ..., z (n = 1..25). */
function singleLetterSuffixes(): string[] {
  // Mirror of the production suffix() for n in 1..25 (all single letters).
  // n=1 -> 'b' ... n=25 -> 'z'. Used only to BUILD the taken-set for the
  // >25 row; the EXPECTED value (d__2bb) is asserted against the real function.
  return Array.from({ length: 25 }, (_, i) => String.fromCharCode(98 + i));
}

describe("deriveFootnoteId golden table (cross-package drift guard)", () => {
  for (const row of DERIVE_GOLDEN) {
    it(`derive("${row.originalId}", ${row.occurrence}, {${row.taken.join(",")}}) === "${row.expected}" — ${row.why}`, () => {
      const got = deriveFootnoteId(
        row.originalId,
        row.occurrence,
        new Set(row.taken),
      );
      expect(got).toBe(row.expected);
    });
  }

  it("the >25 row's taken-set really contains b..z (25 single letters) plus the base", () => {
    // Sanity-pin the construction so a typo in singleLetterSuffixes() cannot make
    // the >25 assertion pass for the wrong reason.
    const letters = singleLetterSuffixes();
    expect(letters).toHaveLength(25);
    expect(letters[0]).toBe("b");
    expect(letters[24]).toBe("z");
  });

  it("is a PURE function: it never mutates the taken set it is given", () => {
    const taken = new Set(["d__2"]);
    const before = [...taken];
    deriveFootnoteId("d", 2, taken);
    expect([...taken]).toEqual(before);
  });

  it("is deterministic: same input -> same output across calls", () => {
    const mk = () => new Set(["d__2", "d__2b"]);
    expect(deriveFootnoteId("d", 2, mk())).toBe(deriveFootnoteId("d", 2, mk()));
  });
});
