import { describe, expect, it } from "vitest";
// Import the converters DIRECTLY from src (NOT the docmost-client barrel, which
// mutates the global DOM at import time), matching the other converter tests.
import { convertProseMirrorToMarkdown } from "../src/lib/markdown-converter.js";
import { markdownToProseMirror } from "../src/lib/markdown-to-prosemirror.js";

// ---------------------------------------------------------------------------
// Tiny builders (mirror the other converter tests).
// ---------------------------------------------------------------------------
const doc = (...nodes: any[]) => ({ type: "doc", content: nodes });
const P = (...content: any[]) => ({ type: "paragraph", content });
const T = (text: string, marks?: any[]) =>
  marks ? { type: "text", text, marks } : { type: "text", text };
const ref = (id: string) => ({ type: "footnoteReference", attrs: { id } });
const list = (...defs: any[]) => ({ type: "footnotesList", content: defs });
const def = (id: string, ...paras: any[]) => ({
  type: "footnoteDefinition",
  attrs: { id },
  content: paras,
});

// Find the FIRST node of a type anywhere in a PM tree (depth first).
function findNode(n: any, type: string): any {
  if (!n || typeof n !== "object") return undefined;
  if (n.type === type) return n;
  if (Array.isArray(n.content)) {
    for (const c of n.content) {
      const hit = findNode(c, type);
      if (hit) return hit;
    }
  }
  return undefined;
}
// Collect EVERY node of a type.
function findAll(n: any, type: string, out: any[] = []): any[] {
  if (!n || typeof n !== "object") return out;
  if (n.type === type) out.push(n);
  if (Array.isArray(n.content)) n.content.forEach((c: any) => findAll(c, type, out));
  return out;
}
// Concatenate all text under a node.
function allText(n: any): string {
  if (!n || typeof n !== "object") return "";
  if (n.type === "text") return n.text || "";
  if (Array.isArray(n.content)) return n.content.map(allText).join("");
  return "";
}

