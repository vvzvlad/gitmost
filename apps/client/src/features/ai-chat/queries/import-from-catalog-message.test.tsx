import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IAiRoleImportResult } from "@/features/ai-chat/types/ai-chat.types.ts";

// `useImportAiRolesFromCatalogMutation` always shows an Imported/renamed/skipped
// summary, and ADDITIONALLY a red "Failed to import N role(s)" notification when
// the result carries partial errors. These tests pin both branches via
// renderHook with a mocked service (twin precedent:
// update-from-catalog-message.test.tsx).

const notificationsShowMock = vi.fn();
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (opts: unknown) => notificationsShowMock(opts) },
}));

// `t` echoes the key with interpolated values so we assert against the exact
// English message strings (mirrors react-i18next's default interpolation).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars
        ? key.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars[name]))
        : key,
  }),
}));

vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  importAiRolesFromCatalog: vi.fn(),
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
  renameAiChat: vi.fn(),
  updateAiRole: vi.fn(),
  updateAiRoleFromCatalog: vi.fn(),
}));

import { importAiRolesFromCatalog } from "@/features/ai-chat/services/ai-chat-service.ts";
import { useImportAiRolesFromCatalogMutation } from "@/features/ai-chat/queries/ai-chat-query.ts";

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

async function runMutation(result: IAiRoleImportResult) {
  vi.mocked(importAiRolesFromCatalog).mockResolvedValue(result);
  const { result: hook } = renderHook(
    () => useImportAiRolesFromCatalogMutation(),
    { wrapper: createWrapper() },
  );
  hook.current.mutate({
    bundleId: "general",
    language: "en",
    conflict: "rename",
  });
  await waitFor(() => expect(hook.current.isSuccess).toBe(true));
}

describe("useImportAiRolesFromCatalogMutation — success notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("errors:[] -> only the summary notification (counts interpolated)", async () => {
    await runMutation({ created: 3, renamed: 1, skipped: 2, errors: [] });
    expect(notificationsShowMock).toHaveBeenCalledTimes(1);
    expect(notificationsShowMock).toHaveBeenCalledWith({
      message: "Imported 3, renamed 1, skipped 2",
    });
  });

  it("errors.length > 0 -> summary PLUS the red failure notification", async () => {
    await runMutation({
      created: 1,
      renamed: 0,
      skipped: 0,
      errors: [
        { slug: "a", message: "name taken" },
        { slug: "b", message: "name taken" },
      ],
    });
    expect(notificationsShowMock).toHaveBeenCalledTimes(2);
    expect(notificationsShowMock).toHaveBeenNthCalledWith(1, {
      message: "Imported 1, renamed 0, skipped 0",
    });
    expect(notificationsShowMock).toHaveBeenNthCalledWith(2, {
      color: "red",
      message: "Failed to import 2 role(s)",
    });
  });
});
