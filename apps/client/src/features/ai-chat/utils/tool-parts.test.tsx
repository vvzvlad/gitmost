import { describe, it, expect } from "vitest";
import {
  toolCitations,
  toolInputSummary,
  toolRunState,
  type ToolUiPart,
} from "./tool-parts";

describe("toolCitations", () => {
  it("emits one citation per searchPages item with a /p/{id} href", () => {
    const part: ToolUiPart = {
      type: "tool-searchPages",
      state: "output-available",
      output: [
        { id: "p1", title: "First" },
        { id: "p2", title: "Second" },
      ],
    };
    expect(toolCitations(part)).toEqual([
      { pageId: "p1", title: "First", href: "/p/p1" },
      { pageId: "p2", title: "Second", href: "/p/p2" },
    ]);
  });

  it("drops searchPages items missing an id", () => {
    const part: ToolUiPart = {
      type: "tool-searchPages",
      state: "output-available",
      output: [{ title: "No id here" }, { id: "p2", title: "Kept" }],
    };
    expect(toolCitations(part)).toEqual([
      { pageId: "p2", title: "Kept", href: "/p/p2" },
    ]);
  });

  it("falls back to input.pageId / input.title for a page-op with only pageId", () => {
    // The mutating tools echo `pageId` (no `id`); title is taken from the input.
    const part: ToolUiPart = {
      type: "tool-updatePageContent",
      state: "output-available",
      input: { pageId: "host-1", title: "From input" },
      output: { pageId: "host-1" },
    };
    expect(toolCitations(part)).toEqual([
      { pageId: "host-1", title: "From input", href: "/p/host-1" },
    ]);
  });

  it("prefers output.id over input.pageId when both exist", () => {
    const part: ToolUiPart = {
      type: "tool-getPage",
      state: "output-available",
      input: { pageId: "input-id", title: "Input title" },
      output: { id: "output-id", title: "Output title" },
    };
    expect(toolCitations(part)).toEqual([
      { pageId: "output-id", title: "Output title", href: "/p/output-id" },
    ]);
  });

  it("returns [] when the state is not output-available", () => {
    const part: ToolUiPart = {
      type: "tool-getPage",
      state: "input-available",
      output: { id: "p1", title: "Pending" },
    };
    expect(toolCitations(part)).toEqual([]);
  });

  it("returns [] for a page-op output with no resolvable id", () => {
    const part: ToolUiPart = {
      type: "tool-getPage",
      state: "output-available",
      input: {},
      output: { title: "Only a title" },
    };
    expect(toolCitations(part)).toEqual([]);
  });
});

describe("toolInputSummary", () => {
  it("returns the primary `query` string", () => {
    const part: ToolUiPart = {
      type: "tool-Search_web_search",
      state: "input-available",
      input: { query: "hello world" },
    };
    expect(toolInputSummary(part)).toBe("hello world");
  });

  it("summarizes a primary array field with a (+N) suffix", () => {
    // `urls` is an external MCP read_pages-style list; the first element plus a
    // count of the rest.
    const part: ToolUiPart = {
      type: "tool-read_pages",
      state: "input-available",
      input: { urls: ["a", "b", "c"] },
    };
    expect(toolInputSummary(part)).toBe("a (+2)");
  });

  it("omits the (+N) suffix for a single-element array", () => {
    const part: ToolUiPart = {
      type: "tool-read_pages",
      state: "input-available",
      input: { urls: ["only"] },
    };
    expect(toolInputSummary(part)).toBe("only");
  });

  it("falls back to `title` for a page op with no query", () => {
    const part: ToolUiPart = {
      type: "tool-createPage",
      state: "input-available",
      input: { pageId: "x", title: "My Page" },
    };
    expect(toolInputSummary(part)).toBe("My Page");
  });

  it("prefers the earlier primary field when several are present", () => {
    const part: ToolUiPart = {
      type: "tool-x",
      state: "input-available",
      // `query` outranks `title` in PRIMARY_INPUT_FIELDS — the ordered list is
      // the contract, so a reordering must break this test.
      input: { query: "Q", title: "T" },
    };
    expect(toolInputSummary(part)).toBe("Q");
  });

  it("does not clamp a value exactly at the 140-char limit", () => {
    const exact = "a".repeat(140);
    const part: ToolUiPart = {
      type: "tool-Search_web_search",
      state: "input-available",
      input: { query: exact },
    };
    const out = toolInputSummary(part)!;
    expect(out).toBe(exact);
    expect(out.endsWith("…")).toBe(false);
    expect(out.length).toBe(140);
  });

  it("clamps one char over the limit (141 -> 140 + ellipsis)", () => {
    const part: ToolUiPart = {
      type: "tool-Search_web_search",
      state: "input-available",
      input: { query: "a".repeat(141) },
    };
    const out = toolInputSummary(part)!;
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(141);
    expect(out).toBe("a".repeat(140) + "…");
  });

  it("clamps a long value to ~140 chars with an ellipsis", () => {
    const long = "a".repeat(300);
    const part: ToolUiPart = {
      type: "tool-Search_web_search",
      state: "input-available",
      input: { query: long },
    };
    const out = toolInputSummary(part)!;
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(141);
  });

  it("collapses newlines and repeated spaces to single spaces", () => {
    const part: ToolUiPart = {
      type: "tool-Search_web_search",
      state: "input-available",
      input: { query: "  foo\n\n  bar   baz  " },
    };
    expect(toolInputSummary(part)).toBe("foo bar baz");
  });

  it("returns undefined with no input", () => {
    expect(
      toolInputSummary({ type: "tool-x", state: "input-available" }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty object input", () => {
    expect(
      toolInputSummary({
        type: "tool-x",
        state: "input-available",
        input: {},
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a non-object input", () => {
    expect(
      toolInputSummary({
        type: "tool-x",
        state: "input-available",
        input: "just a string",
      }),
    ).toBeUndefined();
  });

  it("returns undefined while the input is still streaming (even with a full input)", () => {
    const part: ToolUiPart = {
      type: "tool-Search_web_search",
      state: "input-streaming",
      input: { query: "hello world" },
    };
    expect(toolInputSummary(part)).toBeUndefined();
  });
});

describe("toolRunState", () => {
  it('maps "output-error" to error', () => {
    expect(toolRunState("output-error")).toBe("error");
  });

  it('maps "output-denied" to error', () => {
    expect(toolRunState("output-denied")).toBe("error");
  });

  it('maps "output-available" to done', () => {
    expect(toolRunState("output-available")).toBe("done");
  });

  it('maps "input-available" to running', () => {
    expect(toolRunState("input-available")).toBe("running");
  });

  it("maps undefined to running", () => {
    expect(toolRunState(undefined)).toBe("running");
  });
});
