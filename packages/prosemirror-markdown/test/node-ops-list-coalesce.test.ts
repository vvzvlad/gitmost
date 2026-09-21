import { describe, expect, it } from "vitest";
import {
  insertNodesRelative,
  insertNodeRelative,
} from "../src/lib/node-ops.js";
import { markdownToProseMirrorSync } from "../src/lib/markdown-to-prosemirror.js";
import { convertProseMirrorToMarkdown } from "../src/lib/markdown-converter.js";

// #535: inserting a markdown/JSON list next to an existing same-type sibling
// list must APPEND/PREPEND its items into that list (one list), not leave two
// adjacent lists that the serializer separates with `<!-- -->`. Coalescing is
// strictly local to the two seams of the active insertion.

// ---- Minimal builders (structure is what these tests assert) ---------------

function item(label: string | number): any {
  return {
    type: "listItem",
    content: [
      { type: "paragraph", content: [{ type: "text", text: String(label) }] },
    ],
  };
}
function taskItem(label: string | number, checked = false): any {
  return {
    type: "taskItem",
    attrs: { checked },
    content: [
      { type: "paragraph", content: [{ type: "text", text: String(label) }] },
    ],
  };
}
function bulletList(id: string, ...labels: (string | number)[]): any {
  return { type: "bulletList", attrs: { id }, content: labels.map(item) };
}
function orderedList(
  id: string,
  start: number,
  attrsType: string | null,
  ...labels: (string | number)[]
): any {
  return {
    type: "orderedList",
    attrs: { id, start, type: attrsType },
    content: labels.map(item),
  };
}
function taskList(id: string, ...labels: (string | number)[]): any {
  return { type: "taskList", attrs: { id }, content: labels.map((l) => taskItem(l)) };
}

/** Read a list block's item labels (the text of each item's first paragraph). */
function labels(list: any): string[] {
  return (list.content ?? []).map(
    (it: any) => it.content?.[0]?.content?.[0]?.text,
  );
}

