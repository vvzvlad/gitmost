import { describe, it, expect } from "vitest";
import { decideEmbedState } from "./decide-embed-state";
import { PAGE_EMBED_MAX_DEPTH } from "./page-embed-ancestry-context";
import type { PageTemplateLookup } from "@/features/page-embed/types/page-embed.types";

const okResult: PageTemplateLookup = {
  sourcePageId: "p1",
  slugId: "slug-p1",
  title: "Template",
  icon: null,
  content: { type: "doc" },
  sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
};

describe("decideEmbedState", () => {
  it("returns no_source when sourcePageId is null", () => {
    expect(
      decideEmbedState({
        sourcePageId: null,
        chain: [],
        hostPageId: null,
        available: true,
        result: null,
      }),
    ).toBe("no_source");
  });

  it("returns cycle when sourcePageId is already in the ancestor chain", () => {
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain: ["root", "p1"],
        hostPageId: "host",
        available: true,
        result: okResult,
      }),
    ).toBe("cycle");
  });

  it("returns cycle when sourcePageId equals the host page id (top-level self-embed)", () => {
    expect(
      decideEmbedState({
        sourcePageId: "host",
        chain: [],
        hostPageId: "host",
        available: true,
        result: okResult,
      }),
    ).toBe("cycle");
  });

  it("returns too_deep when chain length reaches PAGE_EMBED_MAX_DEPTH", () => {
    const chain = Array.from({ length: PAGE_EMBED_MAX_DEPTH }, (_, i) => `a${i}`);
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain,
        hostPageId: "host",
        available: true,
        result: okResult,
      }),
    ).toBe("too_deep");
  });

  it("cycle wins over too_deep when both apply (cycle checked first)", () => {
    const chain = Array.from(
      { length: PAGE_EMBED_MAX_DEPTH },
      (_, i) => `a${i}`,
    );
    chain[0] = "p1"; // also a cycle
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain,
        hostPageId: "host",
        available: true,
        result: okResult,
      }),
    ).toBe("cycle");
  });

  it("returns unavailable when no lookup context is mounted", () => {
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain: [],
        hostPageId: "host",
        available: false,
        result: null,
      }),
    ).toBe("unavailable");
  });

  it("returns loading when available but the result is not back yet", () => {
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain: [],
        hostPageId: "host",
        available: true,
        result: null,
      }),
    ).toBe("loading");
  });

  it("returns no_access when the result status is no_access", () => {
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain: [],
        hostPageId: "host",
        available: true,
        result: { sourcePageId: "p1", status: "no_access" },
      }),
    ).toBe("no_access");
  });

  it("returns not_found when the result status is not_found", () => {
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain: [],
        hostPageId: "host",
        available: true,
        result: { sourcePageId: "p1", status: "not_found" },
      }),
    ).toBe("not_found");
  });

  it("returns ok for a resolved template (happy path)", () => {
    expect(
      decideEmbedState({
        sourcePageId: "p1",
        chain: [],
        hostPageId: "host",
        available: true,
        result: okResult,
      }),
    ).toBe("ok");
  });
});
