import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  PageEmbedAncestryProvider,
  usePageEmbedAncestry,
} from "./page-embed-ancestry-context";

// Probe child: renders the current ancestry context value as JSON so the test
// can assert on the accumulated chain and host without any Tiptap editor.
function Probe({ testId }: { testId: string }) {
  const ancestry = usePageEmbedAncestry();
  return <div data-testid={testId}>{JSON.stringify(ancestry)}</div>;
}

function read(el: HTMLElement) {
  return JSON.parse(el.textContent || "{}") as {
    chain: string[];
    hostPageId: string | null;
  };
}

describe("PageEmbedAncestryProvider", () => {
  it("accumulates the chain in order across nested providers", () => {
    const { getByTestId } = render(
      <PageEmbedAncestryProvider sourcePageId="a" hostPageId="host">
        <PageEmbedAncestryProvider sourcePageId="b">
          <PageEmbedAncestryProvider sourcePageId="c">
            <Probe testId="leaf" />
          </PageEmbedAncestryProvider>
        </PageEmbedAncestryProvider>
      </PageEmbedAncestryProvider>,
    );
    const value = read(getByTestId("leaf"));
    expect(value.chain).toEqual(["a", "b", "c"]);
    expect(value.hostPageId).toBe("host");
  });

  it("leaves the chain unchanged when sourcePageId is absent, still propagating the host", () => {
    const { getByTestId } = render(
      <PageEmbedAncestryProvider sourcePageId="a" hostPageId="host">
        <PageEmbedAncestryProvider>
          <Probe testId="leaf" />
        </PageEmbedAncestryProvider>
      </PageEmbedAncestryProvider>,
    );
    const value = read(getByTestId("leaf"));
    expect(value.chain).toEqual(["a"]);
    expect(value.hostPageId).toBe("host");
  });

  it("keeps the first (top-level) host even if an inner provider passes a different one", () => {
    const { getByTestId } = render(
      <PageEmbedAncestryProvider sourcePageId="a" hostPageId="top-host">
        <PageEmbedAncestryProvider sourcePageId="b" hostPageId="inner-host">
          <Probe testId="leaf" />
        </PageEmbedAncestryProvider>
      </PageEmbedAncestryProvider>,
    );
    const value = read(getByTestId("leaf"));
    expect(value.chain).toEqual(["a", "b"]);
    // Inner host is ignored: the top-level host is set once and propagated.
    expect(value.hostPageId).toBe("top-host");
  });

  it("defaults to an empty chain and null host with no provider", () => {
    const { getByTestId } = render(<Probe testId="leaf" />);
    const value = read(getByTestId("leaf"));
    expect(value.chain).toEqual([]);
    expect(value.hostPageId).toBeNull();
  });
});
