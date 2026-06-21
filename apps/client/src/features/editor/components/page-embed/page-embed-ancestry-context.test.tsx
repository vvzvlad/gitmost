import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PageEmbedAncestryProvider,
  usePageEmbedAncestry,
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
