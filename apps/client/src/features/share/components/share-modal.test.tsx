import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// matchMedia / storage are stubbed globally in vitest.setup.ts.

// Enabling a public share must NOT silently expose the whole sub-tree (#216):
// the create call defaults includeSubPages to false. This was a one-literal,
// security-relevant default with no test — lock it.

const createMutateAsync = vi.fn(async () => ({}));
const deleteMutateAsync = vi.fn(async () => ({}));

// No existing share for this page (toggle starts OFF).
let shareData: any = undefined;

// Partial mock: ShareModal's import graph reaches `src/i18n.ts`, which calls
// `.use(initReactI18next)` at module scope, so the real exports must stay.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// ShareModal transitively imports `@/main.tsx` (via page-history-query), whose
// module scope mounts the React root off `#root` — absent in jsdom. Only its
// `queryClient` export is needed here.
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

vi.mock("@/features/share/queries/share-query.ts", () => ({
  useCreateShareMutation: () => ({ mutateAsync: createMutateAsync }),
  useDeleteShareMutation: () => ({ mutateAsync: deleteMutateAsync }),
  useUpdateShareMutation: () => ({ mutateAsync: vi.fn() }),
  useShareForPageQuery: () => ({ data: shareData }),
}));

vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: { id: "page-1", title: "Doc" } }),
  usePageMetaQuery: () => ({ data: { id: "page-1", title: "Doc" } }),
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({ data: { settings: {} } }),
}));

import ShareModal from "./share-modal";

function renderModal() {
  // ShareModal itself runs `usePageHistoryListQuery` (react-query), so it needs
  // a real QueryClient in context; the share/page/space queries it drives are
  // mocked above.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MantineProvider>
          <ShareModal readOnly={false} />
        </MantineProvider>
      </MemoryRouter>
    </QueryClientProvider>,
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
