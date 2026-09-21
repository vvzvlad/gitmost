import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";

// Mock the app entry so importing the hook doesn't boot the whole app; the hook
// only needs queryClient's cache read/write, which we stub here. Declared via
// vi.hoisted so the spies exist before the hoisted vi.mock factory runs.
const { getQueryData, setQueryData } = vi.hoisted(() => ({
  getQueryData: vi.fn(() => undefined as unknown),
  setQueryData: vi.fn(),
}));
vi.mock("@/main.tsx", () => ({
  queryClient: { getQueryData, setQueryData },
}));

import { usePageContentCache } from "./use-page-content-cache";

const SNAPSHOT = { type: "doc", content: [] };

function makeFakeEditor(overrides: Partial<Editor> = {}): Editor {
  return {
    isEmpty: false,
    isDestroyed: false,
    getJSON: vi.fn(() => SNAPSHOT),
    ...overrides,
  } as unknown as Editor;
}

describe("usePageContentCache (#343 PART 3) — getJSON off the keystroke path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // A cached page exists so the write path runs.
    getQueryData.mockReturnValue({ id: "p1", content: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("onUpdate (calling the debounced fn) does NOT call getJSON synchronously", () => {
    const editor = makeFakeEditor();
    const editorRef = { current: editor } as MutableRefObject<Editor | null>;

    const { result } = renderHook(() =>
      usePageContentCache(editorRef, "slug-1", 3000),
    );

    // Simulate a keystroke's onUpdate -> only schedules the debounce.
    act(() => {
      result.current();
      result.current();
      result.current();
    });

    // The whole-doc serialization must NOT have happened yet.
    expect(editor.getJSON).not.toHaveBeenCalled();
    expect(setQueryData).not.toHaveBeenCalled();

    // Once the debounce window elapses, getJSON runs exactly once (not per call).
    act(() => vi.advanceTimersByTime(3000));
    expect(editor.getJSON).toHaveBeenCalledTimes(1);
    expect(setQueryData).toHaveBeenCalledWith(["pages", "slug-1"], {
      id: "p1",
      content: SNAPSHOT,
    });
  });

  it("flushes the pending snapshot on unmount so the last edit isn't lost", () => {
    const editor = makeFakeEditor();
    const editorRef = { current: editor } as MutableRefObject<Editor | null>;

    const { result, unmount } = renderHook(() =>
      usePageContentCache(editorRef, "slug-1", 3000),
    );

    act(() => result.current());
    expect(editor.getJSON).not.toHaveBeenCalled();

    // Navigation/unmount must flush (not drop) the pending write.
    act(() => unmount());
    expect(editor.getJSON).toHaveBeenCalledTimes(1);
    expect(setQueryData).toHaveBeenCalledTimes(1);
  });

  it("skips the write when the editor is destroyed (flush racing teardown)", () => {
    const editor = makeFakeEditor({ isDestroyed: true });
    const editorRef = { current: editor } as MutableRefObject<Editor | null>;

    const { result } = renderHook(() =>
      usePageContentCache(editorRef, "slug-1", 3000),
    );

    act(() => result.current());
    act(() => vi.advanceTimersByTime(3000));

    expect(editor.getJSON).not.toHaveBeenCalled();
    expect(setQueryData).not.toHaveBeenCalled();
  });
});
