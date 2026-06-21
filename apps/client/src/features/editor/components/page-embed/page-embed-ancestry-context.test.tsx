import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PageEmbedAncestryProvider,
  usePageEmbedAncestry,
  isPageEmbedCycle,
  isPageEmbedTooDeep,
  PAGE_EMBED_MAX_DEPTH,
} from "./page-embed-ancestry-context";

/**
 * Tiny probe that renders the current ancestry context as serialized data
 * attributes so tests can assert the accumulated chain / threaded hostPageId
 * without mounting the heavy Tiptap node view.
 */
function AncestryProbe({ testId = "probe" }: { testId?: string }) {
  const { chain, hostPageId } = usePageEmbedAncestry();
  return (
    <span
      data-testid={testId}
      data-chain={chain.join(",")}
      data-chain-length={String(chain.length)}
      data-host={hostPageId ?? ""}
    />
  );
}

describe("PageEmbedAncestryProvider", () => {
  it("defaults to an empty chain and null host with no provider", () => {
    render(<AncestryProbe />);
    const probe = screen.getByTestId("probe");
    expect(probe.getAttribute("data-chain")).toBe("");
    expect(probe.getAttribute("data-chain-length")).toBe("0");
    expect(probe.getAttribute("data-host")).toBe("");
  });

  it("accumulates sourcePageId into the chain across nested providers", () => {
    render(
      <PageEmbedAncestryProvider sourcePageId="a" hostPageId="host">
        <PageEmbedAncestryProvider sourcePageId="b">
          <PageEmbedAncestryProvider sourcePageId="c">
            <AncestryProbe />
          </PageEmbedAncestryProvider>
        </PageEmbedAncestryProvider>
      </PageEmbedAncestryProvider>,
    );
    const probe = screen.getByTestId("probe");
    // Chain is built outermost -> innermost.
    expect(probe.getAttribute("data-chain")).toBe("a,b,c");
    expect(probe.getAttribute("data-chain-length")).toBe("3");
  });

  it("threads the host page id from the outermost provider down the tree", () => {
    render(
      <PageEmbedAncestryProvider sourcePageId="a" hostPageId="host-page">
        <PageEmbedAncestryProvider sourcePageId="b" hostPageId="ignored">
          <AncestryProbe />
        </PageEmbedAncestryProvider>
      </PageEmbedAncestryProvider>,
    );
    const probe = screen.getByTestId("probe");
    // The first host wins (parent.hostPageId ?? hostPageId); deeper hosts are
    // ignored so the original host is preserved for self-embed detection.
    expect(probe.getAttribute("data-host")).toBe("host-page");
  });

  it("does not add an entry to the chain when sourcePageId is missing", () => {
    render(
      <PageEmbedAncestryProvider sourcePageId="a" hostPageId="host">
        <PageEmbedAncestryProvider sourcePageId={null}>
          <PageEmbedAncestryProvider>
            <AncestryProbe />
          </PageEmbedAncestryProvider>
        </PageEmbedAncestryProvider>
      </PageEmbedAncestryProvider>,
    );
    const probe = screen.getByTestId("probe");
    // null / undefined sources are pass-through: chain stays ["a"], host kept.
    expect(probe.getAttribute("data-chain")).toBe("a");
    expect(probe.getAttribute("data-host")).toBe("host");
  });

  it("adopts a host provided only at a deeper level when the root had none", () => {
    render(
      <PageEmbedAncestryProvider sourcePageId="a">
        <PageEmbedAncestryProvider sourcePageId="b" hostPageId="late-host">
          <AncestryProbe />
        </PageEmbedAncestryProvider>
      </PageEmbedAncestryProvider>,
    );
    const probe = screen.getByTestId("probe");
    expect(probe.getAttribute("data-host")).toBe("late-host");
  });
});

describe("isPageEmbedCycle", () => {
  it("is false when the source is not in the chain and is not the host", () => {
    expect(isPageEmbedCycle(["a", "b"], "host", "c")).toBe(false);
  });

  it("is true when the source is already present in the ancestor chain", () => {
    expect(isPageEmbedCycle(["a", "b", "c"], "host", "b")).toBe(true);
  });

  it("is true for a top-level self-embed (host === source, empty chain)", () => {
    expect(isPageEmbedCycle([], "self", "self")).toBe(true);
  });

  it("is true when the source equals the host even mid-chain", () => {
    expect(isPageEmbedCycle(["x"], "self", "self")).toBe(true);
  });

  it("is false when there is no source id (nothing to embed yet)", () => {
    expect(isPageEmbedCycle(["a"], "host", null)).toBe(false);
    expect(isPageEmbedCycle([], "host", "")).toBe(false);
  });

  it("is false when host is null and source is not in the chain", () => {
    expect(isPageEmbedCycle(["a", "b"], null, "c")).toBe(false);
  });
});

describe("isPageEmbedTooDeep", () => {
  it("is false below the max depth", () => {
    expect(isPageEmbedTooDeep([])).toBe(false);
    expect(
      isPageEmbedTooDeep(new Array(PAGE_EMBED_MAX_DEPTH - 1).fill("x")),
    ).toBe(false);
  });

  it("is true once the chain length reaches the max depth", () => {
    expect(
      isPageEmbedTooDeep(new Array(PAGE_EMBED_MAX_DEPTH).fill("x")),
    ).toBe(true);
  });

  it("is true when the chain length exceeds the max depth", () => {
    expect(
      isPageEmbedTooDeep(new Array(PAGE_EMBED_MAX_DEPTH + 3).fill("x")),
    ).toBe(true);
  });

  it("guards at exactly PAGE_EMBED_MAX_DEPTH (=5)", () => {
    // Pin the documented constant so an accidental change is caught.
    expect(PAGE_EMBED_MAX_DEPTH).toBe(5);
    expect(isPageEmbedTooDeep(["1", "2", "3", "4"])).toBe(false);
    expect(isPageEmbedTooDeep(["1", "2", "3", "4", "5"])).toBe(true);
  });
});