describe("#535 list seam coalescing — markdown path (insertNodesRelative)", () => {
  it("crit1: append a bulletList onto an adjacent bulletList -> ONE list", () => {
    const doc = { type: "doc", content: [bulletList("A", 1, 2, 3)] };
    const { doc: out, inserted } = insertNodesRelative(
      doc,
      [bulletList("B", 4)],
      { position: "append" },
    );
    expect(inserted).toBe(true);
    // Exactly one block, and it is the pre-existing survivor (id "A").
    expect(out.content.length).toBe(1);
    expect(out.content[0].type).toBe("bulletList");
    expect(out.content[0].attrs.id).toBe("A");
    expect(labels(out.content[0])).toEqual(["1", "2", "3", "4"]);
  });

  it("crit2: append an orderedList -> ONE list, original start kept, 1..4 continuous, no start:1 sibling", () => {
    const doc = { type: "doc", content: [orderedList("A", 1, null, 1, 2, 3)] };
    const { doc: out } = insertNodesRelative(
      doc,
      [orderedList("B", 1, null, 4)],
      { position: "append" },
    );
    expect(out.content.length).toBe(1);
    expect(out.content[0].type).toBe("orderedList");
    expect(out.content[0].attrs.start).toBe(1);
    expect(labels(out.content[0])).toEqual(["1", "2", "3", "4"]);
  });

  it("crit3: after/before by anchorNodeId on a same-type list -> one merged list", () => {
    const docA = { type: "doc", content: [bulletList("A", 1, 2)] };
    const afterRes = insertNodesRelative(docA, [bulletList("B", 3)], {
      position: "after",
      anchorNodeId: "A",
    });
    expect(afterRes.doc.content.length).toBe(1);
    expect(labels(afterRes.doc.content[0])).toEqual(["1", "2", "3"]);

    const docB = { type: "doc", content: [bulletList("A", 2, 3)] };
    const beforeRes = insertNodesRelative(docB, [bulletList("B", 1)], {
      position: "before",
      anchorNodeId: "A",
    });
    expect(beforeRes.doc.content.length).toBe(1);
    // Survivor is the pre-existing "A"; inserted items PREPEND.
    expect(beforeRes.doc.content[0].attrs.id).toBe("A");
    expect(labels(beforeRes.doc.content[0])).toEqual(["1", "2", "3"]);
  });

  it("crit3: anchorText resolving to a list block also merges", () => {
    const doc = { type: "doc", content: [bulletList("A", "alpha", "beta")] };
    const { doc: out } = insertNodesRelative(doc, [bulletList("B", "gamma")], {
      position: "after",
      anchorText: "alpha",
    });
    expect(out.content.length).toBe(1);
    expect(labels(out.content[0])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("crit4: both seams (three-way) — inserting a list between two same-type lists -> ONE list in order", () => {
    const doc = {
      type: "doc",
      content: [bulletList("A", 1, 2), bulletList("C", 4, 5)],
    };
    const { doc: out } = insertNodesRelative(doc, [bulletList("B", 3)], {
      position: "after",
      anchorNodeId: "A",
    });
    expect(out.content.length).toBe(1);
    // LEFT pre-existing "A" survives; order A-items, inserted, C-items.
    expect(out.content[0].attrs.id).toBe("A");
    expect(labels(out.content[0])).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("crit4: multi-block run coalesces BOTH boundary seams, inner block untouched", () => {
    // parent = [preA, Bi, para, Bj, preB]; run [Bi, para, Bj] inserted after preA.
    const doc = {
      type: "doc",
      content: [bulletList("A", 1), bulletList("E", 9)],
    };
    const run = [
      bulletList("Bi", 2),
      { type: "paragraph", content: [{ type: "text", text: "mid" }] },
      bulletList("Bj", 8),
    ];
    const { doc: out } = insertNodesRelative(doc, run, {
      position: "after",
      anchorNodeId: "A",
    });
    // Expect: [A(1,2), para(mid), E(8,9)] — preA absorbed Bi, preE absorbed Bj.
    expect(out.content.map((n: any) => n.type)).toEqual([
      "bulletList",
      "paragraph",
      "bulletList",
    ]);
    expect(labels(out.content[0])).toEqual(["1", "2"]);
    expect(out.content[1].content[0].text).toBe("mid");
    expect(labels(out.content[2])).toEqual(["8", "9"]);
    expect(out.content[0].attrs.id).toBe("A");
    expect(out.content[2].attrs.id).toBe("E");
  });

  it("crit4b: three-way with DIFFERING explicit ordered types does NOT transitively merge through a default-typed insertion", () => {
    // [ol(type:"a")[1], ol(type:"i")[9]] + insert ol(type:null)[5] after A.
    // The null-typed middle is pairwise-compatible with BOTH neighbours, but the
    // neighbours are mutually incompatible ("a" vs "i"), so they must NOT
    // collapse. The inserted list is absorbed by the LEFT survivor; the RIGHT
    // list stays separate and keeps its roman numbering style.
    const doc = {
      type: "doc",
      content: [orderedList("A", 1, "a", 1), orderedList("C", 9, "i", 9)],
    };
    const { doc: out } = insertNodeRelative(doc, orderedList("B", 5, null, 5), {
      position: "after",
      anchorNodeId: "A",
    });
    expect(out.content.length).toBe(2);
    // Left survivor absorbs the inserted item.
    expect(out.content[0].attrs.id).toBe("A");
    expect(out.content[0].attrs.type).toBe("a");
    expect(labels(out.content[0])).toEqual(["1", "5"]);
    // Right list is untouched: its explicit style survives.
    expect(out.content[1].attrs.id).toBe("C");
    expect(out.content[1].attrs.type).toBe("i");
    expect(labels(out.content[1])).toEqual(["9"]);
  });

  it("crit6: before for orderedList{start:5} keeps start:5 (positional survivor = pre-existing)", () => {
    const doc = { type: "doc", content: [orderedList("A", 5, null, "a", "b")] };
    const { doc: out } = insertNodesRelative(
      doc,
      [orderedList("B", 1, null, "c")],
      { position: "before", anchorNodeId: "A" },
    );
    expect(out.content.length).toBe(1);
    expect(out.content[0].attrs.id).toBe("A");
    expect(out.content[0].attrs.start).toBe(5);
    expect(labels(out.content[0])).toEqual(["c", "a", "b"]);
  });

  it("crit7: different list types do NOT coalesce", () => {
    // bulletList next to orderedList
    const d1 = { type: "doc", content: [bulletList("A", 1)] };
    const r1 = insertNodesRelative(d1, [orderedList("B", 1, null, 2)], {
      position: "append",
    });
    expect(r1.doc.content.length).toBe(2);
    expect(r1.doc.content.map((n: any) => n.type)).toEqual([
      "bulletList",
      "orderedList",
    ]);

    // bulletList next to taskList
    const d2 = { type: "doc", content: [bulletList("A", 1)] };
    const r2 = insertNodesRelative(d2, [taskList("B", 2)], {
      position: "append",
    });
    expect(r2.doc.content.length).toBe(2);
    expect(r2.doc.content.map((n: any) => n.type)).toEqual([
      "bulletList",
      "taskList",
    ]);
  });

  it("crit7b: orderedLists with explicit DIFFERING attrs.type do NOT coalesce", () => {
    const doc = { type: "doc", content: [orderedList("A", 1, "a", 1)] };
    const { doc: out } = insertNodesRelative(
      doc,
      [orderedList("B", 1, "i", 2)],
      { position: "append" },
    );
    expect(out.content.length).toBe(2);
  });

  it("footnotesList is NEVER structurally coalesced (allow-list excludes it, guarding against endsWith(\"List\"))", () => {
    const fn = (id: string): any => ({
      type: "footnotesList",
      attrs: { id },
      content: [
        { type: "footnoteDefinition", attrs: { id: id + "d" }, content: [] },
      ],
    });
    const doc = { type: "doc", content: [fn("A")] };
    const { doc: out } = insertNodeRelative(doc, fn("B"), {
      position: "append",
    });
    // Two footnotesLists must stay two separate blocks — merging them would
    // corrupt footnotes.
    expect(out.content.length).toBe(2);
    expect(out.content.map((n: any) => n.type)).toEqual([
      "footnotesList",
      "footnotesList",
    ]);
  });

  it("taskList next to taskList coalesces, item checked attrs move with items", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          attrs: { id: "A" },
          content: [taskItem("x", true)],
        },
      ],
    };
    const { doc: out } = insertNodesRelative(
      doc,
      [{ type: "taskList", attrs: { id: "B" }, content: [taskItem("y", false)] }],
      { position: "append" },
    );
    expect(out.content.length).toBe(1);
    expect(out.content[0].content.map((it: any) => it.attrs.checked)).toEqual([
      true,
      false,
    ]);
  });
});

describe("#535 list seam coalescing — node path (insertNodeRelative)", () => {
  it("append a single bulletList node onto an adjacent bulletList -> ONE list", () => {
    const doc = { type: "doc", content: [bulletList("A", 1, 2)] };
    const { doc: out } = insertNodeRelative(doc, bulletList("B", 3), {
      position: "append",
    });
    expect(out.content.length).toBe(1);
    expect(labels(out.content[0])).toEqual(["1", "2", "3"]);
  });

  it("crit8: EMPTY inserted list is NOT coalesced (stays as inserted)", () => {
    const doc = { type: "doc", content: [bulletList("A", 1, 2)] };
    const empty = { type: "bulletList", attrs: { id: "B" }, content: [] };
    const { doc: out, inserted } = insertNodeRelative(doc, empty, {
      position: "append",
    });
    expect(inserted).toBe(true);
    expect(out.content.length).toBe(2);
    expect(out.content[1].attrs.id).toBe("B");
    expect(out.content[1].content.length).toBe(0);
  });

  it("crit5b: nested parent — merging a list next to a list INSIDE a callout, top level untouched", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { id: "co" },
          content: [bulletList("A", 1, 2)],
        },
      ],
    };
    const { doc: out } = insertNodeRelative(doc, bulletList("B", 3), {
      position: "after",
      anchorNodeId: "A",
    });
    // Top level unchanged: still one callout.
    expect(out.content.length).toBe(1);
    expect(out.content[0].type).toBe("callout");
    // The callout's content array holds ONE merged bulletList.
    expect(out.content[0].content.length).toBe(1);
    expect(out.content[0].content[0].type).toBe("bulletList");
    expect(labels(out.content[0].content[0])).toEqual(["1", "2", "3"]);
  });
});

