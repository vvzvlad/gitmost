import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { TableOfContents } from "./table-of-contents";

// #662 gotcha 2: a persisted `toc` tab can be restored open on reload BEFORE the
// editor mounts, so TableOfContents renders with editor={null}. Previously that
// path hit `Array.from(undefined)` (recalculateLinks over `$nodes(...)` on a null
// editor) and threw into the root ChunkLoadErrorBoundary — an inescapable reload
// loop. It must now render nothing (no crash, no misleading "Add headings" state)
// until the editor arrives.

function renderToc(editor: unknown, isShare?: boolean) {
  // Wrap ONLY the component so the emptiness assertion excludes the global
  // <style> MantineProvider injects as a sibling into the render container.
  return render(
    <MantineProvider>
      <div data-testid="toc-root">
        <TableOfContents editor={editor as never} isShare={isShare} />
      </div>
    </MantineProvider>,
  );
}

// Minimal editor stub: enough surface for the mount-time rescan + the on/off
// subscription. `$nodes` returns the given heading NodePos-likes.
function fakeEditor(nodes: unknown[] = []) {
  return {
    on: () => {},
    off: () => {},
    $nodes: () => nodes,
  };
}

describe("TableOfContents editor={null} (restored toc tab before editor mount)", () => {
  afterEach(cleanup);

  it("renders nothing and does NOT throw with a null editor", () => {
    renderToc(null);
    // Null editor -> the early `if (!props.editor) return null` guard: empty
    // output, and specifically NOT the "Add headings…" empty state (which would
    // falsely claim the page has no headings before the editor arrives).
    expect(screen.getByTestId("toc-root").textContent).toBe("");
    expect(
      screen.queryByText(
        "Add headings (H1, H2, H3) to generate a table of contents.",
      ),
    ).toBeNull();
  });

  it("does not throw when the editor mounts later with no headings (empty-state)", () => {
    // Once a real editor exists but has no headings, the non-share empty state
    // renders — proving the null-guard is specific to the pre-mount window, not a
    // blanket suppression.
    renderToc(fakeEditor([]));
    expect(
      screen.getByText(
        "Add headings (H1, H2, H3) to generate a table of contents.",
      ),
    ).toBeTruthy();
  });

  it("share mode with a null editor also renders nothing (share-shell restore)", () => {
    renderToc(null, true);
    expect(screen.getByTestId("toc-root").textContent).toBe("");
    expect(screen.queryByText("No table of contents.")).toBeNull();
  });
});
