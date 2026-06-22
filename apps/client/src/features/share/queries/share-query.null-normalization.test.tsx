import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";

// React Query forbids `undefined` as resolved query data ("Query data cannot be
// undefined"). The backend resolves to `undefined` when a page has no share, so
// `useShareForPageQuery` normalizes that absence to `null`:
//   queryFn: async () => (await getShareForPage(pageId)) ?? null
// These tests pin that contract: the hook must resolve to `null` (never
// `undefined`) when there is no share, and pass a real share through untouched.

// Mock the service module so the queryFn calls our stub instead of the network.
vi.mock("@/features/share/services/share-service.ts", () => ({
  getShareForPage: vi.fn(),
  // Other named exports referenced by share-query.ts must exist on the mock so
  // the module import resolves; they are unused by these tests.
  createShare: vi.fn(),
  deleteShare: vi.fn(),
  getSharedPageTree: vi.fn(),
  getShareInfo: vi.fn(),
  getSharePageInfo: vi.fn(),
  getShares: vi.fn(),
  updateShare: vi.fn(),
}));

import { getShareForPage } from "@/features/share/services/share-service.ts";
import { useShareForPageQuery } from "@/features/share/queries/share-query.ts";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useShareForPageQuery — null normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes an absent share (undefined) to null", async () => {
    vi.mocked(getShareForPage).mockResolvedValue(undefined as any);

    const { result } = renderHook(() => useShareForPageQuery("page-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The key assertion: null, never undefined.
    expect(result.current.data).toBeNull();
    expect(result.current.data).not.toBeUndefined();
  });

  it("normalizes an absent share (null) to null", async () => {
    vi.mocked(getShareForPage).mockResolvedValue(null as any);

    const { result } = renderHook(() => useShareForPageQuery("page-2"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("passes an existing share through unchanged", async () => {
    const share = { id: "share-1", pageId: "page-3" } as any;
    vi.mocked(getShareForPage).mockResolvedValue(share);

    const { result } = renderHook(() => useShareForPageQuery("page-3"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(share);
  });
});
