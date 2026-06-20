import { describe, it, expect } from "vitest";
import {
  toolCitations,
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
