import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { computeHistoryDiff } from "./history-diff.ts";

// Unit tests for `computeHistoryDiff` (history-diff.ts) — the pure core extracted
// from history-editor.tsx. Given the editor schema plus old/new ProseMirror
// document JSON it produces {decorationSet, added, deleted, total}: inline
// decorations for text edits, whole-node decorations for added block nodes
// (image/table), widget "ghosts" for deleted block nodes (callout), and an empty
// diff for the first version or malformed JSON.
//
// We drive it with a hand-built ProseMirror schema rather than the real
// `mainExtensions` because importing the editor extensions pulls in the whole app
// (main.tsx) at module load. The schema below mirrors the relevant shape: a doc of
// block content, an `image` block atom and a `table` block treated as whole-node
// diffs, and a `callout` block treated as a deletable whole node.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    callout: {
      group: "block",
      content: "inline*",
      toDOM: () => ["div", { class: "callout" }, 0],
    },
    image: {
      group: "block",
      atom: true,
      attrs: { src: { default: "" } },
      toDOM: (node) => ["img", { src: node.attrs.src }],
    },
    table: {
      group: "block",
      content: "paragraph+",
      toDOM: () => ["table", ["tbody", 0]],
    },
    text: { group: "inline" },
  },
});

const para = (text: string) => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
const docOf = (...blocks: any[]) => ({ type: "doc", content: blocks });

describe("computeHistoryDiff", () => {
  it("returns an empty diff (counts 0) when there is no previous version", () => {
    const diff = computeHistoryDiff(schema, docOf(para("hello")), undefined);
    expect(diff.added).toBe(0);
    expect(diff.deleted).toBe(0);
    expect(diff.total).toBe(0);
    expect(diff.decorationSet.find()).toHaveLength(0);
  });

  it("returns an empty diff when content is missing", () => {
    const diff = computeHistoryDiff(schema, undefined, docOf(para("x")));
    expect(diff.total).toBe(0);
  });

  it("emits inline decorations and counts for a text edit", () => {
    const prev = docOf(para("hello world"));
    const next = docOf(para("hello brave world"));
    const diff = computeHistoryDiff(schema, next, prev);

    expect(diff.added).toBeGreaterThan(0);
    const decos = diff.decorationSet.find();
    expect(decos.length).toBeGreaterThan(0);
    // An inline text addition is rendered with the inline-added class.
    const classes = decos.map((d) => (d.spec as any)?.class ?? (d as any).type?.attrs?.class);
    const hasInline = JSON.stringify(decos).includes("history-diff-added") ||
      classes.some((c) => c === "history-diff-added");
    expect(hasInline).toBe(true);
  });

  it("treats an added image as a whole-node addition", () => {
    const prev = docOf(para("text"));
    const next = docOf(para("text"), { type: "image", attrs: { src: "a.png" } });
    const diff = computeHistoryDiff(schema, next, prev);
    expect(diff.added).toBeGreaterThan(0);
    expect(JSON.stringify(diff.decorationSet.find())).toContain(
      "history-diff-node-added",
    );
  });

  it("treats an added table as a whole-node addition", () => {
    const prev = docOf(para("text"));
    const next = docOf(para("text"), {
      type: "table",
      content: [para("cell")],
    });
    const diff = computeHistoryDiff(schema, next, prev);
    expect(diff.added).toBeGreaterThan(0);
    expect(JSON.stringify(diff.decorationSet.find())).toContain(
      "history-diff-node-added",
    );
  });

  it("renders a widget ghost for a deleted callout", () => {
    const prev = docOf(para("text"), {
      type: "callout",
      content: [{ type: "text", text: "warning" }],
    });
    const next = docOf(para("text"));
    const diff = computeHistoryDiff(schema, next, prev);
    expect(diff.deleted).toBeGreaterThan(0);
    // The deleted whole node produces a widget decoration (toDOM callback).
    const decos = diff.decorationSet.find();
    expect(decos.some((d) => (d as any).type?.toDOM || (d as any).type?.widget)).toBe(
      true,
    );
  });

  it("falls back to an empty diff (no throw) on malformed version JSON", () => {
    const malformed = { type: "doc", content: [{ type: "nonexistent-node" }] };
    expect(() =>
      computeHistoryDiff(schema, malformed, docOf(para("x"))),
    ).not.toThrow();
    const diff = computeHistoryDiff(schema, malformed, docOf(para("x")));
    expect(diff.total).toBe(0);
    expect(diff.decorationSet.find()).toHaveLength(0);
  });
});
