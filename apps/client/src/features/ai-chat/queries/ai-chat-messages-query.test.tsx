import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// react-i18next / notifications are pulled in transitively by ai-chat-query.ts
// (the mutation hooks use them); stub so the module imports cleanly.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

// Mock the service module; only getAiChatMessages is exercised, but the other
// named exports must exist so ai-chat-query.ts imports resolve.
vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  getAiChatMessages: vi.fn(),
  getAiChats: vi.fn(),
  getAiRoleCatalog: vi.fn(),
  getAiRoleCatalogBundle: vi.fn(),
  getAiRoles: vi.fn(),
  importAiRolesFromCatalog: vi.fn(),
  createAiRole: vi.fn(),
  deleteAiChat: vi.fn(),
  deleteAiRole: vi.fn(),
  renameAiChat: vi.fn(),
  updateAiRole: vi.fn(),
  updateAiRoleFromCatalog: vi.fn(),
}));

import { getAiChatMessages } from "@/features/ai-chat/services/ai-chat-service.ts";
import { useAiChatMessagesQuery } from "@/features/ai-chat/queries/ai-chat-query.ts";

const emptyPage = { items: [], meta: { hasNextPage: false, nextCursor: null } };

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

// The degraded-poll fallback (#184 phase 1.5) is threaded into this query as a
// `refetchInterval`; AiChatWindow supplies the deliberately-dumb callback. These
// pin the plumbing the window depends on: the interval polls the message history,
// and — critically — fetch ERRORS do NOT stop the tick (TanStack v5 resets the
// failure count each fetch, so the poll must survive a server restart).
describe("useAiChatMessagesQuery — degraded refetchInterval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-polls at the interval while the callback returns a duration", async () => {
    vi.mocked(getAiChatMessages).mockResolvedValue(emptyPage as never);
    renderHook(() => useAiChatMessagesQuery("c1", () => 30), {
      wrapper: createWrapper(),
    });
    await waitFor(() =>
      expect(vi.mocked(getAiChatMessages).mock.calls.length).toBeGreaterThan(2),
    );
  });

  it("does NOT re-poll when the callback returns false", async () => {
    vi.mocked(getAiChatMessages).mockResolvedValue(emptyPage as never);
    renderHook(() => useAiChatMessagesQuery("c1", () => false), {
      wrapper: createWrapper(),
    });
    await waitFor(() =>
      expect(vi.mocked(getAiChatMessages)).toHaveBeenCalledTimes(1),
    );
    // Give any errant interval a chance to fire, then assert it did not.
    await new Promise((r) => setTimeout(r, 60));
    expect(vi.mocked(getAiChatMessages)).toHaveBeenCalledTimes(1);
  });

  it("keeps ticking through fetch errors (errors do not gate the poll)", async () => {
    vi.mocked(getAiChatMessages).mockRejectedValue(new Error("server down"));
    renderHook(() => useAiChatMessagesQuery("c1", () => 30), {
      wrapper: createWrapper(),
    });
    await waitFor(() =>
      expect(vi.mocked(getAiChatMessages).mock.calls.length).toBeGreaterThan(2),
    );
  });
});