describe("#535 locality (regression guard) + round-trip", () => {
  it("crit5a: appending next to ONE of two intentionally-separate lists merges only that seam; the further-out separate list survives and still emits <!-- -->", () => {
    // Reimport a doc with two deliberately-separate bullet lists: [(x,y),(z)].
    const doc = markdownToProseMirrorSync("- x\n- y\n\n<!-- -->\n\n- z");
    expect(doc.content.filter((n: any) => n.type === "bulletList").length).toBe(
      2,
    );

    // Append a list. It lands at the end, adjacent to the SECOND list (z) and
    // must merge ONLY into it — the FIRST list (x,y) is the intentionally-
    // separate one two hops away and must NOT be swallowed (a greedy `while`
    // merge would reach and collapse it, which this guards against).
    const { doc: out, inserted } = insertNodesRelative(
      doc,
      [bulletList("NEW", "q")],
      { position: "append" },
    );
    expect(inserted).toBe(true);

    // Still TWO lists: (x,y) stayed separate; (z) absorbed the appended item.
    expect(out.content.filter((n: any) => n.type === "bulletList").length).toBe(
      2,
    );
    expect(labels(out.content[0])).toEqual(["x", "y"]);
    expect(labels(out.content[1])).toEqual(["z", "q"]);

    // Serialize: the separator between the two separate lists remains.
    const md = convertProseMirrorToMarkdown(out);
    expect(md).toContain("<!-- -->");
  });

  it("idempotency: re-running the transform on a fresh doc yields the same result", () => {
    const doc = { type: "doc", content: [bulletList("A", 1, 2, 3)] };
    const r1 = insertNodesRelative(doc, [bulletList("B", 4)], {
      position: "append",
    });
    const r2 = insertNodesRelative(doc, [bulletList("B", 4)], {
      position: "append",
    });
    expect(r2.doc).toEqual(r1.doc);
    // Input never mutated.
    expect(doc.content.length).toBe(1);
    expect(labels(doc.content[0])).toEqual(["1", "2", "3"]);
  });

  it("#351 P1/P2: a merged list serializes to one list and is byte-fixpoint on the 2nd pass", () => {
    // Build a merged bulletList via a canonical import so the round-trip is real.
    const base = markdownToProseMirrorSync("- one\n- two");
    const add = markdownToProseMirrorSync("- three");
    const { doc: merged } = insertNodesRelative(base, add.content, {
      position: "append",
    });
    expect(merged.content.length).toBe(1);

    const md1 = convertProseMirrorToMarkdown(merged);
    // A single list — no separator inside.
    expect(md1).not.toContain("<!-- -->");
    expect(md1).toBe("- one\n- two\n- three");

    // Reimport -> still ONE bulletList; re-serialize -> byte-identical (fixpoint).
    const reimported = markdownToProseMirrorSync(md1);
    expect(reimported.content.filter((n: any) => n.type === "bulletList").length).toBe(1);
    const md2 = convertProseMirrorToMarkdown(reimported);
    expect(md2).toBe(md1);
  });
});
