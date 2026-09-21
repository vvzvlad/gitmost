import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { useScrollRestoreOnSwap } from "./hooks/use-scroll-position";

const KEY_PREFIX = "gitmost:scroll-position:";

// NOTE ON SCOPE (F2 — reviewer-approved lighter variant).
//
// The real UX wiring lives in the exported `useScrollRestoreOnSwap` hook (two
// useLayoutEffects around useScrollPosition), which PageEditor calls with the
// same signature. A FULL PageEditor component test is impractical here and has no
// precedent in this client: PageEditor directly constructs a
// HocuspocusProviderWebsocket + IndexeddbPersistence, a tiptap `useEditor` with
// collab extensions, reads jotai atoms, react-router params, the shared
// `queryClient` from main.tsx, i18n, and mounts ~12 editor menu children. Worse,
// the static->live swap (`showStatic` -> false) is gated on
// `isCollabSynced(status, isLocalSynced && isRemoteSynced)`, which can only flip
// by driving the mocked collab provider's async sync callbacks. The heaviest
// component-test precedent in the repo (comment-hover-preview.test.tsx) mounts a
// single leaf component with ONE mocked query; nothing mounts a feature root of
// this weight. Reproducing all of that would test the mocks, not the wiring.
//
// So this file tests the REAL `useScrollRestoreOnSwap` hook — the exact code
// PageEditor imports and calls — driving its `showStatic`/`editor` inputs the way
// the swap does. Because it exercises the real hook (not a copy), dropping the
// `&& editor` guard or changing the effect deps makes these tests fail; they
// guard the production code directly (verified: removing `&& editor` reddens the
// first test).
//
// Both tests observe the real effect via `window.scrollTo`. The stubbed
// `window.scrollTo` never mutates `window.scrollY`, and the target is left
// unreached, so every restore invocation that passes the guard yields exactly one
// `scrollTo` call — making the call count a faithful proxy for restore invocations.

function setScrollY(value: number): void {
  Object.defineProperty(window, "scrollY", { configurable: true, value });
}
function setScrollHeight(value: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value,
  });
}
function setInnerHeight(value: number): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value });
}

// Minimal stand-in for the tiptap editor: the hook only truthiness-checks it.
const fakeEditor = { id: "editor" } as unknown as Editor;

// Thin host that calls the REAL hook so a rerender drives showStatic/editor
// exactly like the page-editor swap does.
function Host({
  pageId,
  showStatic,
  editor,
}: {
  pageId: string;
  showStatic: boolean;
  editor: Editor | null;
}) {
  useScrollRestoreOnSwap(pageId, editor, showStatic);
  return null;
}

describe("PageEditor scroll-restore wiring (useScrollRestoreOnSwap)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setScrollY(0);
    setScrollHeight(0);
    setInnerHeight(800);
    window.scrollTo = vi.fn();
    window.location.hash = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.location.hash = "";
  });

  it("re-invokes restore after the swap, with the [showStatic, editor] deps/guard", () => {
    // Target is immediately reachable, so each restore that passes the guard
    // scrolls synchronously. `window.scrollY` stays 0 (stubbed scrollTo never
    // updates it), so scrollTo is called once per effective restore — a proxy for
    // the restore invocation count.
    window.sessionStorage.setItem(`${KEY_PREFIX}guard`, "500");
    setInnerHeight(800);
    setScrollHeight(2000); // maxScroll = 1200 >= 500: reachable, no polling.

    // Pre-swap: static content shown, live editor not ready. Only the early
    // pre-paint restore fires; the post-swap effect's guard (!showStatic) blocks it.
    const { rerender } = render(
      <Host pageId="guard" showStatic={true} editor={null} />,
    );
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    // Collab reports synced (showStatic flips false) but the editor is not ready
    // yet: the swap effect re-runs (deps [showStatic, editor] changed) but the
    // `&& editor` guard must keep it a no-op. The early effect does NOT re-fire
    // (its dep [restoreScrollPosition] is a stable useCallback([])).
    // (Pins the guard: dropping `&& editor` would restore against a null editor,
    // producing a 2nd scrollTo and failing this expectation.)
    rerender(<Host pageId="guard" showStatic={false} editor={null} />);
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    // The static -> live swap completes (showStatic false AND editor present): the
    // post-swap effect re-asserts the restore exactly once more, driven solely by
    // the [showStatic, editor] deps changing.
    rerender(<Host pageId="guard" showStatic={false} editor={fakeEditor} />);
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
  });

  it("the post-swap re-assert drives a REAL restore (window.scrollTo) via the hook", () => {
    // End-to-end through the real useScrollPosition (inside the hook): the swap
    // re-invocation is the CAUSE of the scroll (nothing scrolls before it).
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}peg`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700: target not reachable yet -> polls.

    // Pre-swap: the early restore runs but content is too short, so it starts
    // polling (a pending timer) without scrolling. We never advance timers, so the
    // early poll cannot fire on its own — isolating the swap as the sole cause.
    const { rerender } = render(
      <Host pageId="peg" showStatic={true} editor={null} />,
    );
    expect(window.scrollTo).not.toHaveBeenCalled();

    // The live content is now laid out tall enough to reach the target.
    setScrollHeight(2000); // maxScroll = 1200 >= 500

    // The static -> live swap: the post-swap useLayoutEffect re-invokes the real
    // hook, whose synchronous tryRestore now reaches the target and scrolls.
    act(() => {
      rerender(<Host pageId="peg" showStatic={false} editor={fakeEditor} />);
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });
});
