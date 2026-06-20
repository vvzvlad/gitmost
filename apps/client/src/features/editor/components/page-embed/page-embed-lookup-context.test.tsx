import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { act, render } from "@testing-library/react";
import type { PageTemplateLookup } from "@/features/page-embed/types/page-embed.types";

// Mock the API module the provider calls. Hoisted by vitest before the import.
const lookupTemplate = vi.fn();
vi.mock("@/features/page-embed/services/page-embed-api", () => ({
  lookupTemplate: (...args: unknown[]) => lookupTemplate(...args),
}));

// Imported AFTER the mock is declared so the provider picks up the mock.
import {
  PageEmbedLookupProvider,
  usePageEmbedLookup,
} from "./page-embed-lookup-context";

function ok(id: string): PageTemplateLookup {
  return {
    sourcePageId: id,
    slugId: `slug-${id}`,
    title: `T-${id}`,
    icon: null,
    content: { type: "doc" },
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// Probe that subscribes to a sourceId and exposes its latest result + refresh.
function Probe({
  id,
  sink,
}: {
  id: string;
  sink: (api: ReturnType<typeof usePageEmbedLookup>) => void;
}) {
  const api = usePageEmbedLookup(id);
  sink(api);
  return <div>{api.result ? "loaded" : "pending"}</div>;
}

describe("PageEmbedLookupProvider (batching / dedup / refresh)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lookupTemplate.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("dedups two subscribers for the same id into a single lookup call; both get the result", async () => {
    let a: ReturnType<typeof usePageEmbedLookup> | null = null;
    let b: ReturnType<typeof usePageEmbedLookup> | null = null;
    lookupTemplate.mockResolvedValue({ items: [ok("p1")] });

    render(
      <PageEmbedLookupProvider>
        <Probe id="p1" sink={(x) => (a = x)} />
        <Probe id="p1" sink={(x) => (b = x)} />
      </PageEmbedLookupProvider>,
    );

    // Subscriptions run in effects + the 10ms debounce batches them together.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(lookupTemplate).toHaveBeenCalledTimes(1);
    expect(lookupTemplate).toHaveBeenCalledWith({ sourcePageIds: ["p1"] });
    expect(a!.result).toEqual(ok("p1"));
    expect(b!.result).toEqual(ok("p1"));
  });

  it("batches two distinct ids subscribed within the window into one call", async () => {
    lookupTemplate.mockResolvedValue({ items: [ok("p1"), ok("p2")] });

    render(
      <PageEmbedLookupProvider>
        <Probe id="p1" sink={() => {}} />
        <Probe id="p2" sink={() => {}} />
      </PageEmbedLookupProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(lookupTemplate).toHaveBeenCalledTimes(1);
    expect(lookupTemplate.mock.calls[0][0]).toEqual({
      sourcePageIds: ["p1", "p2"],
    });
  });

  it("refresh() clears the cache and re-fetches", async () => {
    let a: ReturnType<typeof usePageEmbedLookup> | null = null;
    lookupTemplate.mockResolvedValue({ items: [ok("p1")] });

    render(
      <PageEmbedLookupProvider>
        <Probe id="p1" sink={(x) => (a = x)} />
      </PageEmbedLookupProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(lookupTemplate).toHaveBeenCalledTimes(1);

    // refresh resolves once the next batch flush completes.
    await act(async () => {
      const p = a!.refresh();
      await vi.advanceTimersByTimeAsync(20);
      await p;
    });

    expect(lookupTemplate).toHaveBeenCalledTimes(2);
  });

  it("a rejected lookup resolves refresh() waiters, clears inFlight, and logs the error (not swallowed)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let a: ReturnType<typeof usePageEmbedLookup> | null = null;
    lookupTemplate.mockRejectedValueOnce(new Error("boom"));

    render(
      <PageEmbedLookupProvider>
        <Probe id="p1" sink={(x) => (a = x)} />
      </PageEmbedLookupProvider>,
    );

    // Initial subscription enqueues a lookup that rejects.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(errSpy).toHaveBeenCalled();
    // The error message is surfaced, not swallowed.
    expect(errSpy.mock.calls[0][0]).toContain("[pageEmbed] template lookup failed");

    // inFlight was cleared on failure, so a refresh re-enqueues and resolves.
    lookupTemplate.mockResolvedValueOnce({ items: [ok("p1")] });
    let resolved = false;
    await act(async () => {
      const p = a!.refresh().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(20);
      await p;
    });
    expect(resolved).toBe(true);
    expect(a!.result).toEqual(ok("p1"));

    errSpy.mockRestore();
  });
});
