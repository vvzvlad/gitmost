import { describe, expect, it } from "vitest";
import {
  convertProseMirrorToMarkdown,
  ConverterLossError,
} from "../src/lib/markdown-converter.js";

/**
 * #493 commit 3 — a node/mark type the serializer has no dedicated case for used
 * to be degraded SILENTLY (an unknown node flattened to its children, an unknown
 * mark dropped from the run). The serializer now REPORTS the loss:
 *   - default (non-strict): unchanged graceful degradation, but one warning per
 *     unmapped type is pushed into an optional `warnings` sink so callers can
 *     observe it;
 *   - strict: the FIRST unmapped type throws a ConverterLossError (git-sync +
 *     tests), turning a silent loss into a hard, surfaced error.
 *
 * Exercised through the REAL converter (no mock): the observable properties are
 * the emitted markdown, the warnings collected, and the thrown error.
 */

const doc = (...nodes: any[]) => ({ type: "doc", content: nodes });

describe("converter loss reporting — unknown node types", () => {
  const unknownNode = doc({
    type: "quantumWidget",
    content: [{ type: "text", text: "inner text" }],
  });

  it("degrades to children AND records a warning (non-strict, sink provided)", () => {
    const warnings: string[] = [];
    const md = convertProseMirrorToMarkdown(unknownNode, { warnings });
    // Graceful degrade: the child text still survives (historical behavior).
    expect(md).toContain("inner text");
    // The loss is now observable.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("quantumWidget");
    expect(warnings[0]).toContain("node");
  });

  it("stays byte-identical for callers that pass no sink (zero behavior change)", () => {
    const withSink: string[] = [];
    const a = convertProseMirrorToMarkdown(unknownNode, { warnings: withSink });
    const b = convertProseMirrorToMarkdown(unknownNode);
    expect(b).toBe(a); // the sink does not alter the produced markdown
  });

  it("throws ConverterLossError in strict mode", () => {
    try {
      convertProseMirrorToMarkdown(unknownNode, { strict: true });
      expect.unreachable("strict mode must throw on an unknown node");
    } catch (e) {
      expect(e).toBeInstanceOf(ConverterLossError);
      expect((e as ConverterLossError).kind).toBe("node");
      expect((e as ConverterLossError).typeName).toBe("quantumWidget");
    }
  });

  it("dedupes the warning per type (many unknown nodes -> one message)", () => {
    const warnings: string[] = [];
    convertProseMirrorToMarkdown(
      doc(
        { type: "quantumWidget", content: [{ type: "text", text: "a" }] },
        { type: "quantumWidget", content: [{ type: "text", text: "b" }] },
      ),
      { warnings },
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("converter loss reporting — unknown mark types", () => {
  const unknownMark = doc({
    type: "paragraph",
    content: [{ type: "text", text: "glowing", marks: [{ type: "glow" }] }],
  });

  it("drops the mark but keeps the text AND records a warning (non-strict)", () => {
    const warnings: string[] = [];
    const md = convertProseMirrorToMarkdown(unknownMark, { warnings });
    expect(md).toBe("glowing"); // text survives, mark silently had no form
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("glow");
    expect(warnings[0]).toContain("mark");
  });

  it("throws ConverterLossError in strict mode", () => {
    expect(() =>
      convertProseMirrorToMarkdown(unknownMark, { strict: true }),
    ).toThrow(ConverterLossError);
  });
});

describe("converter loss reporting — known content is never flagged", () => {
  it("a fully-mapped document produces no warnings and does not throw in strict mode", () => {
    const d = doc(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " and " },
          { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x.y" } }] },
        ],
      },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
    );
    const warnings: string[] = [];
    const md = convertProseMirrorToMarkdown(d, { warnings, strict: true });
    expect(warnings).toEqual([]);
    expect(md).toContain("## Title");
  });
});
