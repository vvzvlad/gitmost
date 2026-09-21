import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTitleAutofocus } from "./use-title-autofocus";

const KEY_PREFIX = "gitmost:scroll-position:";

function fakeEditor(overrides = {}) {
  return { isInitialized: true, commands: { focus: vi.fn() }, ...overrides } as any;
}

describe("useTitleAutofocus", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips auto-focus when a saved reading position exists", () => {
    window.sessionStorage.setItem(`${KEY_PREFIX}saved`, "500");
    const editor = fakeEditor();
    renderHook(() => useTitleAutofocus(editor, "saved"));
    act(() => vi.advanceTimersByTime(300));
    expect(editor.commands.focus).not.toHaveBeenCalled();
  });

  it("auto-focuses a new page (no saved position) with scrollIntoView: false", () => {
    const editor = fakeEditor();
    renderHook(() => useTitleAutofocus(editor, "fresh"));
    act(() => vi.advanceTimersByTime(300));
    expect(editor.commands.focus).toHaveBeenCalledWith("end", { scrollIntoView: false });
  });

  it("does not focus before initialization", () => {
    const editor = fakeEditor({ isInitialized: false });
    renderHook(() => useTitleAutofocus(editor, "fresh2"));
    act(() => vi.advanceTimersByTime(300));
    expect(editor.commands.focus).not.toHaveBeenCalled();
  });

  it("cancels the pending focus on unmount", () => {
    const editor = fakeEditor();
    const { unmount } = renderHook(() => useTitleAutofocus(editor, "fresh3"));
    unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(editor.commands.focus).not.toHaveBeenCalled();
  });
});
