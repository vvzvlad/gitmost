import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Editor } from "@tiptap/react";
import { refocusEditorAfterMenuClose } from "./use-column-row-menu-lifecycle";

// A minimal fake editor. `view.dom` is a real element so `.contains()` works,
// and `view.focus` is a spy so we assert on it without relying on real DOM
// focus (unreliable in jsdom). rAF is stubbed to a `setTimeout(0)` so fake
// timers can flush the deferred callback deterministically.
function makeEditor() {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  const focus = vi.fn();
  const editor = { isDestroyed: false, view: { dom, focus } };
  return { editor: editor as unknown as Editor, focus, dom };
}

describe("refocusEditorAfterMenuClose", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0),
    );
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("(a) does not refocus the editor when an external <input> is active", () => {
    const { editor, focus } = makeEditor();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    refocusEditorAfterMenuClose(editor);
    vi.runAllTimers();

    expect(focus).not.toHaveBeenCalled();
  });

  it("(b) refocuses the editor when a non-focusable element (body) is active", () => {
    const { editor, focus } = makeEditor();
    // Ensure focus rests on body: nothing is focused / an <input> was blurred.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    refocusEditorAfterMenuClose(editor);
    vi.runAllTimers();

    expect(focus).toHaveBeenCalledTimes(1);
  });
});
