import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Heavy panel bodies -> inert markers so we can assert mount/no-mount cheaply.
vi.mock("@/features/comment/components/comment-list-with-tabs.tsx", () => ({
  default: () => <div data-testid="comment-list" />,
}));
vi.mock(
  "@/features/editor/components/table-of-contents/table-of-contents.tsx",
  () => ({ TableOfContents: () => <div data-testid="toc" /> }),
);
vi.mock("@/features/page-details/components/page-details-aside.tsx", () => ({
  PageDetailsAside: () => <div data-testid="page-details" />,
}));

// Mantine ScrollArea (the toc/details panel wrapper) constructs a ResizeObserver,
// which jsdom lacks; a no-op stub lets it mount.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import Aside from "./aside";

// #662 #10/#12: the right aside must render the restored tab's content when the
// panel is restored OPEN, but must NOT mount the panel body (comment
// infinite-query / live TOC subscription) while the panel is CLOSED.

function renderAside(state: { tab: string; isAsideOpen: boolean }) {
  const store = createStore();
  store.set(asideStateAtom, state as never);
  render(
    <MantineProvider>
      <Provider store={store}>
        <Aside />
      </Provider>
    </MantineProvider>,
  );
  return { store };
}

describe("Aside — restored-tab render / closed-panel no-mount (#662)", () => {
  afterEach(cleanup);

  it("mounts the comment list when restored open on the comments tab", () => {
    renderAside({ tab: "comments", isAsideOpen: true });
    expect(screen.getByTestId("comment-list")).toBeTruthy();
  });

  it("mounts the TOC when restored open on the toc tab", () => {
    renderAside({ tab: "toc", isAsideOpen: true });
    expect(screen.getByTestId("toc")).toBeTruthy();
  });

  it("does NOT mount the comment list while the panel is closed", () => {
    // commentsOpenedOnce latch never armed -> no infinite-page comment fetch for
    // a closed panel restored on the comments tab.
    renderAside({ tab: "comments", isAsideOpen: false });
    expect(screen.queryByTestId("comment-list")).toBeNull();
  });

  it("does NOT mount the TOC while the panel is closed", () => {
    // The toc body is gated purely on the open state, so a closed panel keeps no
    // live TableOfContents (editor `update` all-headings scan + IntersectionObserver).
    renderAside({ tab: "toc", isAsideOpen: false });
    expect(screen.queryByTestId("toc")).toBeNull();
  });
});
