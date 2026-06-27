import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// matchMedia / storage are stubbed globally in vitest.setup.ts.

// Enabling a public share must NOT silently expose the whole sub-tree (#216):
// the create call defaults includeSubPages to false. This was a one-literal,
// security-relevant default with no test — lock it.

const createMutateAsync = vi.fn(async () => ({}));
const deleteMutateAsync = vi.fn(async () => ({}));

// No existing share for this page (toggle starts OFF).
let shareData: any = undefined;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/share/queries/share-query.ts", () => ({
  useCreateShareMutation: () => ({ mutateAsync: createMutateAsync }),
  useDeleteShareMutation: () => ({ mutateAsync: deleteMutateAsync }),
  useUpdateShareMutation: () => ({ mutateAsync: vi.fn() }),
  useShareForPageQuery: () => ({ data: shareData }),
}));

vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: { id: "page-1", title: "Doc" } }),
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({ data: { settings: {} } }),
}));

import ShareModal from "./share-modal";

function renderModal() {
  return render(
    <MemoryRouter>
      <MantineProvider>
        <ShareModal readOnly={false} />
      </MantineProvider>
    </MemoryRouter>,
  );
}

describe("ShareModal — enabling a share defaults includeSubPages to false (#216)", () => {
  beforeEach(() => {
    createMutateAsync.mockClear();
    deleteMutateAsync.mockClear();
    shareData = undefined;
  });

  it("creates the share with includeSubPages: false when the user turns it on", async () => {
    renderModal();

    // Open the share popover.
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    // The "Share to web" toggle is the only switch in the not-yet-shared state.
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "page-1",
        includeSubPages: false,
      }),
    );
  });
});
