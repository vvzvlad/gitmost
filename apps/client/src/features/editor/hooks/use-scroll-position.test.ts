import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollPosition } from "./use-scroll-position";

const KEY_PREFIX = "gitmost:scroll-position:";

function setScrollY(value: number): void {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value,
  });
}

function setScrollHeight(value: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value,
  });
}

function setInnerHeight(value: number): void {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value,
  });
}

describe("useScrollPosition", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setScrollY(0);
    setScrollHeight(0);
    setInnerHeight(800);
    // jsdom does not implement window.scrollTo; stub it.
    window.scrollTo = vi.fn();
    // Ensure no anchor leaks between tests.
    window.location.hash = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.location.hash = "";
  });

  it("(a) saves window.scrollY to sessionStorage under the pageId key, throttled", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useScrollPosition("p1"));

    // Leading-edge save fires immediately.
    setScrollY(123);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}p1`)).toBe("123");

    // Within the throttle window the next scroll is suppressed.
    setScrollY(456);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}p1`)).toBe("123");

    // After the throttle window elapses, the next scroll persists again.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    setScrollY(789);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}p1`)).toBe("789");

    unmount();
  });

  it("(a2) the restore target is captured at mount and survives a fresh scroll@0 clobber", () => {
    vi.useFakeTimers();
    // A previous session saved 500.
    window.sessionStorage.setItem(`${KEY_PREFIX}clob`, "500");

    const { result } = renderHook(() => useScrollPosition("clob"));

    // On load the page is at the top; a scroll@0 fires and overwrites storage
    // with 0. This is exactly the clobber the synchronous mount-capture defends
    // against: the stored value becomes "0", but the target was already captured.
    setScrollY(0);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}clob`)).toBe("0");

    // Restore still scrolls to 500 (the captured target), NOT the clobbered 0.
    // If the capture were moved into an effect (after handlers register), it
    // would read the clobbered 0 and this assertion would fail.
    setScrollHeight(2000); // maxScroll = 1200 >= 500
    act(() => {
      result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("(a3) restores at most once per mount even if called again", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}once`, "500");
    setScrollHeight(2000); // tall enough to restore synchronously

    const { result } = renderHook(() => useScrollPosition("once"));
    act(() => {
      result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    // A second call (e.g. the wiring effect re-running on [showStatic, editor,
    // restoreScrollPosition]) must NOT scroll again and yank the reader.
    act(() => {
      result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("(b) does not restore when the URL has a #hash anchor", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p2`, "500");
    // Content is ALREADY tall enough (maxScroll = 2000 - 800 = 1200 >= 500), so
    // without the hash guard tryRestore would call scrollTo synchronously on the
    // first tick. The assertion below therefore genuinely proves the hash guard
    // short-circuits before any scroll (not just that the poll has not fired).
    setScrollHeight(2000);
    window.location.hash = "#some-heading";

    const { result } = renderHook(() => useScrollPosition("p2"));
    act(() => {
      result.current.restoreScrollPosition();
      vi.advanceTimersByTime(5000);
    });

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(f) cancels the in-flight restore poll on unmount (no scroll on the next page)", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p7`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700: target not reachable yet, so it polls.

    const { result, unmount } = renderHook(() => useScrollPosition("p7"));
    act(() => {
      result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).not.toHaveBeenCalled(); // still polling

    // Navigate away (the hook unmounts) BEFORE the content grows tall enough.
    unmount();

    // Content of the NEXT page becomes tall; advancing time must NOT resurrect
    // the cancelled poll (without the cleanup it would scroll the new page).
    setScrollHeight(2000);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(c) does nothing when nothing is saved or the saved value is <= 0", () => {
    // Nothing saved.
    const a = renderHook(() => useScrollPosition("nope"));
    act(() => {
      a.result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).not.toHaveBeenCalled();

    // Saved value <= 0.
    window.sessionStorage.setItem(`${KEY_PREFIX}zero`, "0");
    const b = renderHook(() => useScrollPosition("zero"));
    act(() => {
      b.result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(d) scrolls to the saved Y once the content is tall enough", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p4`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700, target not yet reachable.

    const { result } = renderHook(() => useScrollPosition("p4"));
    act(() => {
      result.current.restoreScrollPosition();
    });

    // Still polling: content not laid out yet.
    expect(window.scrollTo).not.toHaveBeenCalled();

    // Content becomes tall enough: maxScroll = 2000 - 800 = 1200 >= 500.
    setScrollHeight(2000);
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("(d2) clamps to the max reachable position after the timeout", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p5`, "5000");
    setInnerHeight(800);
    setScrollHeight(1000); // maxScroll stays 200, never reaches 5000.

    const { result } = renderHook(() => useScrollPosition("p5"));
    act(() => {
      result.current.restoreScrollPosition();
    });

    // Advance past the 5s timeout; restore should fire clamped to maxScroll.
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 200, behavior: "auto" });
  });

  it("(e) never throws when storage access throws", () => {
    const err = new Error("storage denied");
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw err;
    });
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw err;
    });

    expect(() => {
      const { result, unmount } = renderHook(() => useScrollPosition("p6"));
      act(() => {
        setScrollY(42);
        window.dispatchEvent(new Event("scroll"));
        result.current.restoreScrollPosition();
      });
      unmount();
    }).not.toThrow();
  });
});
