import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { IShareAlias } from "@/features/share/types/share.types";

// matchMedia / storage are stubbed globally in vitest.setup.ts.

// The mutation + query hooks reach react-query/network; the availability probe
// hits the API. Stub them so the section renders in isolation and we can drive
// the exact branches (taken name -> hint, 409 -> reassign modal).
const setMutateAsync = vi.fn();
let currentAlias: IShareAlias | null = null;
let availabilityResult: {
  valid: boolean;
  available: boolean;
  currentPageId: string | null;
} = { valid: true, available: true, currentPageId: null };

vi.mock("@/features/share/queries/share-query.ts", () => ({
  useShareAliasForPageQuery: () => ({ data: currentAlias }),
  useSetShareAliasMutation: () => ({
    mutateAsync: setMutateAsync,
    isPending: false,
  }),
  useRemoveShareAliasMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/features/share/services/share-service.ts", () => ({
  checkShareAliasAvailability: vi.fn(async () => availabilityResult),
}));

import ShareAliasSection from "./share-alias-section";

const aliasRow = (alias: string, pageId: string): IShareAlias => ({
  id: `alias-${alias}`,
  workspaceId: "ws-1",
  alias,
  pageId,
  creatorId: "user-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function renderSection(pageId = "page-Y") {
  return render(
    <MantineProvider>
      <ShareAliasSection pageId={pageId} readOnly={false} />
    </MantineProvider>,
  );
}

describe("ShareAliasSection — taken-name handling is never a dead end", () => {
  beforeEach(() => {
    setMutateAsync.mockReset();
    currentAlias = null;
    availabilityResult = { valid: true, available: true, currentPageId: null };
  });

  it("shows a 'will move it here' HINT (not a terminal error) when the name belongs to another page, and keeps Save enabled", async () => {
    // Page Y already owns "bee"; the user retypes a name owned by page X.
    currentAlias = aliasRow("bee", "page-Y");
    availabilityResult = {
      valid: true,
      available: false,
      currentPageId: "page-X",
    };

    renderSection("page-Y");
    const input = screen.getByPlaceholderText("my-page") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test2" } });

    // The reassign hint replaces the old dead-end red error.
    await waitFor(
      () =>
        expect(
          screen.getByText(
            "This address is in use. Saving will move it to this page.",
          ),
        ).toBeDefined(),
      { timeout: 2000 },
    );
    // The old terminal "already in use" error must NOT be shown.
    expect(screen.queryByText("This address is already in use")).toBeNull();

    // Save stays enabled so the confirm-reassign flow can run.
    const saveBtn = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it("opens the reassign-confirm modal on a 409 ALIAS_REASSIGN_REQUIRED (path forward, not a dead end)", async () => {
    currentAlias = aliasRow("bee", "page-Y");
    availabilityResult = {
      valid: true,
      available: false,
      currentPageId: "page-X",
    };
    // The server rejects the un-confirmed save asking the client to confirm.
    setMutateAsync.mockRejectedValueOnce({
      status: 409,
      response: {
        status: 409,
        data: {
          code: "ALIAS_REASSIGN_REQUIRED",
          currentPageId: "page-X",
          currentPageTitle: "Alias Test Page X",
        },
      },
    });

    renderSection("page-Y");
    const input = screen.getByPlaceholderText("my-page") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test2" } });

    const saveBtn = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false), {
      timeout: 2000,
    });
    fireEvent.click(saveBtn);

    // First save sent WITHOUT confirmReassign.
    await waitFor(() =>
      expect(setMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "test2", confirmReassign: false }),
      ),
    );

    // The "Move custom address?" confirm modal must appear (the path forward).
    await waitFor(() =>
      expect(screen.getByText("Move custom address?")).toBeDefined(),
    );
    expect(screen.getByRole("button", { name: "Move here" })).toBeDefined();

    // Confirming retries WITH confirmReassign: true.
    setMutateAsync.mockResolvedValueOnce(aliasRow("test2", "page-Y"));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() =>
      expect(setMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "test2", confirmReassign: true }),
      ),
    );
  });
});