// ---------------------------------------------------------------------------
// basic: `^[body]` at the reference point, byte-stable round trip.
// ---------------------------------------------------------------------------
describe("inline footnote: basic", () => {
  it("serializes a ref + def to `text^[a note]` and re-imports losslessly", async () => {
    const d = doc(P(T("text"), ref("fn1")), list(def("fn1", P(T("a note")))));
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe("text^[a note]");

    const back = await markdownToProseMirror(md);
    const r = findNode(back, "footnoteReference");
    const l = findNode(back, "footnotesList");
    const dfn = findNode(back, "footnoteDefinition");
    expect(r).toBeDefined();
    expect(l).toBeDefined();
    expect(dfn).toBeDefined();
    // The note body rode along, not just the wrapper.
    expect(allText(dfn)).toBe("a note");
    // The reference points at the matching definition (derived id).
    expect(r.attrs.id).toBe(dfn.attrs.id);
    // Ids are assigned sequentially by the import post-pass (F1), not hashed.
    expect(r.attrs.id).toBe("fn-1");

    // Byte-stable: re-export equals the first export.
    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// bracket balancing (MANDATORY): a `[link](url)` inside the body is captured
// whole and survives as a link mark in the definition.
// ---------------------------------------------------------------------------
describe("inline footnote: bracket balancing", () => {
  it("captures a full balanced `[link](url)` body and keeps the link", async () => {
    const body = "note with a ";
    const d = doc(
      P(T("x"), ref("fn1")),
      list(
        def(
          "fn1",
          P(
            T(body),
            T("link", [{ type: "link", attrs: { href: "https://x" } }]),
            T(" inside"),
          ),
        ),
      ),
    );
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe("x^[note with a [link](https://x) inside]");

    const back = await markdownToProseMirror(md);
    const dfn = findNode(back, "footnoteDefinition");
    expect(allText(dfn)).toBe("note with a link inside");
    // The link mark survived inside the definition (parser did NOT cut at the
    // first inner `]`).
    const linkText = findAll(dfn, "text").find((t: any) =>
      (t.marks || []).some((m: any) => m.type === "link"),
    );
    expect(linkText).toBeDefined();
    expect(linkText.text).toBe("link");
    expect(linkText.marks[0].attrs.href).toBe("https://x");

    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });

  it("escapes a STRAY unbalanced `]`/`[` in body text and round-trips it", async () => {
    const d = doc(
      P(T("x"), ref("fn1")),
      list(def("fn1", P(T("a ] and [ stray")))),
    );
    const md = convertProseMirrorToMarkdown(d);
    // The stray brackets are backslash-escaped so `^[…]` stays parseable.
    expect(md).toBe("x^[a \\] and \\[ stray]");

    const back = await markdownToProseMirror(md);
    const dfn = findNode(back, "footnoteDefinition");
    expect(allText(dfn)).toBe("a ] and [ stray");

    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// multi-paragraph body -> literal `\n` separator.
// ---------------------------------------------------------------------------
describe("inline footnote: multi-paragraph body", () => {
  it("joins two paragraphs with a literal `\\n` and re-splits them", async () => {
    const d = doc(
      P(T("x"), ref("fn1")),
      list(def("fn1", P(T("para one")), P(T("para two")))),
    );
    const md = convertProseMirrorToMarkdown(d);
    // The separator is the two literal characters backslash + n.
    expect(md).toBe("x^[para one\\npara two]");
    expect(md.includes("\\n")).toBe(true);
    // NOT a real newline inside the footnote.
    expect(md.includes("\n")).toBe(false);

    const back = await markdownToProseMirror(md);
    const dfn = findNode(back, "footnoteDefinition");
    const paras = (dfn.content || []).filter((p: any) => p.type === "paragraph");
    expect(paras.length).toBe(2);
    expect(allText(paras[0])).toBe("para one");
    expect(allText(paras[1])).toBe("para two");

    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// real backslash-n escaping (MANDATORY): a literal `\n` in the body text is
// emitted as `\\n` and round-trips to the literal text, NOT a paragraph break.
// ---------------------------------------------------------------------------
describe("inline footnote: real backslash-n escaping", () => {
  it("escapes a literal `\\n` as `\\\\n` and keeps it a single paragraph", async () => {
    // Body text contains the two literal characters: backslash, n.
    const d = doc(
      P(T("x"), ref("fn1")),
      list(def("fn1", P(T("path C:\\new here")))),
    );
    const md = convertProseMirrorToMarkdown(d);
    // The real backslash-n becomes an ESCAPED backslash-n (`\\n`).
    expect(md).toBe("x^[path C:\\\\new here]");

    const back = await markdownToProseMirror(md);
    const dfn = findNode(back, "footnoteDefinition");
    const paras = (dfn.content || []).filter((p: any) => p.type === "paragraph");
    // A single paragraph — the `\n` was NOT read as a paragraph break.
    expect(paras.length).toBe(1);
    expect(allText(dfn)).toBe("path C:\\new here");

    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// dedup / multiple refs.
// ---------------------------------------------------------------------------
describe("inline footnote: dedup", () => {
  it("two refs to the SAME def emit `^[same]` twice and MERGE on parse", async () => {
    const d = doc(
      P(T("a"), ref("fn1"), T(" b"), ref("fn1")),
      list(def("fn1", P(T("same text")))),
    );
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe("a^[same text] b^[same text]");

    const back = await markdownToProseMirror(md);
    // Two references, ONE definition (merged), sharing the same id.
    const refs = findAll(back, "footnoteReference");
    const defs = findAll(back, "footnoteDefinition");
    expect(refs.length).toBe(2);
    expect(defs.length).toBe(1);
    expect(refs[0].attrs.id).toBe(refs[1].attrs.id);
    expect(refs[0].attrs.id).toBe(defs[0].attrs.id);

    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });

  it("two `^[identical]` in SOURCE merge to one definition", async () => {
    const back = await markdownToProseMirror("a^[note] b^[note]");
    const refs = findAll(back, "footnoteReference");
    const defs = findAll(back, "footnoteDefinition");
    expect(refs.length).toBe(2);
    expect(defs.length).toBe(1);
    expect(refs[0].attrs.id).toBe(defs[0].attrs.id);
  });
});

// ---------------------------------------------------------------------------
// footnote inside a column -> raw-HTML `<sup data-fn-text>` form (NOT `^[…]`).
// ---------------------------------------------------------------------------
describe("inline footnote: inside a column", () => {
  it("carries the body on `<sup data-fn-text>` and round-trips", async () => {
    const d = doc(
      {
        type: "columns",
        content: [
          {
            type: "column",
            attrs: { width: "50%" },
            content: [P(T("col "), ref("fn1"))],
          },
        ],
      },
      list(def("fn1", P(T("colnote")))),
    );
    const md = convertProseMirrorToMarkdown(d);
    // Raw-HTML path: the ref carries its text ON the sup, NOT as `^[…]`.
    expect(md).toContain('data-fn-text="colnote"');
    expect(md).not.toContain("^[");

    const back = await markdownToProseMirror(md);
    // The reference stays inside the column; the definition is at doc level.
    const col = findNode(back, "column");
    expect(findNode(col, "footnoteReference")).toBeDefined();
    const dfn = findNode(back, "footnoteDefinition");
    expect(allText(dfn)).toBe("colnote");
    const r = findNode(back, "footnoteReference");
    expect(r.attrs.id).toBe(dfn.attrs.id);

    // The footnote portion is byte-stable on re-export (the surrounding columns
    // node applies its own layout/width normalization, unrelated to footnotes).
    // The raw-HTML column sup carries the body on data-fn-text and NO id (F1);
    // the id is assigned by the import post-pass.
    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toContain('data-fn-text="colnote"');
    expect(md2).not.toContain("data-id=");
  });
});

// ---------------------------------------------------------------------------
// orphan definition: a def with no reference is not silently lost.
// ---------------------------------------------------------------------------
describe("inline footnote: orphan definition", () => {
  it("appends an unreferenced definition as its own `^[body]` line", async () => {
    const d = doc(P(T("body text")), list(def("fnX", P(T("orphan note")))));
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe("body text\n\n^[orphan note]");

    const back = await markdownToProseMirror(md);
    const dfn = findNode(back, "footnoteDefinition");
    expect(dfn).toBeDefined();
    expect(allText(dfn)).toBe("orphan note");
  });
});

// ---------------------------------------------------------------------------
// no backward compat: `[^id]` / `[^id]: def` stay literal (no footnote node).
// ---------------------------------------------------------------------------
describe("inline footnote: no backward compat for the reference form", () => {
  it("does not parse `[^1]` into a footnote node", async () => {
    const back = await markdownToProseMirror("see [^1] here");
    expect(findNode(back, "footnoteReference")).toBeUndefined();
    expect(findNode(back, "footnotesList")).toBeUndefined();
    // The literal text survives.
    expect(allText(back)).toContain("[^1]");
  });

  it("does not parse a `[^1]: def` definition line into a footnote node", async () => {
    const back = await markdownToProseMirror("text\n\n[^1]: a definition");
    expect(findNode(back, "footnoteReference")).toBeUndefined();
    expect(findNode(back, "footnoteDefinition")).toBeUndefined();
    expect(findNode(back, "footnotesList")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// literal `^[` in prose must NOT materialize a phantom footnote on re-import.
// ---------------------------------------------------------------------------
describe("inline footnote: literal `^[` in prose", () => {
  it("escapes a literal `^[…]` in text so it stays text, byte-stable", async () => {
    const d = doc(P(T("see ^[not a note] here")));
    const md = convertProseMirrorToMarkdown(d);
    // The opening `^[` is broken with a backslash so the tokenizer never fires.
    expect(md).toBe("see ^\\[not a note] here");

    const back = await markdownToProseMirror(md);
    expect(findNode(back, "footnoteReference")).toBeUndefined();
    expect(allText(back)).toBe("see ^[not a note] here");

    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// fail-open: unbalanced `^[` and empty `^[]` do not crash.
// ---------------------------------------------------------------------------
describe("inline footnote: fail-open", () => {
  it("leaves an unbalanced `^[` as literal text, no crash", async () => {
    const back = await markdownToProseMirror("dangling ^[ open bracket");
    expect(findNode(back, "footnoteReference")).toBeUndefined();
    expect(allText(back)).toContain("^[ open bracket");
  });

  it("treats `^[]` as a footnote with an empty body, no crash", async () => {
    const back = await markdownToProseMirror("empty^[]");
    const r = findNode(back, "footnoteReference");
    const dfn = findNode(back, "footnoteDefinition");
    expect(r).toBeDefined();
    expect(dfn).toBeDefined();
    expect(allText(dfn)).toBe("");
    // Byte-stable: an empty-body footnote re-exports as `^[]`.
    expect(convertProseMirrorToMarkdown(back)).toBe("empty^[]");
  });
});

// ---------------------------------------------------------------------------
// F1 (CRITICAL): DIFFERENT bodies must NEVER merge — dedup keys on exact text,
// not a 32-bit hash (the old djb2 hash collided `"sgrs rj"` / `"a gtkfr"`).
// ---------------------------------------------------------------------------
describe("inline footnote: distinct bodies never merge (F1)", () => {
  it("keeps the hash-colliding pair `sgrs rj` / `a gtkfr` as two distinct defs", async () => {
    // These two DIFFERENT bodies hashed to the same fn-16myybs under djb2, which
    // silently dropped the second body. With text-exact dedup they must survive
    // as two separate definitions.
    const d = doc(
      P(T("x"), ref("fnA"), T(" y"), ref("fnB")),
      list(def("fnA", P(T("sgrs rj"))), def("fnB", P(T("a gtkfr")))),
    );
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe("x^[sgrs rj] y^[a gtkfr]");

    const back = await markdownToProseMirror(md);
    const defs = findAll(back, "footnoteDefinition");
    const refs = findAll(back, "footnoteReference");
    // BOTH bodies survive as DISTINCT definitions.
    expect(defs.length).toBe(2);
    const bodies = defs.map(allText).sort();
    expect(bodies).toEqual(["a gtkfr", "sgrs rj"]);
    // Two refs, each pointing at a DIFFERENT def id.
    expect(refs.length).toBe(2);
    expect(refs[0].attrs.id).not.toBe(refs[1].attrs.id);
    expect(new Set(defs.map((x: any) => x.attrs.id)).size).toBe(2);

    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// F2 (CRITICAL): a body ending in `\` (or `\` before `]`) must survive `^[…]`.
// Each must round-trip BYTE-STABLE across 3 iterations, footnote intact.
// ---------------------------------------------------------------------------
describe("inline footnote: raw backslash bodies survive (F2)", () => {
  const cases: Array<{ name: string; body: string; expectMd: string }> = [
    {
      name: "trailing backslash (Windows path)",
      body: "C:\\dir\\",
      expectMd: "x^[C:\\\\dir\\\\]",
    },
    {
      name: "backslash before a literal bracket",
      body: "a \\] b",
      expectMd: "x^[a \\\\\\] b]",
    },
    {
      name: "regex with trailing backslash",
      body: "re\\gex\\",
      expectMd: "x^[re\\\\gex\\\\]",
    },
  ];
  for (const { name, body, expectMd } of cases) {
    it(`round-trips ${name} byte-stable x3 with the backslash preserved`, async () => {
      const d = doc(P(T("x"), ref("fn1")), list(def("fn1", P(T(body)))));
      let md = convertProseMirrorToMarkdown(d);
      expect(md).toBe(expectMd);

      // Three full iterations must all be byte-identical and keep the footnote.
      for (let iter = 0; iter < 3; iter++) {
        const back = await markdownToProseMirror(md);
        const dfn = findNode(back, "footnoteDefinition");
        expect(dfn).toBeDefined();
        // The backslashes are preserved EXACTLY in the note body.
        expect(allText(dfn)).toBe(body);
        const md2 = convertProseMirrorToMarkdown(back);
        expect(md2).toBe(md);
        md = md2;
      }
    });
  }
});

// ---------------------------------------------------------------------------
// F4: assembleFootnotes must not emit a DUPLICATE <section data-footnotes> when
// the HTML already carries one (a footnote list that landed in a column).
// ---------------------------------------------------------------------------
describe("inline footnote: no duplicate footnotes section (F4)", () => {
  it("produces exactly one footnotesList when a column footnote is present", async () => {
    const d = doc(
      {
        type: "columns",
        content: [
          { type: "column", attrs: { width: "50%" }, content: [P(T("c "), ref("fn1"))] },
        ],
      },
      list(def("fn1", P(T("colnote")))),
    );
    const md = convertProseMirrorToMarkdown(d);
    const back = await markdownToProseMirror(md);
    // Exactly one assembled footnotes list, not two.
    expect(findAll(back, "footnotesList").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// N1 (data-loss): NESTED inline footnotes must round-trip — the assembly pass
// runs to a FIXED POINT so an inner `^[…]` spawned by parseInline is also
// assigned an id, built into a def, and stripped (no dangling ref, no lost body).
// ---------------------------------------------------------------------------
describe("inline footnote: nested footnotes (N1)", () => {
  it("keeps `^[outer ^[inner] tail]` as TWO defs, inner preserved, byte-stable", async () => {
    const md1 = "text ^[outer ^[inner] tail] end";
    const back = await markdownToProseMirror(md1);
    const defs = findAll(back, "footnoteDefinition");
    const refs = findAll(back, "footnoteReference");
    // Two distinct definitions (outer + inner); two references.
    expect(defs.length).toBe(2);
    expect(refs.length).toBe(2);
    expect(new Set(defs.map((d: any) => d.attrs.id)).size).toBe(2);
    const bodies = defs.map(allText).sort();
    expect(bodies).toEqual(["inner", "outer  tail"]);
    // The OUTER definition body carries a footnoteReference to the inner def.
    const outer = defs.find((d: any) => allText(d).includes("outer"));
    const inner = defs.find((d: any) => allText(d) === "inner");
    const nestedRef = findNode(outer, "footnoteReference");
    expect(nestedRef).toBeDefined();
    expect(nestedRef.attrs.id).toBe(inner.attrs.id);
    // Byte-stable across two further iterations (md1 === md2 === md3).
    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md1);
    const md3 = convertProseMirrorToMarkdown(await markdownToProseMirror(md2));
    expect(md3).toBe(md2);
  });

  it("round-trips a 3-level nest `^[a ^[b ^[c] d] e]` (three defs)", async () => {
    const md1 = "z ^[a ^[b ^[c] d] e] z";
    const back = await markdownToProseMirror(md1);
    const defs = findAll(back, "footnoteDefinition");
    expect(defs.length).toBe(3);
    expect(new Set(defs.map((d: any) => d.attrs.id)).size).toBe(3);
    expect(defs.map(allText).sort()).toEqual(["a  e", "b  d", "c"]);
    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md1);
    const md3 = convertProseMirrorToMarkdown(await markdownToProseMirror(md2));
    expect(md3).toBe(md2);
  });
});

// ---------------------------------------------------------------------------
// N2: a generated id must never collide with an id already present in a REUSED
// footnotes section (the counter is seeded past the max existing `fn-N`).
// ---------------------------------------------------------------------------
describe("inline footnote: generated ids never collide with a reused section (N2)", () => {
  it("seeds the counter past an existing `fn-1` def in a legacy section", async () => {
    // A legacy `<section data-footnotes>` (existing `fn-1`) reaches the body as
    // raw HTML; the new inline `^[…]` must NOT be assigned `fn-1` too.
    const md =
      "text^[new note]\n\n" +
      '<section data-footnotes><div data-footnote-def data-id="fn-1">' +
      "<p>existing note</p></div></section>";
    const back = await markdownToProseMirror(md);
    const defs = findAll(back, "footnoteDefinition");
    // Both notes survive as DISTINCT definitions in a SINGLE list.
    expect(defs.length).toBe(2);
    expect(new Set(defs.map((d: any) => d.attrs.id)).size).toBe(2);
    expect(findAll(back, "footnotesList").length).toBe(1);
    expect(defs.map(allText).sort()).toEqual(["existing note", "new note"]);
    // The pre-existing id is preserved; the new one is seeded past it.
    expect(defs.map((d: any) => d.attrs.id)).toContain("fn-1");
    expect(defs.map((d: any) => d.attrs.id)).toContain("fn-2");
  });
});
