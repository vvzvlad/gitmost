import { describe, it, expect } from "vitest";
import { extractFootnoteDefinitions } from "./footnote.marked";

/** Pull the ordered list of `data-footnote-def` ids out of the rendered section. */
function defIds(section: string): string[] {
  return [...section.matchAll(/data-footnote-def data-id="([^"]+)"/g)].map(
    (m) => m[1],
  );
}

/** Pull the ordered list of `[^id]` markers that remain in the body. */
function bodyMarkers(body: string): string[] {
  return [...body.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => m[1]);
}

describe("extractFootnoteDefinitions: duplicate definition ids (first-wins)", () => {
  // Body has ONE `[^d]` reference but THREE `[^d]:` definitions. Under the
  // import model (#166) a duplicate definition id is FIRST-WINS: only the first
  // definition is kept; the rest are DROPPED (and surfaced by analyzeFootnotes,
  // not silently re-id'd into orphan footnotes as before). Reference markers are
  // never rewritten, so repeated references would reuse the single footnote.
  const md = ["See[^d].", "", "[^d]: a", "[^d]: b", "[^d]: c"].join("\n");

  it("keeps only the FIRST definition for the id (first-wins)", () => {
    const { section } = extractFootnoteDefinitions(md);
    const ids = defIds(section);
    expect(ids).toEqual(["d"]);
  });

  it("keeps the first definition's text and drops the duplicates", () => {
    const { section } = extractFootnoteDefinitions(md);
    expect(section).toContain('data-footnote-def data-id="d"><p>a</p>');
    // No derived `d__2` / `d__3` ids are emitted anymore.
    expect(section).not.toContain("d__2");
    expect(section).not.toContain("d__3");
    // The dropped duplicate texts are not in the section.
    expect(section).not.toContain("<p>b</p>");
    expect(section).not.toContain("<p>c</p>");
  });

  it("leaves the SINGLE body marker as [^d] (markers are never rewritten)", () => {
    const { body } = extractFootnoteDefinitions(md);
    expect(bodyMarkers(body)).toEqual(["d"]);
    expect(body).toContain("See[^d].");
    // The definition lines themselves were pulled OUT of the body.
    expect(body).not.toContain("[^d]: a");
    expect(body).not.toContain("[^d]: b");
    expect(body).not.toContain("[^d]: c");
  });

  it("does not crash and produces a well-formed footnotes section", () => {
    const { section } = extractFootnoteDefinitions(md);
    expect(section.startsWith("<section data-footnotes>")).toBe(true);
    expect(section.endsWith("</section>")).toBe(true);
    // Exactly one definition div (first-wins).
    expect([...section.matchAll(/<div data-footnote-def/g)]).toHaveLength(1);
  });
});

describe("extractFootnoteDefinitions: reuse (repeated references, one definition)", () => {
  // Pandoc semantics: many `[^a]` references + one `[^a]:` definition = one
  // footnote, shared. Markers are left intact so the editor numbers them as one.
  const md = ["A[^a] B[^a] C[^a].", "", "[^a]: shared note"].join("\n");

  it("emits exactly one definition and leaves every reference marker as [^a]", () => {
    const { section, body } = extractFootnoteDefinitions(md);
    expect(defIds(section)).toEqual(["a"]);
    expect(section).toContain('data-footnote-def data-id="a"><p>shared note</p>');
    // All three reference markers stay `a` (no `a__2`/`a__3` minting).
    expect(bodyMarkers(body)).toEqual(["a", "a", "a"]);
  });
});
