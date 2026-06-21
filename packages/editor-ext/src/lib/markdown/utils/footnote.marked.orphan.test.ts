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

describe("extractFootnoteDefinitions: more definitions than markers (orphans)", () => {
  // Body has ONE `[^d]` reference marker but THREE `[^d]:` definitions. The
  // surplus definitions have no marker to pair with — they must NOT be silently
  // merged into one footnote (the editor's last-wins sync would otherwise drop
  // two of them). The dedup gives each colliding definition a deterministic
  // derived id so all three survive as distinct footnoteDefinition nodes.
  const md = ["See[^d].", "", "[^d]: a", "[^d]: b", "[^d]: c"].join("\n");

  it("emits 3 DISTINCT definition ids: d, d__2, d__3 (derived scheme, in order)", () => {
    const { section } = extractFootnoteDefinitions(md);
    const ids = defIds(section);
    expect(ids).toEqual(["d", "d__2", "d__3"]);
    // All distinct: nothing was merged away.
    expect(new Set(ids).size).toBe(3);
  });

  it("preserves each definition's text against its (possibly derived) id", () => {
    const { section } = extractFootnoteDefinitions(md);
    // First definition keeps the original id and its text.
    expect(section).toContain('data-footnote-def data-id="d"><p>a</p>');
    // The two surplus definitions survive as orphans with derived ids.
    expect(section).toContain('data-footnote-def data-id="d__2"><p>b</p>');
    expect(section).toContain('data-footnote-def data-id="d__3"><p>c</p>');
  });

  it("leaves the SINGLE body marker as [^d] (no surplus marker to rewrite)", () => {
    const { body } = extractFootnoteDefinitions(md);
    // There is exactly one reference marker and it is untouched: the keeper
    // definition pairs with it. The orphan defs have no marker, so the body is
    // unchanged except for the stripped definition lines.
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
    // Exactly three definition divs.
    expect(
      [...section.matchAll(/<div data-footnote-def/g)],
    ).toHaveLength(3);
  });
});
