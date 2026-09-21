import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IAiRoleUpdateFromCatalogResult } from "@/features/ai-chat/types/ai-chat.types.ts";

// `useUpdateAiRoleFromCatalogMutation` maps the server's discriminated result to
// a user-facing notification message. These tests pin each of the four branches
// (updated / not-in-catalog / language-unavailable / up-to-date) via renderHook
// with a mocked service (precedent: share-query.null-normalization.test.tsx).

const notificationsShowMock = vi.fn();
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (opts: unknown) => notificationsShowMock(opts) },
}));

// `t` echoes the key so we assert against the exact English message strings.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  updateAiRoleFromCatalog: vi.fn(),
  // Other named exports referenced by ai-chat-query.ts must exist on the mock so
  // the module import resolves; they are unused by these tests.
  createAiRole: vi.fn(),
  deleteAiChat: vi.fn(),
  deleteAiRole: vi.fn(),
  getAiChatMessages: vi.fn(),
  getAiChats: vi.fn(),
  getAiRoleCatalog: vi.fn(),
  getAiRoleCatalogBundle: vi.fn(),
  getAiRoles: vi.fn(),
  importAiRolesFromCatalog: vi.fn(),
  renameAiChat: vi.fn(),
  updateAiRole: vi.fn(),
}));

import { updateAiRoleFromCatalog } from "@/features/ai-chat/services/ai-chat-service.ts";
import { useUpdateAiRoleFromCatalogMutation } from "@/features/ai-chat/queries/ai-chat-query.ts";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

async function runMutation(result: IAiRoleUpdateFromCatalogResult) {
  vi.mocked(updateAiRoleFromCatalog).mockResolvedValue(result);
  const { result: hook } = renderHook(
    () => useUpdateAiRoleFromCatalogMutation(),
    { wrapper: createWrapper() },
  );
  hook.current.mutate("role-1");
  await waitFor(() => expect(hook.current.isSuccess).toBe(true));
}

describe("useUpdateAiRoleFromCatalogMutation — reason → message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updated:true -> 'Updated to the latest version'", async () => {
    await runMutation({
      updated: true,
      fromVersion: 1,
      toVersion: 2,
      role: { id: "role-1" } as never,
    });
    expect(notificationsShowMock).toHaveBeenCalledWith({
      message: "Updated to the latest version",
    });
  });

  it("not-in-catalog -> 'This role is no longer in the catalog'", async () => {
    await runMutation({ updated: false, reason: "not-in-catalog" });
    expect(notificationsShowMock).toHaveBeenCalledWith({
      message: "This role is no longer in the catalog",
    });
  });

  it("language-unavailable -> 'This language is no longer available in the catalog'", async () => {
    await runMutation({ updated: false, reason: "language-unavailable" });
    expect(notificationsShowMock).toHaveBeenCalledWith({
      message: "This language is no longer available in the catalog",
    });
  });

  it("up-to-date -> 'Already up to date'", async () => {
    await runMutation({ updated: false, reason: "up-to-date" });
    expect(notificationsShowMock).toHaveBeenCalledWith({
      message: "Already up to date",
    });
  });
});
