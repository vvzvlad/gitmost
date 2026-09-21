import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";

/**
 * #564 guard 5 — when the body is showing an un-reconciled LOCAL copy and the
 * collab room is Disconnected, the "offline" banner must cover the WHOLE page,
 * chrome included: the title/icon come from the phase-1 meta cache (possibly
 * NEWER) while the body comes from the ydoc (possibly OLDER), so chrome without
 * an indicator would look authoritative.
 *
 * The children (page editor, title editor, toolbars) are stubbed: what is under
 * test is that FullEditor renders the banner from `bodyLocalOnlyAtom` ABOVE the
 * title, not what those children do.
 */

vi.mock("@/features/editor/page-editor", () => ({
  default: () => <div data-testid="page-editor" />,
}));
vi.mock("@/features/editor/title-editor", () => ({
  TitleEditor: () => <div data-testid="title-editor" />,
}));
vi.mock("@/features/editor/components/fixed-toolbar/fixed-toolbar", () => ({
  FixedToolbar: () => null,
}));
vi.mock("@/features/page/trash/components/deleted-page-banner.tsx", () => ({
  DeletedPageBanner: () => null,
}));
vi.mock("@/features/page/components/temporary-note-banner.tsx", () => ({
  TemporaryNoteBanner: () => null,
}));
vi.mock(
  "@/features/editor/components/fixed-toolbar/groups/dictation-group",
  () => ({
    DictationGroup: () => null,
  }),
);
vi.mock(
  "@/features/editor/components/fixed-toolbar/groups/generate-title-group",
  () => ({ GenerateTitleGroup: () => null }),
);
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { FullEditor } from "./full-editor";
import { bodyLocalOnlyAtom } from "@/features/editor/atoms/editor-atoms";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

function renderFullEditor(store: ReturnType<typeof createStore>) {
  return render(
    <MantineProvider>
      <Provider store={store}>
        <FullEditor
          pageId="page-1"
          slugId="slug-1"
          title="Title"
          content=""
          spaceSlug="space"
          editable
        />
      </Provider>
    </MantineProvider>,
  );
}

function storeWithUser() {
  const store = createStore();
  store.set(currentUserAtom, {
    user: { id: "u-1", name: "Tester", settings: {} },
    workspace: { id: "w-1" },
  } as never);
  return store;
}

beforeEach(() => {
  localStorage.clear();
});

describe("#564 guard 5: page-wide offline banner", () => {
  it("is absent while the body is reconciled (or still connecting)", () => {
    const store = storeWithUser();
    renderFullEditor(store);
    expect(screen.queryByTestId("page-offline-banner")).toBeNull();
  });

  it("covers the chrome (renders above the title) once the body is local-only + offline", () => {
    const store = storeWithUser();
    store.set(bodyLocalOnlyAtom, { isOffline: true });
    const { container } = renderFullEditor(store);

    const banner = screen.getByTestId("page-offline-banner");
    expect(banner).not.toBeNull();
    expect(banner.getAttribute("role")).toBe("status");

    // Above the title editor in document order => it covers the page chrome.
    const title = screen.getByTestId("title-editor");
    expect(
      banner.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).toContain("offline");
  });
});
