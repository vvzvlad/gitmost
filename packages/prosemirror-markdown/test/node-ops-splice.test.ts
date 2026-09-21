import { describe, expect, it } from "vitest";
import {
  replaceNodeByIdWithMany,
  insertNodesRelative,
} from "../src/lib/node-ops.js";

// #413: the array-splice helpers used by the markdown patch/insert paths.
const p = (id: string, t: string): any => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: t }],
});

describe("replaceNodeByIdWithMany", () => {
  it("splices N nodes in place of the first match, keeping neighbours byte-identical", () => {
    const before = { type: "doc", content: [p("a", "A"), p("b", "B"), p("c", "C")] };
    const snap = JSON.parse(JSON.stringify(before));
    const { doc, replaced } = replaceNodeByIdWithMany(before, "b", [
      p("b1", "B1"),
      p("b2", "B2"),
    ]);
    expect(replaced).toBe(1);
    expect(doc.content.map((n: any) => n.attrs.id)).toEqual(["a", "b1", "b2", "c"]);
    // Input never mutated.
    expect(before).toEqual(snap);
    // Neighbours byte-identical.
    expect(doc.content[0]).toEqual(snap.content[0]);
    expect(doc.content[3]).toEqual(snap.content[2]);
  });

  it("reaches a nested match (inside a callout) and splices there", () => {
    const before = {
      type: "doc",
      content: [
        { type: "callout", attrs: { id: "co" }, content: [p("x", "X")] },
      ],
    };
    const { doc, replaced } = replaceNodeByIdWithMany(before, "x", [
      p("x1", "X1"),
      p("x2", "X2"),
    ]);
    expect(replaced).toBe(1);
    expect(doc.content[0].content.map((n: any) => n.attrs.id)).toEqual(["x1", "x2"]);
  });

  it("only touches the FIRST duplicate (caller guards ambiguity)", () => {
    const before = { type: "doc", content: [p("d", "1"), p("d", "2")] };
    const { doc, replaced } = replaceNodeByIdWithMany(before, "d", [p("n", "N")]);
    expect(replaced).toBe(1);
    // First replaced; the second duplicate survives untouched.
    expect(doc.content.map((n: any) => n.attrs.id)).toEqual(["n", "d"]);
  });

  it("reports replaced:0 for no match, doc unchanged", () => {
    const before = { type: "doc", content: [p("a", "A")] };
    const { doc, replaced } = replaceNodeByIdWithMany(before, "zzz", [p("n", "N")]);
    expect(replaced).toBe(0);
    expect(doc).toEqual(before);
  });
});

describe("insertNodesRelative", () => {
  it("inserts an ordered array after an id anchor", () => {
    const before = { type: "doc", content: [p("a", "A"), p("b", "B")] };
    const { doc, inserted } = insertNodesRelative(
      before,
      [p("n1", "N1"), p("n2", "N2")],
      { position: "after", anchorNodeId: "a" },
    );
    expect(inserted).toBe(true);
    expect(doc.content.map((n: any) => n.attrs.id)).toEqual(["a", "n1", "n2", "b"]);
  });

  it("inserts before an id anchor", () => {
    const before = { type: "doc", content: [p("a", "A"), p("b", "B")] };
    const { doc } = insertNodesRelative(before, [p("n", "N")], {
      position: "before",
      anchorNodeId: "b",
    });
    expect(doc.content.map((n: any) => n.attrs.id)).toEqual(["a", "n", "b"]);
  });

  it("appends an ordered array at the top level", () => {
    const before = { type: "doc", content: [p("a", "A")] };
    const { doc } = insertNodesRelative(before, [p("n1", "N1"), p("n2", "N2")], {
      position: "append",
    });
    expect(doc.content.map((n: any) => n.attrs.id)).toEqual(["a", "n1", "n2"]);
  });

  it("resolves an anchor by top-level text", () => {
    const before = { type: "doc", content: [p("a", "hello there"), p("b", "B")] };
    const { doc, inserted } = insertNodesRelative(before, [p("n", "N")], {
      position: "after",
      anchorText: "hello",
    });
    expect(inserted).toBe(true);
    expect(doc.content.map((n: any) => n.attrs.id)).toEqual(["a", "n", "b"]);
  });

  it("reports inserted:false when the anchor is missing", () => {
    const before = { type: "doc", content: [p("a", "A")] };
    const { doc, inserted } = insertNodesRelative(before, [p("n", "N")], {
      position: "after",
      anchorNodeId: "missing",
    });
    expect(inserted).toBe(false);
    expect(doc).toEqual(before);
  });

  it("is a no-op for an empty node array", () => {
    const before = { type: "doc", content: [p("a", "A")] };
    const { doc, inserted } = insertNodesRelative(before, [], {
      position: "append",
    });
    expect(inserted).toBe(false);
    expect(doc).toEqual(before);
  });
});
